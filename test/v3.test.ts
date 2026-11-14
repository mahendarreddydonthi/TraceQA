import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProject, readEnvFile, setEnvValues } from '../src/core/config.js';
import { getSettings, saveSettings } from '../src/core/settings.js';
import { resolveRequirementFile, writeRequirementFile, trashRequirementFile, previewRequirements } from '../src/core/requirements.js';
import { listHeals, reviewHeal } from '../src/core/heal.js';
import { writeJson } from '../src/core/store.js';
import { JobManager } from '../src/ui/jobs.js';
import { StoppedError } from '../src/core/proc.js';
import { addUsage, emptyUsage } from '../src/ai/pricing.js';
import { startDashboard } from '../src/ui/server.js';

function tempProject(config: Record<string, unknown> = { baseUrl: 'http://localhost:4173' }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqa-v3-'));
  fs.writeFileSync(path.join(dir, 'traceqa.config.json'), JSON.stringify(config));
  return dir;
}

test('.env values are set, replaced and removed without touching other lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqa-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '# test account\nTEST_USER_EMAIL=a@example.test\nOTHER=keep\n');
  setEnvValues(file, { TEST_USER_EMAIL: 'b@example.test', TEST_USER_PASSWORD: 'p a#ss', OTHER: null });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# test account$/m);
  assert.doesNotMatch(text, /OTHER/);
  const env = readEnvFile(file);
  assert.equal(env.TEST_USER_EMAIL, 'b@example.test');
  assert.equal(env.TEST_USER_PASSWORD, 'p a#ss');
  assert.throws(() => setEnvValues(file, { X: 'two\nlines' }), /line break/);
  assert.throws(() => setEnvValues(file, { 'BAD-NAME': 'x' }), /not a valid/);
});

test('settings are validated, keep secrets write-only, and allow the new host', () => {
  const dir = tempProject({ baseUrl: 'http://localhost:4173', safety: { allowedHosts: ['localhost:4173'] } });
  assert.throws(() => saveSettings(dir, { config: { baseUrl: 'not a url' } }), /Not saved/);
  assert.throws(() => saveSettings(dir, { config: { output: { dir: 'x' } } as never }), /cannot be changed/);
  assert.throws(() => saveSettings(dir, { env: { NODE_OPTIONS: '--require x' } }), /not a setting/);

  const r = saveSettings(dir, {
    config: { baseUrl: 'https://staging.example.test', safety: { allowedHosts: ['localhost:4173'], blockedActions: [], maxPagesPerSession: 40, maxMinutesPerSession: 15 } },
    env: { ANTHROPIC_API_KEY: 'sk-test-123', TEST_USER_PASSWORD: '' },
  });
  assert.ok(r.notes.some((n) => n.includes('staging.example.test')));
  const project = loadProject(dir);
  assert.deepEqual(project.config.safety.allowedHosts, ['localhost:4173', 'staging.example.test']);
  const s = getSettings(project);
  const key = s.env.find((e) => e.key === 'ANTHROPIC_API_KEY')!;
  assert.equal(key.set, true);
  assert.equal(key.value, undefined, 'secret values are never returned');
  assert.ok(!JSON.stringify(s).includes('sk-test-123'));
  assert.equal(readEnvFile(path.join(dir, '.env')).TEST_USER_PASSWORD, undefined, 'empty means unchanged');

  saveSettings(dir, { env: { ANTHROPIC_API_KEY: null } });
  assert.equal(readEnvFile(path.join(dir, '.env')).ANTHROPIC_API_KEY, undefined);
});

test('requirement files stay inside the requirements folder and go to the trash, not away', async () => {
  const dir = tempProject();
  const project = loadProject(dir);
  for (const bad of ['../x.md', '/etc/x.md', 'C:/x.md', 'notes.docx', 'slides.pptx', 'README.md', 'a/../../b.md', '']) {
    assert.throws(() => resolveRequirementFile(project, bad), undefined, bad);
  }
  assert.ok(resolveRequirementFile(project, 'notes.txt'), 'text files can be edited too');
  assert.ok(resolveRequirementFile(project, 'spec.docx', true), 'Word and PDF are allowed as documents');
  assert.ok(resolveRequirementFile(project, 'checkout/coupons.md').endsWith(path.join('requirements', 'checkout', 'coupons.md')));
  writeRequirementFile(project, 'shop.md', '# Shop\n\n## REQ-1 Search\n- AC1: Results appear quickly\n');
  const preview = (await previewRequirements(project, fs.readFileSync(path.join(dir, 'requirements', 'shop.md'), 'utf8'), 'shop.md')).requirements;
  assert.equal(preview[0].id, 'REQ-1');
  assert.equal(preview[0].criteria[0].issues[0].kind, 'vague');
  const trashed = trashRequirementFile(project, 'shop.md');
  assert.ok(trashed.startsWith('.traceqa/trash/'));
  assert.ok(fs.existsSync(path.join(dir, trashed)));
  assert.ok(!fs.existsSync(path.join(dir, 'requirements', 'shop.md')));
});

