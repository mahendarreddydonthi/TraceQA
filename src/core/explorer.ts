import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { isAllowedUrl, type Project } from './config.js';
import { guardedContext, launchBrowser, readPage, settle, signIn } from './browser.js';
import { loadAppMap, saveAppMap, upsertPage } from './appMap.js';
import { describeLocator, locatorCode, resolveLocator } from './locators.js';
import { draftBug } from './bugs.js';
import { loadRequirements } from './requirements.js';
import { nextId, now, rel, writeJson, writeText } from './store.js';
import type { Bug, LocatorSpec } from './types.js';

export type ExploreAction =
  | 'goto' | 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'press' | 'hover' | 'back' | 'wait' | 'sign_in';

export interface ActInput {
  action: ExploreAction;
  ref?: string;
  locator?: LocatorSpec;
  value?: string;
  path?: string;
  key?: string;
  ms?: number;
}

export interface ExploreStep {
  n: number;
  action: ExploreAction;
  detail: string;
  reproduce: string;
  url: string;
  ok: boolean;
  error?: string;
  screenshot?: string;
  at: string;
}

export interface Finding {
  n: number;
  title: string;
  severity: Bug['severity'];
  category: string;
  requirementId?: string;
  acId?: string;
  expected: string;
  actual: string;
  bugId: string;
  screenshot: string;
  afterStep: number;
}

const ENV_VALUE = /^\$\{?([A-Z][A-Z0-9_]*)\}?$/;

export class ExploreSession {
  static active: ExploreSession | undefined;
  /** Lets the dashboard show a session live while it runs. */
  static onEvent: ((type: 'start' | 'step' | 'finding' | 'end', session: ExploreSession) => void) | undefined;

  readonly id: string;
  readonly dir: string;
  readonly startedAt = Date.now();
  steps: ExploreStep[] = [];
  findings: Finding[] = [];
  pages = new Set<string>();
  consoleErrors: string[] = [];
  failedRequests: string[] = [];
  blocked: string[] = [];
  private seenConsole = 0;
  private seenFailed = 0;
  private refs = new Map<string, LocatorSpec>();

  private constructor(
    readonly project: Project,
    readonly charter: string,
    readonly requirementId: string | undefined,
    private browser: Browser,
    private context: BrowserContext,
    readonly page: Page,
    id: string,
  ) {
    this.id = id;
    this.dir = path.join(project.paths.sessions, id);
  }

  static async start(
    project: Project,
    opts: { charter: string; requirementId?: string; startPath?: string; headed?: boolean; signIn?: boolean },
  ): Promise<ExploreSession> {
    if (ExploreSession.active) throw new Error(`Session ${ExploreSession.active.id} is still open. Call explore_end first.`);
    if (opts.requirementId && !loadRequirements(project).some((r) => r.id === opts.requirementId!.toUpperCase())) {
      throw new Error(`Unknown requirement ${opts.requirementId}. Run import_requirements first.`);
    }
    const existing = fs.existsSync(project.paths.sessions) ? fs.readdirSync(project.paths.sessions) : [];
    const id = nextId('S', existing, 3);
    const browser = await launchBrowser(!!opts.headed);
    const blocked: string[] = [];
    const context = await guardedContext(browser, project, (u) => blocked.push(u));
    const page = await context.newPage();
    const session = new ExploreSession(project, opts.charter, opts.requirementId?.toUpperCase(), browser, context, page, id);
    session.blocked = blocked;
    fs.mkdirSync(session.dir, { recursive: true });

    page.on('console', (msg) => {
      if (msg.type() === 'error') session.consoleErrors.push(msg.text().slice(0, 300));
    });
    page.on('pageerror', (err) => session.consoleErrors.push(`Uncaught: ${err.message.slice(0, 300)}`));
    page.on('response', (res) => {
      if (res.status() >= 400) session.failedRequests.push(`${res.request().method()} ${new URL(res.url()).pathname} → ${res.status()}`);
    });
    page.on('requestfailed', (req) => {
      const reason = req.failure()?.errorText ?? 'failed';
      if (!/BLOCKED_BY_CLIENT/i.test(reason)) session.failedRequests.push(`${req.method()} ${req.url()} failed: ${reason}`);
    });

    ExploreSession.active = session;
    ExploreSession.onEvent?.('start', session);
    try {
      if (opts.signIn) await session.act({ action: 'sign_in' });
      await session.act({ action: 'goto', path: opts.startPath ?? '/' });
    } catch (err) {
      await session.end().catch(() => {});
      throw err;
    }
    return session;
  }

