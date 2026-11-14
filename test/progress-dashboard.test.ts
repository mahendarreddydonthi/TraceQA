import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { modelFactory, type ModelClient } from '../src/ai/agent.js';
import { startDashboard } from '../src/ui/server.js';

const msg = (content: unknown[], stop: string) =>
  ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } }) as unknown as Anthropic.Beta.BetaMessage;

test('dashboard: explore-and-automate jobs take an optional flow count and stream live progress', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqa-prog-'));
  fs.writeFileSync(path.join(dir, 'traceqa.config.json'), JSON.stringify({ baseUrl: 'http://localhost:4173' }));
  let seenTask = '';
  const script = [
    msg([{ type: 'text', text: 'Checking what TraceQA knows first.' }, { type: 'tool_use', id: 't1', name: 'status', input: {} }], 'tool_use'),
    msg([{ type: 'tool_use', id: 't2', name: 'save_discovered_flow', input: { title: 'Search finds a product', criteria: ['Searching for "head" lists Wireless Headphones'] } }], 'tool_use'),
    msg([{ type: 'text', text: '## Summary\n- Automated **E2E-001**\n- No bugs found' }], 'end_turn'),
  ];
  const fake: ModelClient = {
    async next({ messages }) {
      if (!seenTask) seenTask = String(messages[0].content);
      return script.shift()!;
    },
  };
  const original = modelFactory.create;
  modelFactory.create = () => fake;
  const dash = await startDashboard(dir, { port: 0 });
  const base = `http://127.0.0.1:${dash.port}`;
  const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TraceQA': '1' }, body: JSON.stringify(body) });

  // Listen to the live event stream.
  const progressEvents: { id: string; progress: { activity: string; phase?: string } }[] = [];
  const req = http.get(`${base}/api/events`, (res) => {
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.startsWith('event: job-progress')) progressEvents.push(JSON.parse(block.split('\ndata: ')[1]));
      }
    });
  });
  try {
    const bad = await post('/api/jobs', { kind: 'explore-app', writeTests: true, maxFlows: 0, confirmed: true });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /whole number/);

    const started = await post('/api/jobs', { kind: 'explore-app', writeTests: true, maxFlows: '', confirmed: true });
    assert.equal(started.status, 202);
    const { job } = await started.json();
    assert.equal(job.label, 'Explore the app and automate every flow found');

    let full: { status: string; progress: { phases: { key: string; status: string }[]; counts: { flows: number }; events: { kind: string; ref?: string }[]; flowTarget: number | null; done: boolean }; result: string } | undefined;
    for (let i = 0; i < 100; i++) {
      full = (await (await fetch(`${base}/api/jobs/${job.id}`)).json()).job;
      if (full!.status !== 'running' && full!.status !== 'queued') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(full!.status, 'done', JSON.stringify(full));
    assert.match(seenTask, /Automate every distinct flow you found/);
    const p = full!.progress;
    assert.equal(p.flowTarget, null, 'no limit');
    assert.equal(p.done, true);
    assert.equal(p.counts.flows, 1);
    assert.deepEqual(p.phases.map((x) => [x.key, x.status]), [['prepare', 'done'], ['explore', 'skipped'], ['automate', 'done'], ['verify', 'skipped'], ['summary', 'done']]);
    assert.equal(p.events.find((e) => e.kind === 'flow')!.ref, 'E2E-001');
    assert.ok(p.events.some((e) => e.kind === 'note'), "the agent's own words are kept");
    assert.match(full!.result, /## Summary/);

    // The job list carries a short progress line; the stream carried every change.
    const list = (await (await fetch(`${base}/api/jobs`)).json()).jobs;
    assert.equal(list[0].progress.phaseLabel, 'Summary');
    assert.equal(list[0].progress.events, undefined, 'lists stay small');
    assert.ok(progressEvents.length >= 5);
    assert.ok(progressEvents.some((e) => e.progress.activity === 'Recording the flow “Search finds a product”…'));

    // A limit is passed to the agent and shown in the label.
    script.push(msg([{ type: 'text', text: 'Done.' }], 'end_turn'));
    seenTask = '';
    const limited = await (await post('/api/jobs', { kind: 'explore-app', writeTests: true, maxFlows: 4, confirmed: true })).json();
    assert.equal(limited.job.label, 'Explore the app and automate up to 4 flows');
    for (let i = 0; i < 100 && !seenTask; i++) await new Promise((r) => setTimeout(r, 20));
    assert.match(seenTask, /Pick the 4 most important flows/);
  } finally {
    req.destroy();
    dash.close();
    modelFactory.create = original;
  }
});
