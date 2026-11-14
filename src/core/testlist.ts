import fs from 'node:fs';
import path from 'node:path';
import type { Project } from './config.js';
import { latestResults } from './coverage.js';
import { loadRequirements, REQ_ID } from './requirements.js';
import { describeStep, loadTests, specFileFor, testTitle } from './testgen.js';
import { rel } from './store.js';
import type { TestResult } from './types.js';

// Every test in the Playwright framework, flat: the ones TraceQA writes (always for a requirement) and any
// tests people wrote by hand in the same folder, linked to a requirement only if their title has its tag
// (e.g. "@REQ-142"), the same rule the runner uses.

export interface TestListItem {
  /** Stable key: the TraceQA test id, or file:line for a hand-written test. */
  key: string;
  /** TraceQA test id (only for tests TraceQA wrote). */
  id?: string;
  source: 'traceqa' | 'hand-written';
  /** The title without @tags. */
  title: string;
  /** The title as Playwright reports it, for --grep. */
  fullTitle: string;
  tags: string[];
  requirementId?: string;
  requirementTitle?: string;
  /** The requirement exists in TraceQA. */
  linked: boolean;
  acId?: string;
  criterion?: string;
  /** Path relative to the project, e.g. e2e/tests/checkout/req-142.spec.ts */
  file: string;
  line?: number;
  endLine?: number;
  code?: string;
  steps?: { text: string; check: boolean }[];
  signedIn?: boolean;
  /** False for a TraceQA test whose requirement was removed: it is no longer rendered into the framework. */
  inFramework: boolean;
  latest?: { status: TestResult['status']; verdict?: string; project: string; durationMs: number; error?: string; browsers: number };
}

const SPEC = /\.(spec|test)\.[cm]?[jt]sx?$/;
const TEST_CALL = /^(\s*)test(?:\.(?:only|skip|fixme|fail|slow))?\(\s*(['"`])((?:\\.|(?!\2).)*)\2/;

/** The last line (1-based) of a test block that starts at `start` (0-based), found by indentation. */
export function blockEnd(lines: string[], start: number): number {
  const indent = /^\s*/.exec(lines[start])![0];
  for (let i = start + 1; i < lines.length && i < start + 400; i++) {
    if (lines[i].startsWith(`${indent}})`)) return i + 1;
    if (TEST_CALL.test(lines[i]) && /^\s*/.exec(lines[i])![0].length <= indent.length) return i;
  }
  return Math.min(lines.length, start + 40);
}

/** Where each TraceQA test's code is in its spec file (1-based lines). */
export function testRanges(code: string, defs: { id: string; acId?: string; title: string; requirementId: string }[]) {
  const lines = code.split('\n');
  const out: { id: string; start: number; end: number }[] = [];
  for (const def of defs) {
    const title = testTitle(def);
    const start = lines.findIndex((l) => /^\s*test\(/.test(l) && l.replace(/\\(.)/g, '$1').includes(title));
    if (start >= 0) out.push({ id: def.id, start: start + 1, end: blockEnd(lines, start) });
  }
  return out;
}

/** The test's result to show: a failure in any browser wins over a pass. */
function pickLatest(results: TestResult[]): TestListItem['latest'] {
  if (!results.length) return undefined;
  const rank = { failed: 0, flaky: 1, passed: 2, skipped: 3 } as const;
  const r = results.slice().sort((a, b) => rank[a.status] - rank[b.status])[0];
  return { status: r.status, verdict: r.verdict, project: r.project, durationMs: r.durationMs, error: r.error ? r.error.split('\n').slice(0, 14).join('\n') : undefined, browsers: results.length };
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : SPEC.test(e.name) ? [full] : [];
  });
}

const tagsOf = (title: string) => title.match(/@[\w-]+/g) ?? [];
const plainTitle = (title: string) => title.replace(/\s*@[\w-]+/g, '').trim() || title;

export function listAllTests(project: Project): TestListItem[] {
  const reqs = new Map(loadRequirements(project).map((r) => [r.id, r]));
  const results = latestResults(project);
  const testDir = path.join(project.paths.e2e, 'tests');
  const items: TestListItem[] = [];
  const codeOf = new Map<string, string[]>();
  const readLines = (abs: string) => {
    if (!codeOf.has(abs)) codeOf.set(abs, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n') : []);
    return codeOf.get(abs)!;
  };

  // Tests TraceQA wrote.
  const defs = loadTests(project);
  for (const t of defs) {
    const req = reqs.get(t.requirementId);
    const abs = req ? specFileFor(project, req) : undefined;
    const lines = abs ? readLines(abs) : [];
    const range = lines.length ? testRanges(lines.join('\n'), [t])[0] : undefined;
    items.push({
      key: t.id,
      id: t.id,
      source: 'traceqa',
      title: t.acId ? `${t.acId} · ${t.title}` : t.title,
      fullTitle: testTitle(t),
      tags: [`@${t.requirementId}`],
      requirementId: t.requirementId,
      requirementTitle: req?.title,
      linked: !!req,
      acId: t.acId,
      criterion: req?.criteria.find((c) => c.id === t.acId)?.text,
      file: abs ? rel(project.dir, abs) : '',
      line: range?.start,
      endLine: range?.end,
      code: range ? lines.slice(range.start - 1, range.end).join('\n') : undefined,
      steps: t.steps.map((s) => ({ text: describeStep(s), check: s.action.startsWith('expect') })),
      signedIn: t.signedIn,
      inFramework: !!range,
      latest: pickLatest(results.filter((r) => r.testDefId === t.id)),
    });
  }

  // Tests people wrote by hand in the framework folder (files TraceQA did not generate).
  for (const abs of walk(testDir)) {
    const lines = readLines(abs);
    if (/^\/\/ Generated by TraceQA/.test(lines[0] ?? '')) continue;
    const specFile = rel(testDir, abs);
    lines.forEach((line, i) => {
      const m = TEST_CALL.exec(line);
      if (!m) return;
      const fullTitle = m[3].replace(/\\(.)/g, '$1');
      const reqId = new RegExp(`@(${REQ_ID})`).exec(fullTitle)?.[1];
      const end = blockEnd(lines, i);
      const req = reqId ? reqs.get(reqId) : undefined;
      items.push({
        key: `${specFile}:${i + 1}`,
        source: 'hand-written',
        title: plainTitle(fullTitle),
        fullTitle,
        tags: tagsOf(fullTitle),
        requirementId: reqId,
        requirementTitle: req?.title,
        linked: !!req,
        acId: /^(AC\d+)\b/.exec(fullTitle)?.[1],
        file: rel(project.dir, abs),
        line: i + 1,
        endLine: end,
        code: lines.slice(i, end).join('\n'),
        inFramework: true,
        latest: pickLatest(results.filter((r) => !r.testDefId && r.file.replace(/\\/g, '/') === specFile && r.title === fullTitle)),
      });
    });
  }
  return items;
}
