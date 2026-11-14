import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
// @ts-expect-error plain ESM helper script without types
import { makeDocx, makePdf } from '../scripts/doc-fixtures.mjs';
import { loadProject } from '../src/core/config.js';
import { documentToMarkdown, importDocument, textToMarkdown } from '../src/core/documents.js';
import { addDiscoveredFlow, importRequirements, loadRequirements, parseRequirementsMarkdown } from '../src/core/requirements.js';
import { adfToMarkdown, importJiraRequirements, splitCriteria, wikiToMarkdown } from '../src/core/jira-import.js';
import { listOllamaModels, OllamaModel } from '../src/ai/local.js';
import { runAgent, tasks, type ModelClient } from '../src/ai/agent.js';
import { readDocumentWithAI } from '../src/ai/read.js';
import { startDashboard } from '../src/ui/server.js';

function project(extra: Record<string, unknown> = {}, env = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqa-v4-'));
  fs.writeFileSync(path.join(dir, 'traceqa.config.json'), JSON.stringify({ baseUrl: 'http://localhost:4173', ...extra }));
  if (env) fs.writeFileSync(path.join(dir, '.env'), env);
  return dir;
}

async function fakeServer(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const requests: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    requests.push({ url: req.url ?? '', headers: req.headers, body });
    handler(req, body, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, close: () => server.close() };
}

test('requirement IDs can be REQ numbers, Jira keys or discovered flows', () => {
  const reqs = parseRequirementsMarkdown('# Shop\n## SHOP-142 Coupons\n- AC1: x\n## E2E-001 Search\n- y\n## REQ-7 Cart\n- z\n## Checkout notes\n- not a requirement\n', 'a.md');
  assert.deepEqual(reqs.map((r) => r.id), ['SHOP-142', 'E2E-001', 'REQ-7']);
});

test('Word documents keep headings, lists and requirement tables', async () => {
  const docx = makeDocx([
    ['h1', 'Search'],
    ['h2', 'FR-12 Search by product name'],
    ['p', 'Customers type part of a name.'],
    ['li', 'Searching for "head" lists Wireless Headphones'],
    ['li', 'No match shows "No products found"'],
    ['p', 'Q3 2026 plan: HTTP 404 page later.'],
    ['table', [['ID', 'Title', 'Acceptance criteria'], ['US 7', 'Sort by price', 'Choosing "Price: low to high" sorts the list\nThe cheapest product is first']]],
  ]);
  const { markdown, kind } = await documentToMarkdown(docx, 'spec.docx');
  assert.equal(kind, 'Word');
  const reqs = parseRequirementsMarkdown(markdown, 'spec.md');
  assert.deepEqual(reqs.map((r) => [r.id, r.criteria.length]), [['FR-12', 2], ['US-7', 2]]);
  assert.match(markdown, /Q3 2026 plan/, 'running text that merely starts with letters and digits stays text');
  assert.equal(reqs[0].feature, 'Search');
});

