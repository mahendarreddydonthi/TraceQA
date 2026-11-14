import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProgressTracker, progressLine, type JobProgress } from '../src/ai/progress.js';
import { parseMaxFlows, tasks } from '../src/ai/agent.js';

test('flows to automate: optional, a whole number from 1 to 100', () => {
  assert.equal(parseMaxFlows(undefined), undefined);
  assert.equal(parseMaxFlows(''), undefined);
  assert.equal(parseMaxFlows('  '), undefined);
  assert.equal(parseMaxFlows(null), undefined);
  assert.equal(parseMaxFlows('7'), 7);
  assert.equal(parseMaxFlows(20), 20);
  for (const bad of ['0', '-2', '2.5', 'ten', 101]) assert.throws(() => parseMaxFlows(bad), /whole number/, String(bad));

  const any = tasks.exploreApp({ writeTests: true });
  assert.match(any, /Automate every distinct flow you found/);
  assert.doesNotMatch(any, /up to \d+|\d+ most important/);
  const three = tasks.exploreApp({ writeTests: true, maxFlows: 3 });
  assert.match(three, /Pick the 3 most important flows .* \(fewer if you found fewer\)/);
  assert.doesNotMatch(tasks.exploreApp({}), /save_discovered_flow/, 'exploring only does not automate');
});

