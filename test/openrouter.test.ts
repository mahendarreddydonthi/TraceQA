import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { loadProject, validateConfig } from '../src/core/config.js';
import { runAgent } from '../src/ai/agent.js';
import { buildRequest, listOpenRouterModels, mergeReasoning, OpenRouterModel, toChatMessages, type ReasoningDetail } from '../src/ai/openrouter.js';

const settings = { model: 'anthropic/claude-opus-5.5', baseUrl: 'https://openrouter.ai/api/v1', dataCollection: 'deny' as const, zdr: false, effort: 'high' as const };

test('config defaults to Anthropic and accepts an OpenRouter section', () => {
  const plain = validateConfig({ baseUrl: 'http://localhost:4173' });
  assert.ok(plain.ok);
  if (plain.ok) {
    assert.equal(plain.config.ai.provider, 'anthropic');
    assert.equal(plain.config.ai.openrouter.model, 'anthropic/claude-opus-5.5');
    assert.equal(plain.config.ai.openrouter.dataCollection, 'deny');
  }
  const or = validateConfig({ baseUrl: 'http://localhost:4173', ai: { provider: 'openrouter', openrouter: { model: 'openai/gpt-x' } } });
  assert.ok(or.ok && or.config.ai.openrouter.model === 'openai/gpt-x' && or.config.ai.effort === 'high');
  assert.equal(validateConfig({ baseUrl: 'http://localhost:4173', ai: { provider: 'other' } }).ok, false);
});

test('history translates to chat completions, keeping tool calls, results and reasoning in order', () => {
  const messages = [
    { role: 'user', content: 'Test REQ-1' },
    {
      role: 'assistant',
      content: [
        { type: 'openrouter_reasoning', details: [{ type: 'reasoning.text', text: 'think', signature: 's', index: 0 }] },
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'call_1', name: 'status', input: {} },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'All good', is_error: false }] },
  ] as unknown as Anthropic.Beta.BetaMessageParam[];
  const out = toChatMessages('SYS', messages);
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  const a = out[2] as { content: string; tool_calls: { id: string; function: { name: string; arguments: string } }[]; reasoning_details: ReasoningDetail[] };
  assert.equal(a.content, 'Checking.');
  assert.equal(a.tool_calls[0].function.arguments, '{}');
  assert.equal(a.reasoning_details[0].signature, 's');
  assert.deepEqual(out[3], { role: 'tool', tool_call_id: 'call_1', content: 'All good' });
});

test('requests carry privacy routing and reasoning; Claude also gets caching and room to think', () => {
  const tool = { name: 'status', description: 'd', input_schema: { type: 'object', properties: {} }, eager_input_streaming: true } as unknown as Anthropic.Beta.BetaTool;
  const claude = buildRequest(settings, 'S', [tool], []) as Record<string, unknown>;
  assert.deepEqual(claude.provider, { data_collection: 'deny' });
  assert.deepEqual(claude.reasoning, { effort: 'high' });
  assert.deepEqual(claude.cache_control, { type: 'ephemeral' });
  assert.equal(claude.max_tokens, 64000);
  assert.deepEqual((claude.tools as unknown[])[0], { type: 'function', function: { name: 'status', description: 'd', parameters: { type: 'object', properties: {} } } });
  const other = buildRequest({ ...settings, model: 'openai/some-model', zdr: true, dataCollection: 'allow' }, 'S', [tool], []) as Record<string, unknown>;
  assert.equal(other.cache_control, undefined);
  assert.equal(other.max_tokens, undefined);
  assert.deepEqual(other.provider, { data_collection: 'allow', zdr: true });
});

test('streamed reasoning pieces are merged per block', () => {
  const target: ReasoningDetail[] = [];
  mergeReasoning(target, [{ type: 'reasoning.text', text: 'I should ', index: 0 }]);
  mergeReasoning(target, [{ type: 'reasoning.text', text: 'check', index: 0 }]);
  mergeReasoning(target, [{ type: 'reasoning.text', signature: 'sig', index: 0 }, { type: 'reasoning.encrypted', data: 'abc', index: 1 }]);
  assert.deepEqual(target, [
    { type: 'reasoning.text', text: 'I should check', signature: 'sig', index: 0 },
    { type: 'reasoning.encrypted', data: 'abc', index: 1 },
  ]);
});