test('PDF and text documents convert too; old .doc files are refused', async () => {
  const pdf = makePdf([['Returns', 20], ['REQ-180 Customers can request a return', 13], ['- Each delivered order shows "Request return"'], ['2) After requesting, the order shows "Return requested"']]);
  const r = await documentToMarkdown(pdf, 'returns.pdf');
  const reqs = parseRequirementsMarkdown(r.markdown, 'r.md');
  assert.equal(reqs[0].id, 'REQ-180');
  assert.equal(reqs[0].criteria.length, 2);
  assert.match(r.markdown, /^# Returns/m, 'large text becomes a heading');
  assert.match(textToMarkdown('REQ-9 Login\n* Wrong password shows an error'), /## REQ-9 Login\n- Wrong password/);
  await assert.rejects(documentToMarkdown(Buffer.from('x'), 'old.doc'), /\.docx/);
  await assert.rejects(documentToMarkdown(Buffer.from('x'), 'slides.pptx'), /not supported/);
});

test('an uploaded document is kept exactly as it is and read in any format', async () => {
  const dir = project();
  const p = loadProject(dir);
  const brief = makeDocx([['h1', 'Loyalty'], ['p', 'We want to reward repeat customers. Every purchase should earn points. Customers can spend 100 points for a $5 discount.']]);
  const a = await importDocument(p, 'brief.docx', brief);
  assert.equal(a.file, 'brief.docx');
  assert.equal(a.requirements, 1);
  assert.equal(a.criteria, 2);
  assert.equal(a.mode, 'free-form');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'requirements', 'brief.docx')), brief, 'the original is not changed');
  assert.ok(!fs.existsSync(path.join(dir, 'requirements', 'brief.md')), 'no converted copy');
  const b = await importDocument(p, 'brief.docx', makeDocx([['h2', 'REQ-50 Points'], ['li', 'A purchase adds points']]));
  assert.equal(b.file, 'brief-2.docx', 'never overwrites');
  const reqs = loadRequirements(p);
  assert.equal(reqs.length, 2, 'one from each document');
  assert.ok(reqs.some((r) => r.id === 'REQ-50' && !r.autoId));
  const auto = reqs.find((r) => r.autoId)!;
  assert.match(auto.id, /^REQ-\d{3}$/);
  assert.equal(auto.source.mode, 'free-form');
  assert.notEqual(auto.id, 'REQ-50');
});

test('Jira descriptions: acceptance criteria from bullets, Gherkin, or a custom field', () => {
  const md = adfToMarkdown({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'As a customer I want coupons.' }] },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AC1: SAVE10 takes 10% off' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Codes are not case-sensitive' }] }] }] },
  ] });
  const a = splitCriteria(md);
  assert.equal(a.description, 'As a customer I want coupons.');
  assert.deepEqual(a.criteria, ['SAVE10 takes 10% off', 'Codes are not case-sensitive']);
  const g = splitCriteria('Guest checkout.\n### Acceptance Criteria\nScenario: guest pays\nGiven a cart\nWhen they continue as guest\nThen the payment page asks for an email\nScenario: guest sees total\nGiven a cart\nThen the total is shown');
  assert.equal(g.criteria.length, 2);
  assert.match(g.criteria[0], /^guest pays: Given a cart, When they continue as guest, Then the payment page/);
  assert.deepEqual(splitCriteria('Plain story.', '- One\n- Two').criteria, ['One', 'Two']);
  assert.match(wikiToMarkdown('h3. Acceptance criteria\n* First\n** Nested'), /##### Acceptance criteria\n- First\n {2}- Nested/);
});

