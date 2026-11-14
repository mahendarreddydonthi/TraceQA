import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { nameSimilarity, pickReplacement } from '../src/core/heal.js';
import { bugToAdf, trackingLabel } from '../src/core/jira.js';
import { buildTools, toJsonSchema } from '../src/tools/registry.js';
import { runAgent, type ModelClient } from '../src/ai/agent.js';
import { loadProject } from '../src/core/config.js';
import { importRequirements } from '../src/core/requirements.js';
import type { Bug, PageElement } from '../src/core/types.js';

const el = (role: string, name: string, extra: Partial<PageElement> = {}): PageElement => ({
  key: name, role, name, locator: { by: 'role', role, name, exact: true }, stability: 'stable', ...extra,
});

test('name similarity favours renamed-but-related labels', () => {
  assert.equal(nameSimilarity('Apply', 'apply'), 1);
  assert.ok(nameSimilarity('Apply', 'Apply coupon') > 0.75);
  assert.ok(nameSimilarity('Update', 'Update quantity') > 0.75);
  assert.ok(nameSimilarity('Sign in', 'Sign In') === 1);
  assert.ok(nameSimilarity('Apply', 'Place order') < 0.3);
});

test('healing picks a clear replacement and refuses close calls', () => {
  const old = { by: 'role' as const, role: 'button', name: 'Apply', exact: true };
  const page = [el('button', 'Apply coupon'), el('button', 'Place order'), el('link', 'Home')];
  assert.equal(pickReplacement(old, page)?.element.name, 'Apply coupon');
  // Two equally good candidates: no guess.
  assert.equal(pickReplacement(old, [el('button', 'Apply coupon'), el('button', 'Apply voucher')]), undefined);
  // Nothing similar enough.
  assert.equal(pickReplacement(old, [el('button', 'Place order')]), undefined);
  // Ambiguous elements are never used.
  assert.equal(pickReplacement(old, [el('button', 'Apply coupon', { stability: 'ambiguous' })]), undefined);
  // A label locator heals to a field, not a button.
  const label = { by: 'label' as const, label: 'Coupon code' };
  assert.equal(pickReplacement(label, [el('button', 'Coupon code'), el('textbox', 'Coupon code (optional)')])?.element.role, 'textbox');
});

test('Jira payload: tracking label and document format', () => {
  const bug: Bug = {
    id: 'BUG-01', status: 'draft', severity: 'high', title: 'Lowercase coupon codes are rejected', requirementId: 'REQ-142', acId: 'AC3',
    source: { kind: 'explore', ref: 'S-001' }, environment: 'http://localhost:4173 · Chromium', steps: ['Go to /p/1', 'Select the button "Apply"'],
    expected: 'Discount applied', actual: 'Invalid coupon code', evidence: [], createdAt: '', updatedAt: '',
  };
  assert.equal(trackingLabel(bug), 'tqa-REQ-142-AC3');
  const adf = bugToAdf(bug) as { type: string; content: { type: string; content?: unknown[] }[] };
  assert.equal(adf.type, 'doc');
  const list = adf.content.find((n) => n.type === 'orderedList');
  assert.equal(list?.content?.length, 2);
});

test('every tool has an object JSON schema for the Claude API', () => {
  for (const t of buildTools(os.tmpdir())) {
    const s = toJsonSchema(t);
    assert.equal(s.type, 'object', t.name);
    assert.ok(!('$schema' in s), t.name);
  }
  const save = toJsonSchema(buildTools(os.tmpdir()).find((t) => t.name === 'save_test')!) as { required?: string[] };
  assert.deepEqual(save.required?.sort(), ['requirementId', 'steps', 'title']);
});

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceqa-agent-'));
  fs.writeFileSync(path.join(dir, 'traceqa.config.json'), JSON.stringify({ baseUrl: 'http://localhost:9' }));
  fs.mkdirSync(path.join(dir, 'requirements'));
  fs.writeFileSync(path.join(dir, 'requirements', 'a.md'), '# Shop\n\n## REQ-1 Home shows products\n- AC1: Products are listed\n');
  return dir;
}

function message(content: unknown[], stop: string): Anthropic.Beta.BetaMessage {
  return { id: 'm', type: 'message', role: 'assistant', model: 'fake', content, stop_reason: stop, stop_sequence: null, usage: {} } as unknown as Anthropic.Beta.BetaMessage;
}

test('agent loop runs tools in order, rejects invalid input and hides human-only tools', async () => {
  const dir = tempProject();
  const project = loadProject(dir);
  await importRequirements(project);
  const offered: string[][] = [];
  const seenResults: unknown[] = [];
  const script = [
    message([{ type: 'text', text: 'Checking status.' }, { type: 'tool_use', id: 't1', name: 'status', input: {} }], 'tool_use'),
    message([{ type: 'tool_use', id: 't2', name: 'get_requirement', input: { requirementId: 'REQ-1' } }, { type: 'tool_use', id: 't3', name: 'get_requirement', input: {} }], 'tool_use'),
    message([{ type: 'tool_use', id: 't4', name: 'update_bug', input: { bugId: 'BUG-01', status: 'approved' } }], 'tool_use'),
    message([{ type: 'text', text: 'Done: REQ-1 has no tests yet.' }], 'end_turn'),
  ];
  const fake: ModelClient = {
    async next({ tools, messages }) {
      offered.push(tools.map((t) => t.name));
      const last = messages[messages.length - 1];
      if (last.role === 'user' && Array.isArray(last.content)) seenResults.push(...last.content);
      return script.shift()!;
    },
  };
  const run = await runAgent(project, { task: 'Check REQ-1', model: fake });
  assert.equal(run.stopReason, 'end_turn');
  assert.equal(run.finalText, 'Done: REQ-1 has no tests yet.');
  assert.equal(run.toolCalls, 4);
  for (const names of offered) {
    assert.ok(!names.includes('update_bug') && !names.includes('file_bug') && !names.includes('remove_test'));
    assert.ok(names.includes('save_test') && names.includes('explore_start'));
  }
  const results = seenResults as { tool_use_id: string; is_error?: boolean; content: string }[];
  assert.match(results.find((r) => r.tool_use_id === 't1')!.content, /Requirements: 1 imported/);
  assert.match(results.find((r) => r.tool_use_id === 't2')!.content, /REQ-1 · Home shows products/);
  assert.equal(results.find((r) => r.tool_use_id === 't3')!.is_error, true);
  assert.equal(results.find((r) => r.tool_use_id === 't4')!.is_error, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent stops on refusal and on the turn limit', async () => {
  const dir = tempProject();
  const project = loadProject(dir);
  const refuse: ModelClient = { next: async () => message([], 'refusal') };
  assert.equal((await runAgent(project, { task: 'x', model: refuse })).stopReason, 'refusal');
  const loop: ModelClient = { next: async () => message([{ type: 'tool_use', id: `t${Math.random()}`, name: 'status', input: {} }], 'tool_use') };
  const r = await runAgent(project, { task: 'x', model: loop, maxTurns: 3 });
  assert.equal(r.stopReason, 'max_turns');
  assert.equal(r.turns, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});
