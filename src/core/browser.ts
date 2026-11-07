import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { isAllowedUrl, type Project } from './config.js';
import { resolveLocator, stabilityOf } from './locators.js';
import type { LocatorSpec, PageElement, Stability } from './types.js';
import { camel } from './store.js';

export async function launchBrowser(headed = false): Promise<Browser> {
  try {
    return await chromium.launch({ headless: !headed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|browserType\.launch/i.test(msg)) {
      throw new Error('Playwright Chromium is not installed. Run: npx playwright install chromium');
    }
    throw err;
  }
}

/** A browser context that refuses to navigate to hosts outside safety.allowedHosts. */
export async function guardedContext(
  browser: Browser,
  project: Project,
  onBlocked?: (url: string) => void,
): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: project.config.baseUrl });
  await context.route('**/*', (route) => {
    const req = route.request();
    if (req.isNavigationRequest() && !isAllowedUrl(project, req.url())) {
      onBlocked?.(req.url());
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  return context;
}

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
}

/** Signs in through the UI using the auth settings and the credentials named in .env. */
export async function signIn(page: Page, project: Project): Promise<void> {
  const auth = project.config.auth;
  if (!auth) throw new Error('No "auth" section in traceqa.config.json, so TraceQA cannot sign in.');
  const user = project.env[auth.usernameEnv];
  const pass = project.env[auth.passwordEnv];
  if (!user || !pass) throw new Error(`Set ${auth.usernameEnv} and ${auth.passwordEnv} in the project's .env file.`);
  await page.goto(auth.loginPath);
  await page.getByLabel(auth.usernameLabel, { exact: true }).fill(user);
  await page.getByLabel(auth.passwordLabel, { exact: true }).fill(pass);
  await page.getByRole('button', { name: auth.submitButton, exact: true }).click();
  await settle(page);
}

// ---------- reading a page ----------

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'spinbutton', 'slider', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
]);
const LANDMARK_TEXT = new Set(['heading', 'alert', 'status']);

export interface AriaNode {
  role: string;
  name: string;
  level?: number;
}

/** Parses the YAML-like output of locator.ariaSnapshot() into role/name pairs. */
export function parseAriaSnapshot(snapshot: string): AriaNode[] {
  const out: AriaNode[] = [];
  for (const line of snapshot.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+\[([^\]]*)\])?/);
    if (!m) continue;
    const role = m[1];
    if (role === 'text' || (role === 'img' && !m[2])) continue;
    const name = m[2] ? m[2].replace(/\\(.)/g, '$1') : '';
    const level = m[3] ? /level=(\d+)/.exec(m[3])?.[1] : undefined;
    out.push({ role, name, level: level ? Number(level) : undefined });
  }
  return out;
}

const KEY_SUFFIX: Record<string, string> = {
  button: 'Button', link: 'Link', textbox: 'Input', searchbox: 'Input', spinbutton: 'Input', combobox: 'Select',
  listbox: 'List', checkbox: 'Checkbox', radio: 'Radio', switch: 'Switch', slider: 'Slider', tab: 'Tab',
  heading: 'Heading', alert: 'Alert', status: 'Status', option: 'Option', text: 'Text',
};

export function elementKey(role: string, label: string, taken: Set<string>): string {
  const words = label.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 4).join(' ');
  // Nameless elements (an alert, a status line) are simply called by their role.
  let base = label.toLowerCase() === role ? camel(role) : camel(words) + (KEY_SUFFIX[role] ?? 'Element');
  if (!/^[A-Za-z]/.test(base)) base = 'el' + base[0].toUpperCase() + base.slice(1);
  base = base[0].toLowerCase() + base.slice(1);
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}${i}`;
  taken.add(key);
  return key;
}

async function countOf(page: Page, spec: LocatorSpec): Promise<number> {
  return resolveLocator(page, spec).count().catch(() => 0);
}

/** For an element that has no unique role+name, try test id, label, placeholder, then id. */
async function fallbackSpec(page: Page, spec: LocatorSpec, index: number): Promise<LocatorSpec | undefined> {
  const info = await resolveLocator(page, spec)
    .nth(index)
    .evaluate((el) => {
      const input = el as HTMLInputElement;
      return {
        testId: el.getAttribute('data-testid'),
        id: el.id || null,
        placeholder: el.getAttribute('placeholder'),
        label: input.labels && input.labels.length ? (input.labels[0].textContent ?? '').trim() : null,
      };
    }, undefined, { timeout: 2000 })
    .catch(() => null);
  if (!info) return undefined;
  const candidates: LocatorSpec[] = [];
  if (info.testId) candidates.push({ by: 'testId', testId: info.testId });
  if (info.label) candidates.push({ by: 'label', label: info.label, exact: true });
  if (info.placeholder) candidates.push({ by: 'placeholder', placeholder: info.placeholder });
  if (info.id && /^[A-Za-z][\w-]*$/.test(info.id)) candidates.push({ by: 'css', selector: `#${info.id}` });
  for (const c of candidates) if ((await countOf(page, c)) === 1) return c;
  return undefined;
}