test('Jira issues import as requirements (Cloud with paging, and Data Center)', async () => {
  const page = (issues: unknown[], next?: string) => JSON.stringify({ issues, ...(next ? { nextPageToken: next } : { isLast: true }) });
  const story = (key: string, summary: string, desc: unknown, component = 'Wishlist') => ({ key, fields: { summary, description: desc, issuetype: { name: 'Story' }, status: { name: 'To Do' }, components: [{ name: component }] } });
  const adf = (text: string, acs: string[]) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Acceptance criteria' }] }, { type: 'bulletList', content: acs.map((t) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })) }] });
  const jira = await fakeServer((req, _b, res) => {
    const u = new URL(req.url ?? '', 'http://x');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (u.pathname === '/rest/api/3/search/jql') {
      res.end(u.searchParams.get('nextPageToken') ? page([story('SHOP-3', 'Faster search', null, 'Search')]) : page([story('SHOP-1', 'Save for later', adf('Keep products.', ['Save adds it to My wishlist', 'The wishlist shows the price'])), story('SHOP-2', 'Remove saved product', adf('Tidy up.', ['Remove takes it off']))], 't2'));
    } else if (u.pathname === '/rest/api/2/search') {
      res.end(JSON.stringify({ total: 1, issues: [story('DC-9', 'Wiki story', 'Intro\nh3. Acceptance criteria\n* Works in Data Center', 'Legacy')] }));
    } else res.end('{}');
  });
  try {
    const dir = project({ jira: { baseUrl: jira.url, projectKey: 'SHOP' } }, 'JIRA_EMAIL=qa@example.test\nJIRA_API_TOKEN=t0k3n\n');
    const r = await importJiraRequirements(loadProject(dir));
    assert.equal(r.issues, 3);
    assert.equal(r.withCriteria, 2);
    assert.equal(r.file, 'jira/shop.md');
    const reqs = loadRequirements(loadProject(dir));
    assert.deepEqual(reqs.map((q) => `${q.id}:${q.criteria.length}:${q.feature}`), ['SHOP-1:2:Wishlist', 'SHOP-2:1:Wishlist', 'SHOP-3:0:Search']);
    assert.match(jira.requests[0].url, /jql=project%20%3D%20%22SHOP%22/);
    assert.match(String(jira.requests[0].headers.authorization), /^Basic /);
    const text = fs.readFileSync(path.join(dir, 'requirements', 'jira', 'shop.md'), 'utf8');
    assert.match(text, /^<!-- Synced from Jira/);
    assert.match(text, new RegExp(`\\(Jira: ${jira.url.replace(/[.]/g, '\\.')}/browse/SHOP-1 · Story · To Do\\)`));

    const dc = project({ jira: { baseUrl: jira.url, projectKey: 'DC', auth: 'bearer' } }, 'JIRA_API_TOKEN=pat\n');
    const r2 = await importJiraRequirements(loadProject(dc), { jql: 'project = DC' });
    assert.equal(r2.issues, 1);
    assert.equal(loadRequirements(loadProject(dc))[0].criteria[0].text, 'Works in Data Center');
    assert.match(String(jira.requests.at(-1)!.headers.authorization), /^Bearer pat$/);
  } finally {
    jira.close();
  }
});

test('flows found while exploring become E2E requirements', async () => {
  const dir = project();
  const p = loadProject(dir);
  const a = await addDiscoveredFlow(p, { title: 'Search by part of a name', description: 'A shopper searches.', criteria: ['Searching "head" lists Wireless Headphones', 'The result links to the product page'] });
  const b = await addDiscoveredFlow(p, { title: 'Add to cart', criteria: ['The cart badge shows 1'] });
  assert.equal(a.id, 'E2E-001');
  assert.equal(b.id, 'E2E-002');
  assert.equal(a.feature, 'Discovered flows');
  assert.deepEqual(loadRequirements(p).map((r) => r.id), ['E2E-001', 'E2E-002']);
  await assert.rejects(addDiscoveredFlow(p, { title: 'x', criteria: [] }), /at least one criterion/);
  const t = tasks.exploreApp({ area: '/cart', writeTests: true, maxFlows: 3 });
  assert.match(t, /startPath "\/cart"/);
  assert.match(t, /Pick the 3 most important flows/);
  assert.match(t, /save_discovered_flow/);
  assert.doesNotMatch(tasks.exploreApp({}), /save_discovered_flow/);
});

