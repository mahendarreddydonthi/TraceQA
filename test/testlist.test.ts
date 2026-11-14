import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProject } from '../src/core/config.js';
import { importRequirements } from '../src/core/requirements.js';
import { saveTest } from '../src/core/testgen.js';
import { blockEnd, listAllTests } from '../src/core/testlist.js';
import { writeJson } from '../src/core/store.js';

test('all tests: TraceQA tests and hand-written Playwright tests, linked to a requirement or not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqa-list-'));
  fs.writeFileSync(path.join(dir, 'traceqa.config.json'), JSON.stringify({ baseUrl: 'http://localhost:4173' }));
  fs.mkdirSync(path.join(dir, 'requirements'));
  fs.writeFileSync(path.join(dir, 'requirements', 'shop.md'), '# Shop\n## REQ-1 Sign in\n- AC1: Valid credentials open My account\n');
  const p = loadProject(dir);
  await importRequirements(p);
  const { def } = saveTest(p, { requirementId: 'REQ-1', acId: 'AC1', title: 'valid credentials work', steps: [{ action: 'goto', path: '/signin' }, { action: 'expectVisible', target: { by: 'role', role: 'heading', name: 'Sign in' } }] });

  const manual = path.join(p.paths.e2e, 'tests', 'manual');
  fs.mkdirSync(manual, { recursive: true });
  fs.writeFileSync(path.join(manual, 'smoke.spec.ts'), [
    "import { test, expect } from '@playwright/test';",
    '',
    "test.describe('smoke', () => {",
    "  test('home page loads @REQ-1', async ({ page }) => {",
    "    await page.goto('/');",
    '  });',
    '',
    "  test('footer shows the year', async ({ page }) => {",
    "    await page.goto('/');",
    "    await expect(page.getByText('2026')).toBeVisible();",
    '  });',
    '});',
  ].join('\n'));
  fs.writeFileSync(path.join(manual, 'notes.md'), 'not a test');
  writeJson(path.join(p.paths.runs, 'RUN-001.json'), {
    id: 'RUN-001', startedAt: '2026-11-13T10:00:00Z', finishedAt: '2026-11-13T10:01:00Z', durationMs: 60000, bugs: [],
    totals: { total: 2, passed: 1, failed: 1, flaky: 0, skipped: 0 },
    results: [
      { title: 'footer shows the year', file: 'manual/smoke.spec.ts', line: 8, project: 'chromium', status: 'failed', durationMs: 1200, error: 'Error: expect(locator).toBeVisible() failed', verdict: 'app-bug', attachments: [] },
      { title: 'home page loads @REQ-1', file: 'manual/smoke.spec.ts', line: 4, project: 'chromium', requirementId: 'REQ-1', status: 'passed', durationMs: 800, attachments: [] },
    ],
  });

  const all = listAllTests(loadProject(dir));
  assert.equal(all.length, 3);
  const mine = all.find((t) => t.id === def.id)!;
  assert.equal(mine.source, 'traceqa');
  assert.equal(mine.linked, true);
  assert.equal(mine.criterion, 'Valid credentials open My account');
  assert.ok(mine.inFramework && mine.code?.includes("test('AC1 · valid credentials work @REQ-1'"), 'its own code from the generated spec');
  assert.deepEqual(mine.steps!.map((s) => s.check), [false, true]);

  const tagged = all.find((t) => t.fullTitle === 'home page loads @REQ-1')!;
  assert.deepEqual([tagged.source, tagged.linked, tagged.requirementId, tagged.title, tagged.line, tagged.endLine], ['hand-written', true, 'REQ-1', 'home page loads', 4, 6]);
  assert.equal(tagged.latest?.status, 'passed');
  assert.equal(tagged.file, 'e2e/tests/manual/smoke.spec.ts');

  const loose = all.find((t) => t.title === 'footer shows the year')!;
  assert.equal(loose.linked, false, 'no tag: not linked to a requirement');
  assert.equal(loose.requirementId, undefined);
  assert.equal(loose.latest?.status, 'failed');
  assert.equal(loose.latest?.verdict, 'app-bug');
  assert.match(loose.code!, /^ {2}test\('footer shows the year'[\s\S]*toBeVisible\(\);\n {2}\}\);$/);

  // A test whose requirement was removed is listed, but not as part of the framework.
  fs.writeFileSync(path.join(dir, 'requirements', 'shop.md'), '# Shop\n## REQ-2 Search\n- AC1: Results appear\n');
  await importRequirements(loadProject(dir));
  const orphan = listAllTests(loadProject(dir)).find((t) => t.id === def.id)!;
  assert.deepEqual([orphan.linked, orphan.inFramework], [false, false]);

  assert.equal(blockEnd(['test("a", () => {', '  x();', '});', 'test("b", () => {'], 0), 3);
});