  private elapsedMinutes(): number {
    return (Date.now() - this.startedAt) / 60000;
  }

  private checkBudget(): void {
    const s = this.project.config.safety;
    if (this.elapsedMinutes() > s.maxMinutesPerSession) {
      throw new Error(`Time budget of ${s.maxMinutesPerSession} min is used up. Record any findings, then call explore_end.`);
    }
    if (this.pages.size > s.maxPagesPerSession) {
      throw new Error(`Page budget of ${s.maxPagesPerSession} pages is used up. Record any findings, then call explore_end.`);
    }
  }

  private target(input: ActInput): { spec: LocatorSpec; locator: Locator } {
    let spec = input.locator;
    if (!spec && input.ref) {
      spec = this.refs.get(input.ref);
      if (!spec) throw new Error(`Unknown ref ${input.ref}. Refs come from the latest snapshot.`);
    }
    if (!spec) throw new Error(`"${input.action}" needs a ref (like e3) or a locator.`);
    return { spec, locator: resolveLocator(this.page, spec) };
  }

  private async guardBlocked(spec: LocatorSpec, locator: Locator): Promise<void> {
    const blocked = this.project.config.safety.blockedActions.map((b) => b.toLowerCase());
    if (!blocked.length) return;
    const text = await locator
      .first()
      .evaluate((el) => `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''} ${(el as HTMLInputElement).value ?? ''}`, undefined, { timeout: 3000 })
      .catch(() => '');
    const label = `${describeLocator(spec)} ${text}`.toLowerCase();
    const hit = blocked.find((b) => label.includes(b));
    if (hit) throw new Error(`Blocked by safety rules: "${hit}" is in safety.blockedActions in traceqa.config.json.`);
  }

  private resolveValue(value: string | undefined): { real: string; shown: string } {
    const v = value ?? '';
    const m = v.match(ENV_VALUE);
    if (m) {
      const real = this.project.env[m[1]];
      if (real === undefined) throw new Error(`${m[1]} is not set in the project's .env file.`);
      return { real, shown: `<${m[1]}>` };
    }
    return { real: v, shown: `"${v}"` };
  }

  /** A readable name for a ref from the latest snapshot, e.g. `button "Add to cart"`, for live progress. */
  refLabel(ref: string): string | undefined {
    const spec = this.refs.get(ref);
    return spec ? describeLocator(spec) : undefined;
  }