test('jobs run one at a time and can be stopped or cancelled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqa-jobs-'));
  const events: string[] = [];
  const jm = new JobManager(() => dir, (e, d) => events.push(`${e}:${(d as { status?: string }).status ?? ''}`));
  let release!: () => void;
  const a = jm.enqueue('test', 'A', {}, (ctx) =>
    new Promise<string>((resolve, reject) => {
      ctx.log('a started');
      release = () => resolve('a done');
      ctx.signal.addEventListener('abort', () => reject(new StoppedError()));
    }),
  );
  const b = jm.enqueue('test', 'B', {}, async () => 'b done');
  const c = jm.enqueue('test', 'C', {}, async () => 'c done');
  await new Promise((r) => setImmediate(r));
  assert.equal(jm.get(a.id)!.status, 'running');
  assert.equal(jm.get(b.id)!.status, 'queued');
  jm.stop(c.id);
  assert.equal(jm.get(c.id)!.status, 'stopped');
  jm.stop(a.id);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(jm.get(a.id)!.status, 'stopped');
  assert.equal(jm.get(b.id)!.status, 'done');
  assert.equal(jm.get(b.id)!.result, 'b done');
  assert.ok(fs.existsSync(path.join(dir, `${a.id}.json`)), 'history is saved');
  assert.throws(() => jm.stop(b.id), /already finished/);
  void release;

  // A new manager marks jobs that were left running as failed.
  writeJson(path.join(dir, 'JOB-099.json'), { id: 'JOB-099', kind: 'x', label: 'x', ai: false, status: 'running', createdAt: new Date().toISOString(), log: [] });
  const again = new JobManager(() => dir, () => {});
  assert.equal(again.get('JOB-099')!.status, 'failed');
});

test('usage adds up with an approximate cost for known models only', () => {
  let u = addUsage(emptyUsage(), 'claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 });
  assert.equal(u.inputTokens, 1_000_000);
  assert.ok(Math.abs(u.costUsd! - (4 + 2 + 0.2)) < 1e-9);
  u = addUsage(u, 'some-unknown-model', { input_tokens: 10, output_tokens: 10 });
  assert.equal(u.costUsd, undefined, 'unknown prices make the total unknown');
  assert.equal(u.outputTokens, 100_010);
});

test('a proposed heal can be rejected; other states cannot be reviewed', async () => {
  const dir = tempProject();
  const project = loadProject(dir);
  const heal = { id: 'HEAL-001', testId: 'REQ-1-AC1-x', requirementId: 'REQ-1', status: 'proposed', fixes: [], createdAt: new Date().toISOString() };
  writeJson(path.join(dir, '.traceqa', 'heals', 'HEAL-001.json'), heal);
  const r = await reviewHeal(project, 'heal-001', 'reject');
  assert.equal(r.status, 'rejected');
  assert.equal(listHeals(project)[0].status, 'rejected');
  await assert.rejects(reviewHeal(project, 'HEAL-001', 'apply'), /only proposed heals/);
});

test('dashboard: setup mode, local-only access, write-only secrets, confirmed AI jobs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqa-ui-'));
  const dash = await startDashboard(dir, { port: 0 });
  const base = `http://127.0.0.1:${dash.port}`;
  const post = (p: string, body: unknown, headers: Record<string, string> = { 'X-TraceQA': '1' }) =>
    fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    let st = await (await fetch(`${base}/api/state`)).json();
    assert.equal(st.ready, false);
    assert.equal((await fetch(`${base}/api/overview`)).status, 409);
    assert.equal((await post('/api/setup', { baseUrl: 'http://localhost:4173' }, {})).status, 403, 'no X-TraceQA header');
    assert.equal((await post('/api/setup', { baseUrl: 'http://localhost:4173' }, { 'X-TraceQA': '1', Origin: 'https://evil.example' })).status, 403, 'foreign origin');

    const setup = await post('/api/setup', {
      baseUrl: 'http://localhost:4173',
      auth: { loginPath: '/signin', usernameLabel: 'Email', passwordLabel: 'Password', submitButton: 'Sign in' },
      env: { TEST_USER_EMAIL: 'qa@example.test', TEST_USER_PASSWORD: 'hunter2-test' },
    });
    assert.equal(setup.status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'traceqa.config.json')));
    assert.ok(fs.existsSync(path.join(dir, 'TraceQA Dashboard.cmd')));
    st = await (await fetch(`${base}/api/state`)).json();
    assert.equal(st.ready, true);

    const settingsText = await (await fetch(`${base}/api/settings`)).text();
    assert.ok(settingsText.includes('qa@example.test'), 'the test user name is shown');
    assert.ok(!settingsText.includes('hunter2-test'), 'the password is never sent back');

    // DNS-rebinding style request: right port, foreign Host header.
    const http = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: dash.port, path: '/api/state', headers: { Host: `evil.example:${dash.port}` } }, (res) => resolve(res.statusCode ?? 0));
    });
    assert.equal(status, 403);

    const saved = await post('/api/requirement-files', { file: 'shop.md', content: '# Shop\n\n## REQ-7 Cart\n- AC1: Shows "Your cart is empty" when empty\n' });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).imported, 1);
    assert.equal((await post('/api/requirement-files', { file: 'shop.md', content: 'x' })).status, 409, 'no silent overwrite');
    assert.equal((await post('/api/requirement-files', { file: '../escape.md', content: 'x' })).status, 400);
    assert.ok(!fs.existsSync(path.join(dir, 'escape.md')));

    const ai = await post('/api/jobs', { kind: 'explore', requirementId: 'REQ-7' });
    assert.equal(ai.status, 400);
    assert.match((await ai.json()).error, /confirm/);
    assert.equal((await fetch(`${base}/files/traceqa.config.json`)).status, 404);
    assert.equal((await fetch(`${base}/files/.env`)).status, 404);
  } finally {
    dash.close();
  }
});