test('Ollama: a full tool-use loop over its native API, with the context length set and no cost', async () => {
  let turn = 0;
  const ollama = await fakeServer((req, _b, res) => {
    const u = new URL(req.url ?? '', 'http://x');
    if (u.pathname === '/api/chat') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      turn++;
      if (turn === 1) {
        res.write(JSON.stringify({ model: 'qwen3', message: { role: 'assistant', content: 'Checking. ' }, done: false }) + '\n');
        res.write(JSON.stringify({ model: 'qwen3', message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_tests', arguments: { requirementId: 'REQ-1' } } }] }, done: false }) + '\n');
        res.end(JSON.stringify({ model: 'qwen3', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 900, eval_count: 40 }) + '\n');
      } else {
        res.write(JSON.stringify({ model: 'qwen3', message: { role: 'assistant', content: 'REQ-1 has no tests.' }, done: false }) + '\n');
        res.end(JSON.stringify({ model: 'qwen3', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 1000, eval_count: 10 }));
      }
    } else if (u.pathname === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'tiny:1b', details: { parameter_size: '1B' } }, { name: 'qwen3:8b', details: { parameter_size: '8.2B' } }] }));
    } else if (u.pathname === '/api/show') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const tools = req.headers['content-length'] && _b.includes('qwen3');
      res.end(JSON.stringify({ capabilities: tools ? ['completion', 'tools'] : ['completion'], model_info: { 'qwen3.context_length': 40960 } }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const dir = project({ ai: { provider: 'ollama', maxTurns: 5, ollama: { model: 'qwen3', baseUrl: ollama.url, contextLength: 40000 } } });
    const r = await runAgent(loadProject(dir), { task: 'What tests does REQ-1 have?' });
    assert.equal(r.finalText, 'REQ-1 has no tests.');
    assert.equal(r.toolCalls, 1);
    assert.equal(r.usage.costUsd, 0, 'local models cost nothing');
    const first = JSON.parse(ollama.requests[0].body);
    assert.equal(first.options.num_ctx, 40000);
    assert.ok(first.tools.some((t: { function: { name: string } }) => t.function.name === 'run_tests'));
    const second = JSON.parse(ollama.requests[1].body);
    const assistant = second.messages.find((m: { role: string }) => m.role === 'assistant');
    assert.deepEqual(assistant.tool_calls[0].function, { name: 'list_tests', arguments: { requirementId: 'REQ-1' } });
    const tool = second.messages.find((m: { role: string }) => m.role === 'tool');
    assert.equal(tool.tool_name, 'list_tests');
    assert.equal(tool.content, 'No tests saved.');

    const models = await listOllamaModels(ollama.url);
    assert.deepEqual(models.map((m) => [m.id, m.tools]), [['qwen3:8b', true], ['tiny:1b', false]], 'tool-capable models first');
    assert.equal(models[0].context, 40960);
  } finally {
    ollama.close();
  }
  // Nothing listening: a clear message, not "fetch failed".
  const closed = await fakeServer(() => {});
  closed.close();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(new OllamaModel({ model: 'qwen3', baseUrl: closed.url, contextLength: 32768 }).next({ system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }] }), /Can't reach Ollama at http:\/\/127\.0\.0\.1:\d+\. Start Ollama/);
  assert.throws(() => new OllamaModel({ model: '', baseUrl: 'http://localhost:11434', contextLength: 32768 }), /Pick an Ollama model/);
});

test('LM Studio: streamed tool calls over its OpenAI-compatible server, free', async () => {
  let turn = 0;
  const lms = await fakeServer((_req, _b, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    turn++;
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (turn === 1) {
      send({ model: 'qwen2.5-7b-instruct', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_tests', arguments: '' } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"requirementId":' } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"REQ-2"}' } }] }, finish_reason: 'tool_calls' }] });
      send({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 20 } });
    } else {
      send({ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] });
    }
    res.end('data: [DONE]\n\n');
  });
  try {
    const dir = project({ ai: { provider: 'lmstudio', maxTurns: 5, lmstudio: { model: 'qwen2.5-7b-instruct', baseUrl: `${lms.url}/v1` } } }, 'LMSTUDIO_API_KEY=lm-key\n');
    const r = await runAgent(loadProject(dir), { task: 'List tests for REQ-2' });
    assert.equal(r.finalText, 'Done.');
    assert.equal(r.toolCalls, 1);
    assert.equal(r.usage.costUsd, 0);
    assert.equal(lms.requests[0].url, '/v1/chat/completions');
    assert.equal(lms.requests[0].headers.authorization, 'Bearer lm-key');
    const body = JSON.parse(lms.requests[0].body);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(body.reasoning, undefined, 'no OpenRouter-only fields');
  } finally {
    lms.close();
  }
});