  /** Performs one action, records evidence and returns a fresh snapshot. */
  async act(input: ActInput): Promise<string> {
    this.checkBudget();
    const page = this.page;
    const n = this.steps.length + 1;
    let detail = '';
    let reproduce = '';
    let error: string | undefined;
    try {
      switch (input.action) {
        case 'sign_in': {
          detail = 'sign in with the test account';
          reproduce = 'Sign in with the test account';
          await signIn(page, this.project);
          break;
        }
        case 'goto': {
          const target = new URL(input.path ?? '/', this.project.config.baseUrl).toString();
          if (!isAllowedUrl(this.project, target)) throw new Error(`Blocked by safety rules: ${target} is not in safety.allowedHosts.`);
          detail = `goto ${new URL(target).pathname}${new URL(target).search}`;
          reproduce = `Go to ${new URL(target).pathname}${new URL(target).search}`;
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });
          break;
        }
        case 'back':
          detail = 'go back';
          reproduce = 'Go back to the previous page';
          await page.goBack();
          break;
        case 'wait': {
          const ms = Math.min(input.ms ?? 1000, 5000);
          detail = `wait ${ms} ms`;
          reproduce = `Wait ${Math.round(ms / 100) / 10} s`;
          await page.waitForTimeout(ms);
          break;
        }
        case 'press': {
          const key = input.key ?? 'Enter';
          if (input.ref || input.locator) {
            const { spec, locator } = this.target(input);
            await this.guardBlocked(spec, locator);
            detail = `press ${key} in ${describeLocator(spec)}`;
            reproduce = `Press ${key} in the ${describeLocator(spec)}`;
            await locator.press(key, { timeout: 8000 });
          } else {
            detail = `press ${key}`;
            reproduce = `Press ${key}`;
            await page.keyboard.press(key);
          }
          break;
        }
        default: {
          const { spec, locator } = this.target(input);
          const what = describeLocator(spec);
          if (input.action === 'click' || input.action === 'check' || input.action === 'uncheck') await this.guardBlocked(spec, locator);
          if (input.action === 'click') {
            detail = `click ${what}`;
            reproduce = `Select the ${what}`;
            await locator.click({ timeout: 8000 });
          } else if (input.action === 'fill') {
            const { real, shown } = this.resolveValue(input.value);
            const secret = /password|secret|token/i.test(what);
            detail = `fill ${what} with ${secret ? '<hidden>' : shown}`;
            reproduce = `Enter ${secret ? 'the password' : shown} in the ${what}`;
            await locator.fill(real, { timeout: 8000 });
          } else if (input.action === 'select') {
            detail = `select "${input.value}" in ${what}`;
            reproduce = `Choose "${input.value}" in the ${what}`;
            await locator.selectOption(input.value ?? '', { timeout: 8000 });
          } else if (input.action === 'check' || input.action === 'uncheck') {
            detail = `${input.action} ${what}`;
            reproduce = `${input.action === 'check' ? 'Tick' : 'Untick'} the ${what}`;
            await locator[input.action]({ timeout: 8000 });
          } else if (input.action === 'hover') {
            detail = `hover ${what}`;
            reproduce = `Hover over the ${what}`;
            await locator.hover({ timeout: 8000 });
          } else {
            throw new Error(`Unknown action ${String(input.action)}`);
          }
        }
      }
      await settle(page);
    } catch (err) {
      error = (err as Error).message.split('\n')[0];
    }

    const screenshot = path.join(this.dir, `step-${String(n).padStart(2, '0')}.png`);
    await page.screenshot({ path: screenshot }).catch(() => {});
    this.steps.push({ n, action: input.action, detail, reproduce, url: page.url(), ok: !error, error, screenshot, at: now() });
    ExploreSession.onEvent?.('step', this);

    // Keep the shared app map up to date with every page the session reaches.
    if (isAllowedUrl(this.project, page.url()) && /^https?:/.test(page.url())) {
      const pathname = new URL(page.url()).pathname;
      this.pages.add(pathname);
      const facts = await readPage(page).catch(() => undefined);
      if (facts) {
        const map = loadAppMap(this.project);
        map.baseUrl = this.project.config.baseUrl;
        upsertPage(map, facts, 'explore');
        saveAppMap(this.project, map);
      }
    }

    const head = error ? `Step ${n} FAILED: ${detail || input.action}\nError: ${error}` : `Step ${n} ok: ${detail}`;
    return `${head}\n\n${await this.snapshot()}`;
  }

  /** Text view of the current page for the AI: elements with refs and ready-to-use locators. */
  async snapshot(): Promise<string> {
    const page = this.page;
    const facts = await readPage(page).catch(() => undefined);
    const map = loadAppMap(this.project);
    const known = map.pages.find((p) => facts && new URL(facts.url).pathname === p.path) ?? undefined;
    this.refs.clear();
    const lines: string[] = [];
    lines.push(`URL: ${page.url()}${known ? `  (app map page: ${known.id} · ${known.className})` : ''}`);
    if (facts) {
      lines.push(`Title: ${facts.title}`);
      if (facts.headings.length) lines.push(`Headings: ${facts.headings.join(' | ')}`);
      lines.push('Elements (act on them with ref, or pass the locator):');
      facts.elements.forEach((el, i) => {
        const ref = `e${i + 1}`;
        this.refs.set(ref, el.locator);
        const flag = el.stability === 'stable' ? '' : `  [${el.stability}]`;
        lines.push(`  ${ref.padEnd(4)} ${`${el.role} "${el.name}"`.padEnd(40)} ${locatorCode(el.locator)}${flag}`);
      });
      lines.push(`Visible text (start):\n${facts.textSample.slice(0, 700)}`);
    }
    const newConsole = this.consoleErrors.slice(this.seenConsole);
    const newFailed = this.failedRequests.slice(this.seenFailed);
    this.seenConsole = this.consoleErrors.length;
    this.seenFailed = this.failedRequests.length;
    lines.push(`New console errors: ${newConsole.length ? newConsole.join(' ; ') : 'none'}`);
    lines.push(`New failed requests: ${newFailed.length ? newFailed.join(' ; ') : 'none'}`);
    const s = this.project.config.safety;
    lines.push(
      `Budget: ${this.pages.size} of ${s.maxPagesPerSession} pages · ${this.elapsedMinutes().toFixed(1)} of ${s.maxMinutesPerSession} min · session ${this.id}`,
    );
    return lines.join('\n');
  }

  /** Saves a finding with a screenshot and the steps so far, and drafts a bug for review. */
  async recordFinding(input: {
    title: string;
    severity: Bug['severity'];
    expected: string;
    actual: string;
    category?: string;
    requirementId?: string;
    acId?: string;
  }): Promise<{ finding: Finding; bug: Bug }> {
    if (!this.steps.some((s) => s.ok && s.action !== 'sign_in')) throw new Error('Take at least one successful step before recording a finding, so there is evidence.');
    const n = this.findings.length + 1;
    const screenshot = path.join(this.dir, `finding-${n}.png`);
    await this.page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    const logFile = path.join(this.dir, 'steps.json');
    writeJson(logFile, this.steps);
    const reqId = input.requirementId?.toUpperCase() ?? this.requirementId;
    const { bug } = draftBug(this.project, {
      severity: input.severity,
      title: input.title,
      requirementId: reqId,
      acId: input.acId?.toUpperCase(),
      source: { kind: 'explore', ref: this.id },
      environment: `${this.project.config.baseUrl} · Chromium (exploration ${this.id})`,
      steps: this.steps.filter((s) => s.ok).map((s) => s.reproduce),
      expected: input.expected,
      actual: [input.actual, ...(this.failedRequests.length ? [`Failed requests: ${this.failedRequests.slice(-3).join('; ')}`] : [])].join('\n'),
      evidence: [
        { name: 'screenshot', path: screenshot },
        { name: 'steps', path: logFile },
      ],
    });
    const finding: Finding = {
      n,
      title: input.title,
      severity: input.severity,
      category: input.category ?? 'functional',
      requirementId: reqId,
      acId: input.acId?.toUpperCase(),
      expected: input.expected,
      actual: input.actual,
      bugId: bug.id,
      screenshot,
      afterStep: this.steps.length,
    };
    this.findings.push(finding);
    ExploreSession.onEvent?.('finding', this);
    return { finding, bug };
  }

  /** The session as it stands now (the same shape as session.json). */
  summary(endedAt?: string) {
    return {
      id: this.id,
      charter: this.charter,
      requirementId: this.requirementId,
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt,
      pages: [...this.pages],
      steps: this.steps,
      findings: this.findings,
      consoleErrors: this.consoleErrors,
      failedRequests: this.failedRequests,
      blockedNavigation: this.blocked,
    };
  }

  /** Closes the browser and writes session.json and session.md. */
  async end(): Promise<string> {
    await this.browser.close().catch(() => {});
    ExploreSession.active = undefined;
    const summary = this.summary(now());
    writeJson(path.join(this.dir, 'session.json'), summary);
    const md = [
      `# Exploration ${this.id}`,
      '',
      `- **Charter:** ${this.charter}`,
      this.requirementId ? `- **Requirement:** ${this.requirementId}` : null,
      `- **Pages:** ${summary.pages.join(', ') || 'none'}`,
      `- **Steps:** ${this.steps.length} · **Findings:** ${this.findings.length}`,
      '',
      '## Steps',
      ...this.steps.map((s) => `${s.n}. ${s.ok ? '' : '**Failed:** '}${s.detail}${s.error ? ` — ${s.error}` : ''} (${rel(this.dir, s.screenshot ?? '')})`),
      '',
      '## Findings',
      ...(this.findings.length
        ? this.findings.map((f) => `- **${f.title}** (${f.severity}) → draft ${f.bugId}. Expected: ${f.expected}. Actual: ${f.actual}`)
        : ['- none']),
      '',
      `Console errors: ${this.consoleErrors.length} · Failed requests: ${this.failedRequests.length}`,
    ]
      .filter((l) => l !== null)
      .join('\n');
    writeText(path.join(this.dir, 'session.md'), md + '\n');
    ExploreSession.onEvent?.('end', this);
    return [
      `Session ${this.id} ended: ${this.steps.length} steps, ${this.pages.size} pages, ${this.findings.length} findings.`,
      ...this.findings.map((f) => `- ${f.title} (${f.severity}) → draft ${f.bugId}`),
      `Console errors: ${this.consoleErrors.length} · Failed requests: ${this.failedRequests.length}`,
      `Report: ${rel(this.project.dir, path.join(this.dir, 'session.md'))}`,
    ].join('\n');
  }
}