/** A stand-in for OpenRouter's chat completions endpoint that answers with scripted SSE streams. */
async function fakeOpenRouter(script: ((body: Record<string, unknown>) => { status?: number; chunks?: unknown[]; json?: unknown })[]) {
  const requests: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    requests.push({ headers: req.headers, body });
    const step = script[requests.length - 1]?.(body) ?? { status: 500, json: { error: { message: 'no more script' } } };
    if (step.status && step.status !== 200) {
      res.writeHead(step.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(step.json));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': OPENROUTER PROCESSING\n\n');
    for (const c of step.chunks ?? []) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/api/v1`, requests, close: () => server.close() };
}

function openRouterProject(baseUrl: string, key = 'or-test-key'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqa-or-'));
  fs.writeFileSync(path.join(dir, 'traceqa.config.json'), JSON.stringify({ baseUrl: 'http://localhost:4173', ai: { provider: 'openrouter', maxTurns: 5, openrouter: { baseUrl } } }));
  if (key) fs.writeFileSync(path.join(dir, '.env'), `OPENROUTER_API_KEY=${key}\n`);
  return dir;
}

test('the agent runs a full tool-use loop through OpenRouter and adds up the reported cost', async () => {
  const fake = await fakeOpenRouter([
    () => ({
      chunks: [
        { model: 'anthropic/claude-opus-5.5', choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'Look at ', index: 0 }] } }] },
        { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'the tests', signature: 'sig-1', index: 0 }] } }] },
        { choices: [{ delta: { content: 'Checking tests.', tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'list_tests', arguments: '{"requirem' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'entId":"REQ-1"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80, cost: 0.01, prompt_tokens_details: { cached_tokens: 1000 } } },
      ],
    }),
    () => ({
      chunks: [
        { model: 'anthropic/claude-opus-5.5', choices: [{ delta: { content: 'REQ-1 has no tests yet.' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 1400, completion_tokens: 20, cost: 0.0123 } },
      ],
    }),
  ]);
  try {
    const project = loadProject(openRouterProject(fake.url));
    const r = await runAgent(project, { task: 'What tests does REQ-1 have?' });
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(r.finalText, 'REQ-1 has no tests yet.');
    assert.equal(r.toolCalls, 1);
    assert.ok(Math.abs(r.usage.costUsd! - 0.0223) < 1e-9, 'uses the cost OpenRouter reported');
    assert.equal(r.usage.cacheReadTokens, 1000);
    assert.equal(r.usage.inputTokens, 200 + 1400);

    const [first, second] = fake.requests;
    assert.equal(first.headers.authorization, 'Bearer or-test-key');
    assert.equal(first.body.model, 'anthropic/claude-opus-5.5');
    assert.equal(first.body.stream, true);
    const names = (first.body.tools as { function: { name: string } }[]).map((t) => t.function.name);
    assert.ok(names.includes('run_tests') && !names.includes('file_bug') && !names.includes('update_bug'), 'human-only tools are never offered');

    const msgs = second.body.messages as Record<string, unknown>[];
    const assistant = msgs.find((m) => m.role === 'assistant')!;
    assert.deepEqual(assistant.reasoning_details, [{ type: 'reasoning.text', text: 'Look at the tests', signature: 'sig-1', index: 0 }]);
    assert.deepEqual((assistant.tool_calls as { function: unknown }[])[0].function, { name: 'list_tests', arguments: '{"requirementId":"REQ-1"}' });
    const toolMsg = msgs.find((m) => m.role === 'tool')!;
    assert.equal(toolMsg.tool_call_id, 'call_a');
    assert.equal(toolMsg.content, 'No tests saved.');
  } finally {
    fake.close();
  }
});

test('OpenRouter errors are explained; temporary ones are retried', async () => {
  const fake = await fakeOpenRouter([
    () => ({ status: 503, json: { error: { message: 'busy' } } }),
    () => ({ chunks: [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }] }),
    () => ({ status: 401, json: { error: { message: 'No auth credentials found' } } }),
    () => ({ status: 404, json: { error: { message: 'No endpoints found matching your data policy' } } }),
  ]);
  try {
    const model = new OpenRouterModel({ ...settings, baseUrl: fake.url }, 'k');
    const ok = await model.next({ system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }] });
    assert.equal((ok.content[0] as { text: string }).text, 'ok');
    await assert.rejects(model.next({ system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }] }), /OPENROUTER_API_KEY/);
    await assert.rejects(model.next({ system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }] }), /data collection/);
    assert.throws(() => new OpenRouterModel(settings, ''), /Set OPENROUTER_API_KEY/);
  } finally {
    fake.close();
  }
});

test('the model picker lists only tool-calling models', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ data: [
      { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', context_length: 1000000, pricing: { prompt: '0.000004', completion: '0.00002' }, supported_parameters: ['tools', 'reasoning'] },
      { id: 'anthropic/claude-opus-5.5:batch', supported_parameters: ['tools'] },
      { id: 'some/text-only', supported_parameters: ['temperature'] },
    ] }))) as unknown as typeof fetch;
  const models = await listOpenRouterModels('https://openrouter.ai/api/v1', fakeFetch);
  assert.deepEqual(models.map((m) => m.id), ['anthropic/claude-opus-5.5']);
  assert.equal(models[0].input, 4);
  assert.equal(models[0].output, 20);
});