test('progress: phases, plain-words activity, counts and a timeline from the agent\'s tool calls', () => {
  const seen: JobProgress[] = [];
  let t = 0;
  const tr = new ProgressTracker('explore-app-automate', (p) => seen.push(structuredClone(p)), {
    flowTarget: null,
    resolveRef: (ref) => (ref === 'e7' ? 'button "Add to cart"' : undefined),
    now: () => new Date(Date.UTC(2026, 10, 13, 10, 0, t++)).toISOString(),
  });
  const p = tr.progress;
  assert.equal(p.activity, 'Starting the AI agent…');
  assert.deepEqual(p.phases.map((x) => x.label), ['Getting ready', 'Exploring the app', 'Automating flows', 'Running the new tests', 'Summary']);

  tr.handle({ type: 'turn', n: 1 });
  assert.equal(p.activity, 'Reading the task and planning…');
  tr.handle({ type: 'tool-start', name: 'status', input: {} });
  assert.equal(p.phase, 'prepare');
  assert.equal(p.activity, 'Checking the project…');
  tr.handle({ type: 'tool-done', name: 'status', input: {}, output: 'App: …' });

  tr.handle({ type: 'text', text: 'I will start   with the home page\nand the search.' });
  assert.equal(p.note, 'I will start with the home page and the search.');
  tr.handle({ type: 'tool-start', name: 'explore_start', input: { charter: 'x', startPath: '/' } });
  assert.equal(p.phase, 'explore');
  assert.deepEqual(p.phases.map((x) => x.status), ['done', 'active', 'pending', 'pending', 'pending']);
  assert.deepEqual(p.events.slice(-2).map((e) => [e.kind, e.phase]), [['phase', 'explore'], ['note', 'explore']], 'the note that announces a phase comes under it');
  tr.handle({ type: 'tool-done', name: 'explore_start', input: { startPath: '/' }, output: 'Session S-004 started. 0 step(s) so far.\n\n…' });
  assert.equal(p.sessionId, 'S-004');

  tr.handle({ type: 'tool-start', name: 'explore_action', input: { action: 'click', ref: 'e7' } });
  assert.equal(p.activity, 'Clicking the button "Add to cart"…');
  tr.handle({ type: 'tool-done', name: 'explore_action', input: { action: 'click', ref: 'e7' }, output: 'Step 1 ok: click button "Add to cart"\n\n…' });
  tr.handle({ type: 'tool-start', name: 'explore_action', input: { action: 'fill', locator: { by: 'label', label: 'Password' }, value: '${TEST_USER_PASSWORD}' } });
  assert.equal(p.activity, 'Typing the test value into the field labelled "Password"…', 'secrets are never shown');
  tr.handle({ type: 'tool-done', name: 'explore_action', input: { action: 'fill', value: 'x' }, output: 'Step 2 FAILED: fill\nError: Timeout 5000ms exceeded.\n\n…' });
  assert.equal(p.counts.steps, 2);
  assert.equal(p.counts.failedSteps, 1);
  const failedStep = p.events.filter((e) => e.kind === 'action')[1];
  assert.equal(failedStep.ok, false);
  assert.equal(failedStep.detail, 'Timeout 5000ms exceeded.');

  // Live session numbers are exact and are not counted twice.
  tr.session({ id: 'S-004', steps: [{ ok: true }, { ok: false }, { ok: true }], pages: new Set(['/', '/cart']), findings: [{}] });
  tr.handle({ type: 'tool-start', name: 'explore_record_finding', input: { title: 'Lowercase coupons are rejected', severity: 'high', expected: 'Discount', actual: 'Invalid code' } });
  assert.equal(p.activity, 'Recording a problem: Lowercase coupons are rejected…');
  tr.handle({ type: 'tool-done', name: 'explore_record_finding', input: { title: 'Lowercase coupons are rejected', severity: 'high', expected: 'Discount', actual: 'Invalid code' }, output: 'Finding 1 recorded with screenshot x.png. Draft bug BUG-07 created (not filed).' });
  assert.deepEqual([p.counts.steps, p.counts.failedSteps, p.counts.pages, p.counts.findings], [3, 1, 2, 1]);
  const finding = p.events.find((e) => e.kind === 'finding')!;
  assert.equal(finding.ref, 'BUG-07');
  assert.match(finding.detail!, /^high severity · Expected: Discount · Actual: Invalid code$/);

  tr.handle({ type: 'tool-start', name: 'save_discovered_flow', input: { title: 'Search finds a product', criteria: ['a', 'b'] } });
  assert.equal(p.phase, 'automate');
  assert.equal(p.activity, 'Recording the flow “Search finds a product”…');
  tr.handle({ type: 'tool-done', name: 'save_discovered_flow', input: { title: 'Search finds a product', criteria: ['a', 'b'] }, output: 'Saved E2E-003 "Search finds a product" with 2 criteria (AC1, AC2). Now …' });
  tr.handle({ type: 'tool-start', name: 'get_requirement', input: { requirementId: 'e2e-003' } });
  assert.equal(p.phase, 'automate', 'look-ups stay in the current phase');
  tr.handle({ type: 'tool-done', name: 'get_requirement', input: {}, output: '' });
  tr.handle({ type: 'tool-done', name: 'save_test', input: { requirementId: 'E2E-003', acId: 'AC1', title: 'finds by part of the name' }, output: 'Saved E2E-003-AC1-finds in e2e/tests/x.spec.ts.\nCheck run: PASSED (chromium).' });
  tr.handle({ type: 'tool-done', name: 'save_test', input: { requirementId: 'E2E-003', acId: 'AC2', title: 'no match message' }, output: 'Saved E2E-003-AC2-no in e2e/tests/x.spec.ts.\nCheck run: FAILED (chromium) · verdict test-broken\nError …' });
  const testsDone = p.events.filter((e) => e.kind === 'test');
  assert.deepEqual(testsDone.map((e) => [e.ref, e.ok, e.detail]), [['E2E-003-AC1-finds', true, 'Saved; its check run passed'], ['E2E-003-AC2-no', false, 'Saved; its check run failed (test-broken)']]);
  assert.equal(p.counts.flows, 1);
  assert.equal(p.counts.tests, 2);

  tr.handle({ type: 'tool-start', name: 'run_tests', input: { requirementId: 'E2E-003' } });
  assert.equal(p.phase, 'verify');
  assert.equal(p.activity, 'Running the tests for E2E-003…');
  tr.handle({ type: 'tool-done', name: 'run_tests', input: { requirementId: 'E2E-003' }, output: 'RUN-009: 1 passed · 1 failed · 0 flaky · 0 skipped (8.2 s)\n…' });
  const run = p.events.find((e) => e.kind === 'run')!;
  assert.deepEqual([run.ref, run.ok, run.text], ['RUN-009', false, 'E2E-003: 1 passed, 1 failed']);
  tr.handle({ type: 'tool-error', name: 'run_tests', input: {}, error: 'Playwright crashed\nstack' });
  assert.equal(p.events.at(-1)!.kind, 'error');
  assert.equal(p.events.at(-1)!.detail, 'Playwright crashed');

  tr.finish('done');
  assert.equal(p.done, true);
  assert.equal(p.activity, 'Finished');
  assert.deepEqual(p.phases.map((x) => x.status), ['done', 'done', 'done', 'done', 'done']);
  assert.deepEqual(p.events.filter((e) => e.kind === 'phase').map((e) => e.text), ['Getting ready', 'Exploring the app', 'Automating flows', 'Running the new tests', 'Summary']);
  assert.ok(seen.length > 10, 'every change is published');
  const line = progressLine(p)!;
  assert.equal(line.phaseLabel, 'Summary');
  assert.equal(line.flowTarget, null);
});

test('progress: phases the run never reached are marked skipped; a stopped run says so', () => {
  const tr = new ProgressTracker('explore-app-automate', () => {});
  tr.handle({ type: 'tool-start', name: 'explore_start', input: {} });
  tr.finish('stopped');
  const p = tr.progress;
  assert.deepEqual(p.phases.map((x) => x.status), ['skipped', 'active', 'skipped', 'skipped', 'skipped']);
  assert.equal(p.activity, 'Stopped');
  const failed = new ProgressTracker('explore', () => {});
  failed.finish('failed', 'The Anthropic API key was rejected (401).\nmore');
  assert.equal(failed.progress.activity, 'Failed: The Anthropic API key was rejected (401).');
  // An explore-only plan has no automate phase: a stray save_test stays in the current phase.
  const only = new ProgressTracker('explore-app', () => {});
  only.handle({ type: 'tool-start', name: 'explore_start', input: {} });
  only.handle({ type: 'tool-start', name: 'save_test', input: { requirementId: 'x', title: 'y' } });
  assert.equal(only.progress.phase, 'explore');
});
