import path from 'node:path';
import type { Page } from 'playwright';
import type { Project } from './config.js';
import { captureElements, guardedContext, launchBrowser, readPage, settle, signIn } from './browser.js';
import { loadAppMap, saveAppMap, upsertPage } from './appMap.js';
import { describeLocator, locatorCode, resolveLocator, sameLocator } from './locators.js';
import { loadTests, saveTest } from './testgen.js';
import { latestResults } from './coverage.js';
import { runTests } from './runner.js';
import { hasInstalledDeps } from './scaffold.js';
import { StoppedError, throwIfStopped } from './proc.js';
import { listJson, nextId, now, writeJson } from './store.js';
import type { LocatorSpec, PageElement, Step, TestDef } from './types.js';

export interface HealFix {
  stepIndex: number;
  action: string;
  oldLocator: LocatorSpec;
  newLocator: LocatorSpec;
  oldCode: string;
  newCode: string;
  confidence: number;
}

export interface HealRecord {
  id: string;
  testId: string;
  requirementId: string;
  /** proposed = preview only, waiting for a person to apply or reject it. */
  status: 'applied' | 'proposed' | 'failed' | 'rejected';
  fixes: HealFix[];
  /** Outcome of re-running the healed test once. */
  check?: { status: 'passed' | 'failed'; verdict?: string; error?: string };
  reason?: string;
  createdAt: string;
  reviewedAt?: string;
}

const ACTION_STEPS = new Set(['click', 'fill', 'select', 'check', 'uncheck', 'hover', 'press']);
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider']);
const ROLE_FAMILIES: string[][] = [
  ['button', 'link', 'menuitem', 'tab'],
  ['textbox', 'searchbox', 'spinbutton', 'combobox'],
  ['checkbox', 'switch', 'radio'],
];

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
}

/** How alike two visible names are: exact, one contains the other, shared words, or small typos. */
export function nameSimilarity(a: string, b: string): number {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return 0;
  if (x === y) return 1;
  const wx = words(x);
  const wy = words(y);
  const shared = wx.filter((w) => wy.includes(w)).length;
  const jaccard = shared / new Set([...wx, ...wy]).size;
  const contains = x.includes(y) || y.includes(x) ? 0.75 + 0.2 * (Math.min(x.length, y.length) / Math.max(x.length, y.length)) : 0;
  return Math.max(jaccard, contains, levenshteinRatio(x, y) * 0.9);
}

function roleFactor(oldRole: string | undefined, newRole: string): number {
  if (!oldRole) return 0.85;
  if (oldRole === newRole) return 1;
  if (ROLE_FAMILIES.some((f) => f.includes(oldRole) && f.includes(newRole))) return 0.8;
  return 0.35;
}

/** Scores how likely a current page element is the one an old (now broken) locator meant. */
export function healScore(old: LocatorSpec, el: PageElement): number {
  if (el.stability === 'ambiguous') return 0;
  switch (old.by) {
    case 'role':
      return old.name ? nameSimilarity(old.name, el.name) * roleFactor(old.role, el.role) : 0;
    case 'label':
      return FIELD_ROLES.has(el.role) ? nameSimilarity(old.label, el.name) : 0;
    case 'placeholder':
      return FIELD_ROLES.has(el.role) ? nameSimilarity(old.placeholder, el.name) * 0.9 : 0;
    case 'testId':
      return el.locator.by === 'testId' ? nameSimilarity(old.testId.replace(/[-_]/g, ' '), el.locator.testId.replace(/[-_]/g, ' ')) : 0;
    case 'text':
      return nameSimilarity(old.text, el.name) * 0.9;
    case 'css':
      return 0;
  }
}

