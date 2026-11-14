import fs from 'node:fs';
import path from 'node:path';
import type { Project } from './config.js';
import { runProcess } from './proc.js';
import { hasInstalledDeps } from './scaffold.js';
import { describeStep, loadTests, recordVerification, testTitle } from './testgen.js';
import { loadRequirements, REQ_ID } from './requirements.js';
import { draftBug } from './bugs.js';
import { listJson, nextId, now, writeJson } from './store.js';
import type { RunRecord, TestDef, TestResult, Verdict } from './types.js';

const ANSI = /\u001b\[[0-9;]*m/g;

export interface RunOptions {
  requirementId?: string;
  testId?: string;
  grep?: string;
  browser?: string;
  retries?: number;
  draftBugs?: boolean;
  /** false = quick check that is not saved as a run (used when verifying a newly saved test). */
  record?: boolean;
  /** Stops the run (kills Playwright and its browsers). */
  signal?: AbortSignal;
  /** Receives Playwright's output line by line while it runs. */
  log?: (line: string) => void;
}

function runPlaywright(project: Project, args: string[], signal?: AbortSignal, log?: (line: string) => void): Promise<{ code: number; output: string }> {
  const cli = path.join(project.paths.e2e, 'node_modules', '@playwright', 'test', 'cli.js');
  return runProcess(process.execPath, [cli, 'test', ...args], {
    cwd: project.paths.e2e,
    env: { ...process.env, ...project.env, BASE_URL: project.config.baseUrl, FORCE_COLOR: '0', CI: process.env.CI ?? '' },
    signal,
    onLine: log,
  });
}

/** Drops colour codes, source-code frames ("> 19 |   await …") and stack lines, which would mislead the classifier. */
export function cleanError(message: string): string {
  const seen = new Set<string>();
  return message
    .replace(ANSI, '')
    .split('\n')
    .filter((l) => !/^\s*>?\s*\d+\s*\|/.test(l) && !/^\s*\|\s*\^/.test(l) && !/^\s+at\s/.test(l))
    .filter((l) => {
      const key = l.trim();
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join('\n');
}

/** Sorts a failure: real app problem, broken test, or environment. Heuristic; the AI or a person can overrule it. */
export function classify(message: string): Verdict {
  const m = cleanError(message);
  if (/net::ERR_|ECONNREFUSED|ERR_CONNECTION|ENOTFOUND|Target page, context or browser has been closed/i.test(m)) return 'environment';
  if (/strict mode violation/i.test(m)) return 'test-broken';
  if (/expect\(.*\)\.(to|not)/.test(m) || /Expected( string| substring| pattern|:)/.test(m)) return 'app-bug';
  if (/locator\.\w+: (Timeout|Error)|waiting for (getBy|locator)/i.test(m)) return 'test-broken';
  return 'unknown';
}

function firstLines(msg: string, n = 6): string {
  return msg.replace(ANSI, '').split('\n').filter((l) => l.trim()).slice(0, n).join('\n');
}

function pick(msg: string, label: string): string | undefined {
  const m = msg.replace(ANSI, '').match(new RegExp(`${label}[^:]*:\\s*(.+)`));
  return m?.[1].trim();
}

interface JsonSuite {
  title: string;
  file?: string;
  specs?: { title: string; file: string; line: number; tests: { projectName: string; status: string; results: { status: string; duration: number; error?: { message?: string }; errors?: { message?: string }[]; attachments?: { name: string; path?: string }[] }[] }[] }[];
  suites?: JsonSuite[];
}

function collect(suite: JsonSuite, out: TestResult[], defs: TestDef[]): void {
  for (const spec of suite.specs ?? []) {
    const req = spec.title.match(new RegExp(`@(${REQ_ID})`))?.[1];
    const ac = spec.title.match(/^(AC\d+)\b/)?.[1];
    const def = defs.find((d) => testTitle(d) === spec.title);
    for (const t of spec.tests) {
      const last = t.results[t.results.length - 1];
      const status: TestResult['status'] =
        t.status === 'expected' ? 'passed' : t.status === 'flaky' ? 'flaky' : t.status === 'skipped' ? 'skipped' : 'failed';
      // A test timeout reports "Test timeout exceeded" first; the action that was waiting is in the other errors.
      const message = cleanError([last?.error?.message, ...(last?.errors ?? []).map((e) => e.message)].filter((m): m is string => !!m).join('\n'));
      out.push({
        title: spec.title,
        file: spec.file,
        line: spec.line,
        project: t.projectName,
        requirementId: req ?? def?.requirementId,
        acId: ac ?? def?.acId,
        testDefId: def?.id,
        status,
        durationMs: t.results.reduce((s, r) => s + (r.duration ?? 0), 0),
        error: status === 'failed' ? firstLines(message, 12) : undefined,
        verdict: status === 'failed' ? classify(message) : status === 'flaky' ? 'flaky' : undefined,
        attachments: (last?.attachments ?? []).filter((a) => a.path).map((a) => ({ name: a.name, path: a.path! })),
      });
    }
  }
  for (const s of suite.suites ?? []) collect(s, out, defs);
}

/** Playwright clears its output folder on every run, so copy a bug's attachments somewhere stable. */
function keepEvidence(project: Project, runId: string, attachments: TestResult['attachments']): { name: string; path: string }[] {
  const dir = path.join(project.paths.state, 'evidence', runId);
  return attachments.flatMap((a) => {
    if (!fs.existsSync(a.path)) return [];
    const parent = path.basename(path.dirname(a.path)).replace(/[^A-Za-z0-9._-]+/g, '-').slice(-60);
    const target = path.join(dir, parent, path.basename(a.path));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(a.path, target);
    return [{ name: a.name, path: target }];
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function listRuns(project: Project): RunRecord[] {
  return listJson<RunRecord>(project.paths.runs);
}

export function latestRun(project: Project): RunRecord | undefined {
  const runs = listRuns(project);
  return runs[runs.length - 1];
}

/** Runs the generated Playwright tests, records results per requirement, and drafts bugs for likely app bugs. */
export async function runTests(project: Project, opts: RunOptions = {}): Promise<RunRecord & { output: string }> {
  if (!fs.existsSync(path.join(project.paths.e2e, 'playwright.config.ts'))) {
    throw new Error('No Playwright framework yet. Run scaffold_framework first.');
  }
  if (!hasInstalledDeps(project)) {
    throw new Error(`Playwright is not installed in ${project.paths.e2e}. Run "npm install" there, or scaffold_framework with install.`);
  }
  const defs = loadTests(project);
  const args: string[] = [];
  let filter: string | undefined;
  if (opts.testId) {
    const def = defs.find((d) => d.id === opts.testId);
    if (!def) throw new Error(`No test ${opts.testId}.`);
    filter = escapeRegex(testTitle(def));
  } else if (opts.requirementId) filter = `@${escapeRegex(opts.requirementId.toUpperCase())}\\b`;
  else if (opts.grep) filter = opts.grep;
  if (filter) args.push('--grep', filter);
  if (opts.browser) args.push('--project', opts.browser);
  if (opts.retries !== undefined) args.push('--retries', String(opts.retries));

  const resultsFile = path.join(project.paths.e2e, 'results', 'results.json');
  fs.rmSync(resultsFile, { force: true });
  const started = Date.now();
  const startedAt = now();
  const { output } = await runPlaywright(project, args, opts.signal, opts.log);
  if (!fs.existsSync(resultsFile)) {
    throw new Error(`Playwright did not produce results. Output:\n${firstLines(output, 20)}`);
  }
  const json = JSON.parse(fs.readFileSync(resultsFile, 'utf8')) as { suites: JsonSuite[]; errors?: { message?: string }[] };
  const results: TestResult[] = [];
  for (const s of json.suites ?? []) collect(s, results, defs);
  if (!results.length && json.errors?.length) {
    throw new Error(`Playwright could not run the tests:\n${firstLines(json.errors[0].message ?? '', 12)}`);
  }

  const totals = { total: results.length, passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const r of results) totals[r.status]++;

  const run: RunRecord = {
    id: nextId('RUN', listRuns(project).map((r) => r.id), 3),
    startedAt,
    finishedAt: now(),
    durationMs: Date.now() - started,
    filter,
    totals,
    results,
    bugs: [],
  };

  // Remember the latest outcome on each test definition.
  for (const r of results) if (r.testDefId && (r.status === 'passed' || r.status === 'failed')) recordVerification(project, r.testDefId, r.status, r.error);

  if (opts.draftBugs !== false) {
    const reqs = loadRequirements(project);
    const seen = new Set<string>();
    for (const r of results.filter((x) => x.status === 'failed' && x.verdict === 'app-bug')) {
      const key = r.testDefId ?? r.title;
      if (seen.has(key)) continue;
      seen.add(key);
      const def = defs.find((d) => d.id === r.testDefId);
      const req = reqs.find((x) => x.id === r.requirementId);
      const ac = req?.criteria.find((c) => c.id === r.acId);
      const msg = r.error ?? '';
      const { bug } = draftBug(project, {
        severity: 'medium',
        title: `${r.requirementId ?? 'Test'}${r.acId ? ` ${r.acId}` : ''} fails: ${def?.title ?? r.title.replace(/\s*@REQ-\S+/, '')}`,
        requirementId: r.requirementId,
        acId: r.acId,
        source: { kind: 'run', ref: key },
        environment: `${project.config.baseUrl} · ${r.project}`,
        steps: def ? [...(def.signedIn ? ['Sign in with the test account'] : []), ...def.steps.filter((s) => !s.action.startsWith('expect') && s.action !== 'note').map(describeStep)] : [`Run the test "${r.title}" (${r.file}:${r.line})`],
        expected: [ac ? `${ac.id}: ${ac.text}` : undefined, pick(msg, 'Expected')].filter(Boolean).join('\n') || 'See the test assertion.',
        actual: pick(msg, 'Received') ? `Received: ${pick(msg, 'Received')}` : firstLines(msg, 3),
        evidence: keepEvidence(project, run.id, r.attachments),
      });
      run.bugs.push(bug.id);
    }
  }

  if (opts.record !== false) writeJson(path.join(project.paths.runs, `${run.id}.json`), run);
  else run.id = 'CHECK';
  return { ...run, output };
}

export function formatRun(run: RunRecord): string {
  const t = run.totals;
  const lines = [
    `${run.id}: ${t.passed} passed · ${t.failed} failed · ${t.flaky} flaky · ${t.skipped} skipped (${(run.durationMs / 1000).toFixed(1)} s)`,
  ];
  for (const r of run.results.filter((x) => x.status !== 'passed')) {
    lines.push(`- [${r.status}${r.verdict ? ` · ${r.verdict}` : ''}] ${r.title} (${r.project})`);
    if (r.error) lines.push(`    ${r.error.split('\n').slice(0, 4).join('\n    ')}`);
  }
  if (run.bugs.length) lines.push(`Draft bugs: ${run.bugs.join(', ')} (review with list_bugs / get_bug)`);
  return lines.join('\n');
}