test('reading a document with AI saves what it understood; the document is untouched', async () => {
  const dir = project();
  const p = loadProject(dir);
  fs.mkdirSync(path.join(dir, 'requirements'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'requirements', 'shop.md'), '## REQ-004 Cart\n- shows items\n');
  const brief = makeDocx([['p', 'Loyalty. Members get points. FR-9 says 100 points give a $5 discount.']]);
  const up = await importDocument(p, 'loyalty.docx', brief);
  let seen = '';
  const model: ModelClient = {
    async next({ system, messages, tools }) {
      seen = `${system}\n${JSON.stringify(messages)}`;
      assert.equal(tools.length, 0);
      return { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 200 },
        content: [{ type: 'text', text: '```json\n{"requirements":[{"id":"FR-9","feature":"Loyalty","title":"Spend points","criteria":["100 points give a $5 discount at checkout"]},{"id":"FR-77","title":"Earn points","criteria":["A purchase adds points to the account"]}]}\n```' }] } as unknown as Anthropic.Beta.BetaMessage;
    },
  };
  const r = await readDocumentWithAI(loadProject(dir), up.file, { model });
  assert.equal(r.requirements, 2);
  assert.match(seen, /never invent IDs/);
  assert.match(seen, /100 points give a \$5 discount/, 'the document text is sent');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'requirements', 'loyalty.docx')), brief, 'the document is not changed');
  let reqs = loadRequirements(loadProject(dir)).filter((q) => q.source.file.endsWith('loyalty.docx'));
  assert.equal(reqs[0].id, 'FR-9', 'an ID that is in the document is kept');
  assert.ok(reqs[1].autoId && reqs[1].id !== 'FR-77', 'an ID the AI made up is not used');
  assert.ok(reqs.every((q) => q.source.mode === 'ai'));
  assert.ok(!reqs.some((q) => q.id === 'REQ-004'));
  // The document changes: back to the automatic reading, and the AI reading is marked stale.
  fs.writeFileSync(path.join(dir, 'requirements', 'loyalty.docx'), makeDocx([['p', 'Members can spend points at checkout.']]));
  const again = await importRequirements(loadProject(dir));
  const doc = again.documents.find((d) => d.file === 'loyalty.docx')!;
  assert.equal(doc.mode, 'free-form');
  assert.equal(doc.reading?.stale, true);
  reqs = loadRequirements(loadProject(dir)).filter((q) => q.source.file.endsWith('loyalty.docx'));
  assert.equal(reqs[0].source.mode, 'free-form');
});

test('dashboard: document upload, model lists only for the page, local AI needs no billing confirm', async () => {
  const dir = project({ ai: { provider: 'ollama', ollama: { model: 'qwen3', baseUrl: 'http://127.0.0.1:9' } } });
  const dash = await startDashboard(dir, { port: 0 });
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const docx = makeDocx([['h2', 'REQ-70 Wishlist'], ['li', 'Save adds it to the wishlist']]);
    const up = await fetch(`${base}/api/requirement-docs?name=${encodeURIComponent('wish list.docx')}`, { method: 'POST', headers: { 'X-TraceQA': '1', 'Content-Type': 'application/octet-stream' }, body: docx });
    assert.equal(up.status, 200);
    const r = await up.json();
    assert.equal(r.requirements, 1);
    assert.equal(r.file, 'wish list.docx', 'saved as it is');
    assert.equal((await fetch(`${base}/api/requirement-docs?name=x.docx`, { method: 'POST', body: docx })).status, 403, 'needs the dashboard header');
    const files = await (await fetch(`${base}/api/requirement-files`)).json();
    assert.equal(files.files[0].type, 'Word');

    assert.equal((await fetch(`${base}/api/ai-models?provider=ollama&baseUrl=http://169.254.169.254`)).status, 403, 'a page elsewhere cannot make TraceQA call other addresses');
    const unreachable = await fetch(`${base}/api/ai-models?provider=ollama`, { headers: { 'X-TraceQA': '1' } });
    assert.equal(unreachable.status, 500);
    assert.match((await unreachable.json()).error, /Can't reach Ollama/);

    const job = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'X-TraceQA': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'explore-app', area: '/' }) });
    assert.equal(job.status, 202, 'local models need no billing confirmation');
    const j = (await job.json()).job;
    await fetch(`${base}/api/jobs/${j.id}/stop`, { method: 'POST', headers: { 'X-TraceQA': '1' } });
  } finally {
    dash.close();
  }
});