/** Picks a replacement when one candidate is clearly the best and good enough. */
export function pickReplacement(old: LocatorSpec, elements: PageElement[]): { element: PageElement; score: number } | undefined {
  const scored = elements
    .map((element) => ({ element, score: healScore(old, element) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score < 0.6) return undefined;
  if (second && best.score - second.score < 0.1) return undefined;
  return best;
}

function withValue(step: Step, project: Project): string {
  const v = 'value' in step ? step.value : '';
  const m = v.match(/^\$\{?([A-Z][A-Z0-9_]*)\}?$/);
  return m ? project.env[m[1]] ?? '' : v;
}

async function perform(page: Page, step: Step, spec: LocatorSpec | undefined, project: Project): Promise<void> {
  const timeout = 5000;
  switch (step.action) {
    case 'goto':
      await page.goto(step.path, { waitUntil: 'domcontentloaded', timeout: 20000 });
      break;
    case 'click':
    case 'check':
    case 'uncheck':
    case 'hover':
      await resolveLocator(page, spec!)[step.action]({ timeout });
      break;
    case 'fill':
      await resolveLocator(page, spec!).fill(withValue(step, project), { timeout });
      break;
    case 'select':
      await resolveLocator(page, spec!).selectOption(withValue(step, project), { timeout });
      break;
    case 'press':
      if (spec) await resolveLocator(page, spec).press(step.key, { timeout });
      else await page.keyboard.press(step.key);
      break;
    default:
      return; // expectations are not replayed: healing never touches what a test checks
  }
  await settle(page);
}

/** Replays a test in a browser and swaps broken action locators for their closest match on the live page. */
async function replayAndHeal(project: Project, def: TestDef): Promise<{ fixes: HealFix[]; steps: Step[]; reason?: string }> {
  const browser = await launchBrowser(false);
  const fixes: HealFix[] = [];
  const steps: Step[] = JSON.parse(JSON.stringify(def.steps));
  try {
    const context = await guardedContext(browser, project);
    const page = await context.newPage();
    if (def.signedIn) await signIn(page, project);
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const spec = 'target' in step ? step.target : undefined;
      try {
        await perform(page, step, spec, project);
        continue;
      } catch (err) {
        if (!ACTION_STEPS.has(step.action) || !spec) {
          return { fixes, steps, reason: `Step ${i + 1} (${step.action}) failed and cannot be healed: ${(err as Error).message.split('\n')[0]}` };
        }
      }
      const elements = await captureElements(page);
      const pick = pickReplacement(spec!, elements);
      if (!pick) {
        return { fixes, steps, reason: `No clear replacement for ${describeLocator(spec!)} on ${new URL(page.url()).pathname}.` };
      }
      const replaced = { ...step, target: pick.element.locator } as Step;
      try {
        await perform(page, replaced, pick.element.locator, project);
      } catch (err) {
        return { fixes, steps, reason: `Replacement ${locatorCode(pick.element.locator)} also failed: ${(err as Error).message.split('\n')[0]}` };
      }
      steps[i] = replaced;
      fixes.push({
        stepIndex: i,
        action: step.action,
        oldLocator: spec!,
        newLocator: pick.element.locator,
        oldCode: locatorCode(spec!),
        newCode: locatorCode(pick.element.locator),
        confidence: Math.round(pick.score * 100) / 100,
      });
      // Refresh the app map so page objects pick up the new element.
      const facts = await readPage(page).catch(() => undefined);
      if (facts) {
        const map = loadAppMap(project);
        upsertPage(map, facts, 'explore');
        saveAppMap(project, map);
      }
    }
    return { fixes, steps };
  } finally {
    await browser.close();
  }
}

export function listHeals(project: Project): HealRecord[] {
  return listJson<HealRecord>(path.join(project.paths.state, 'heals'));
}

function saveHeal(project: Project, record: HealRecord): void {
  writeJson(path.join(project.paths.state, 'heals', `${record.id}.json`), record);
}

/** Saves the healed steps, re-runs the test once, and puts the original back if the heal did not help. */
async function applyAndCheck(project: Project, def: TestDef, steps: Step[], record: HealRecord, signal?: AbortSignal): Promise<void> {
  saveTest(project, { requirementId: def.requirementId, acId: def.acId, title: def.title, signedIn: def.signedIn, steps });
  record.status = 'applied';
  let check: Awaited<ReturnType<typeof runTests>>;
  try {
    check = await runTests(project, { testId: def.id, retries: 0, draftBugs: false, record: false, signal });
  } catch (err) {
    if (err instanceof StoppedError) {
      // Stopped half-way: leave the test as it was.
      saveTest(project, { requirementId: def.requirementId, acId: def.acId, title: def.title, signedIn: def.signedIn, steps: def.steps });
      record.status = 'failed';
      record.reason = 'Stopped before the healed test was re-run; the original was kept.';
      saveHeal(project, record);
    }
    throw err;
  }
  const r = check.results[0];
  record.check = r ? { status: r.status === 'passed' ? 'passed' : 'failed', verdict: r.verdict, error: r.error?.split('\n').slice(0, 4).join('\n') } : undefined;
  if (r && r.status !== 'passed' && r.verdict === 'test-broken') {
    // The heal did not help: put the original test back.
    saveTest(project, { requirementId: def.requirementId, acId: def.acId, title: def.title, signedIn: def.signedIn, steps: def.steps });
    record.status = 'failed';
    record.reason = 'The healed test still could not use the page; the original was restored.';
  }
}

/**
 * Applies or rejects a proposed heal (one made with dryRun / "preview only").
 * Applying swaps the proposed locators into the test, re-runs it, and restores the original if that does not help.
 */
export async function reviewHeal(
  project: Project,
  healId: string,
  decision: 'apply' | 'reject',
  opts: { signal?: AbortSignal } = {},
): Promise<HealRecord> {
  const record = listHeals(project).find((h) => h.id === healId.toUpperCase());
  if (!record) throw new Error(`No heal ${healId}.`);
  if (record.status !== 'proposed') throw new Error(`${record.id} is ${record.status}; only proposed heals can be applied or rejected.`);
  record.reviewedAt = now();
  if (decision === 'reject') {
    record.status = 'rejected';
    saveHeal(project, record);
    return record;
  }
  const def = loadTests(project).find((d) => d.id === record.testId);
  if (!def) throw new Error(`Test ${record.testId} no longer exists.`);
  const steps: Step[] = JSON.parse(JSON.stringify(def.steps));
  for (const fix of record.fixes) {
    const step = steps[fix.stepIndex];
    if (!step || step.action !== fix.action || !('target' in step) || !step.target || !sameLocator(step.target, fix.oldLocator)) {
      throw new Error(`${record.testId} changed since ${record.id} was proposed. Preview the heal again.`);
    }
    (step as { target: LocatorSpec }).target = fix.newLocator;
  }
  if (!hasInstalledDeps(project)) {
    saveTest(project, { requirementId: def.requirementId, acId: def.acId, title: def.title, signedIn: def.signedIn, steps });
    record.status = 'applied';
    record.reason = 'Applied without a re-run: the framework is not installed yet.';
  } else {
    await applyAndCheck(project, def, steps, record, opts.signal);
  }
  saveHeal(project, record);
  return record;
}

/**
 * Heals tests whose latest result is "test-broken" (an action could not find its element).
 * Only action steps are changed; assertions are never touched, so a heal cannot hide an app bug.
 */
export async function healTests(
  project: Project,
  opts: { testIds?: string[]; apply?: boolean; log?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<{ records: HealRecord[]; candidates: number }> {
  const log = opts.log ?? (() => {});
  const apply = opts.apply !== false;
  const defs = loadTests(project);
  const broken = new Set(
    opts.testIds?.length
      ? opts.testIds
      : latestResults(project)
          .filter((r) => r.status === 'failed' && r.verdict === 'test-broken' && r.testDefId)
          .map((r) => r.testDefId!),
  );
  const records: HealRecord[] = [];
  for (const testId of broken) {
    throwIfStopped(opts.signal);
    const def = defs.find((d) => d.id === testId);
    if (!def) continue;
    log(`Healing ${testId} …`);
    const { fixes, steps, reason } = await replayAndHeal(project, def);
    throwIfStopped(opts.signal);
    const record: HealRecord = {
      id: nextId('HEAL', [...listHeals(project), ...records].map((r) => r.id), 3),
      testId,
      requirementId: def.requirementId,
      status: fixes.length && !reason ? (apply ? 'applied' : 'proposed') : 'failed',
      fixes,
      reason: reason ?? (fixes.length ? undefined : 'Every step worked on replay; the failure may be timing or data related.'),
      createdAt: now(),
    };
    if (record.status === 'applied') await applyAndCheck(project, def, steps, record, opts.signal);
    saveHeal(project, record);
    records.push(record);
    log(`  ${record.status}${record.fixes.length ? `: ${record.fixes.map((f) => `${f.oldCode} → ${f.newCode}`).join('; ')}` : ''}${record.reason ? ` (${record.reason})` : ''}`);
  }
  return { records, candidates: broken.size };
}

export function formatHeals(result: { records: HealRecord[]; candidates: number }): string {
  if (!result.candidates) return 'No broken tests to heal (no "test-broken" failures in the latest results).';
  const lines = [`Healing ${result.candidates} broken test(s):`];
  for (const r of result.records) {
    lines.push(`- ${r.id} ${r.testId}: ${r.status}`);
    for (const f of r.fixes) lines.push(`    step ${f.stepIndex + 1} ${f.action}: ${f.oldCode} → ${f.newCode} (confidence ${f.confidence})`);
    if (r.check) lines.push(`    re-run: ${r.check.status}${r.check.verdict ? ` · ${r.check.verdict}` : ''}${r.check.status === 'failed' && r.check.verdict === 'app-bug' ? ' (the locator is fixed; the assertion now fails, which looks like a real app bug)' : ''}`);
    if (r.reason) lines.push(`    ${r.reason}`);
  }
  if (result.records.some((r) => r.status === 'applied')) lines.push('Healed tests are rewritten in e2e/tests. Review the diff before committing.');
  return lines.join('\n');
}