/** Lists the elements a test can use on the current page, each with the most stable unique locator found. */
export async function captureElements(page: Page, limit = 80): Promise<PageElement[]> {
  const snapshot = await page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => '');
  const nodes = parseAriaSnapshot(snapshot).filter((n) => INTERACTIVE.has(n.role) || (LANDMARK_TEXT.has(n.role)));
  const seen = new Map<string, number>();
  const elements: PageElement[] = [];
  const keys = new Set<string>();

  for (const node of nodes.slice(0, limit)) {
    const occurrence = seen.get(`${node.role}|${node.name}`) ?? 0;
    seen.set(`${node.role}|${node.name}`, occurrence + 1);
    const roleSpec: LocatorSpec = node.name
      ? { by: 'role', role: node.role, name: node.name, exact: true }
      : { by: 'role', role: node.role };
    const count = await countOf(page, roleSpec);
    let spec: LocatorSpec | undefined;
    let stability: Stability = 'stable';
    if (count === 1) spec = roleSpec;
    else if (count > 1) {
      spec = await fallbackSpec(page, roleSpec, occurrence);
      if (!spec) {
        if (occurrence > 0) continue; // keep one entry for a repeated, non-unique element
        spec = roleSpec;
        stability = 'ambiguous';
      }
    }
    if (!spec) continue;
    if (elements.some((e) => JSON.stringify(e.locator) === JSON.stringify(spec))) continue;
    if (stability !== 'ambiguous') stability = stabilityOf(spec);
    const label = node.name || (spec.by === 'label' ? spec.label : spec.by === 'testId' ? spec.testId : node.role);
    elements.push({ key: elementKey(node.role, label, keys), role: node.role, name: node.name, locator: spec, stability });
  }

  // Elements tagged with data-testid (totals, prices, messages) are useful for assertions.
  const testIds = await page
    .locator('[data-testid]')
    .evaluateAll((els) =>
      els.slice(0, 40).map((el) => ({ testId: el.getAttribute('data-testid') ?? '', text: (el.textContent ?? '').trim().slice(0, 40) })),
    )
    .catch(() => [] as { testId: string; text: string }[]);
  for (const t of testIds) {
    if (!t.testId || elements.some((e) => e.locator.by === 'testId' && e.locator.testId === t.testId)) continue;
    elements.push({
      key: elementKey('text', t.testId, keys),
      role: 'text',
      name: t.text,
      locator: { by: 'testId', testId: t.testId },
      stability: 'stable',
    });
  }
  return elements;
}

export interface PageFacts {
  url: string;
  title: string;
  headings: string[];
  links: { href: string; text: string }[];
  forms: number;
  textSample: string;
  elements: PageElement[];
}

export async function readPage(page: Page): Promise<PageFacts> {
  const facts = await page.evaluate(() => ({
    links: Array.from(document.querySelectorAll('a[href]')).map((a) => ({
      href: (a as HTMLAnchorElement).href,
      text: (a.textContent ?? '').replace(/\s+/g, ' ').trim(),
    })),
    forms: document.querySelectorAll('form').length,
    headings: Array.from(document.querySelectorAll('h1, h2, h3')).map((h) => (h.textContent ?? '').trim()).filter(Boolean),
    text: (document.body?.innerText ?? '').replace(/\s+\n/g, '\n').slice(0, 1500),
  }));
  return {
    url: page.url(),
    title: await page.title(),
    headings: facts.headings.slice(0, 12),
    links: facts.links.slice(0, 100),
    forms: facts.forms,
    textSample: facts.text,
    elements: await captureElements(page),
  };
}
