import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { AGENT_GUIDE } from '../core/init.js';
import { ExploreSession } from '../core/explorer.js';
import { buildTools, toJsonSchema } from '../tools/registry.js';
import { StoppedError, throwIfStopped } from '../core/proc.js';
import { loadRequirements } from '../core/requirements.js';
import { computeCoverage } from '../core/coverage.js';
import { addUsage, emptyUsage } from './pricing.js';
import { OpenRouterModel, ProviderError } from './openrouter.js';
/** Calls Claude through the official SDK: streaming, adaptive thinking, prompt caching and server-side refusal fallback. */
export class ClaudeModel {
    settings;
    client;
    constructor(settings, apiKey) {
        this.settings = settings;
        // Without an explicit key the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
        this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
    }
    async next({ system, tools, messages, signal }) {
        const stream = this.client.beta.messages.stream({
            model: this.settings.model,
            max_tokens: 64000,
            system,
            tools,
            messages,
            output_config: { effort: this.settings.effort },
            cache_control: { type: 'ephemeral' },
            // If the model declines for policy reasons, the API retries on its default fallback model.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
        }, { signal });
        return stream.finalMessage();
    }
}
/** The model client for the provider chosen in traceqa.config.json (ai.provider). */
export function createModel(project) {
    const ai = project.config.ai;
    if (ai.provider === 'openrouter')
        return new OpenRouterModel({ ...ai.openrouter, effort: ai.effort }, project.env.OPENROUTER_API_KEY ?? '');
    return new ClaudeModel(ai, project.env.ANTHROPIC_API_KEY || undefined);
}
const UNATTENDED = `
You are running unattended from the TraceQA command line. Nobody is available to answer questions during the run.
- If a requirement is unclear, do not guess: skip it and list it in your final summary.
- You cannot approve, discard, file or delete anything; those decisions belong to a person.
- Work through the task with the tools, then end with a short plain-text summary: what you did, the results, draft bugs created, and anything you skipped and why.`;
function short(value, max = 140) {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
/** The tool-use loop: ask Claude, run the tools it calls (in order, validated), send results back, repeat. */
export async function runAgent(project, opts) {
    const log = opts.log ?? (() => { });
    const tools = buildTools(project.dir, { signal: opts.signal }).filter((t) => !t.humanOnly && (!opts.allowTools || opts.allowTools.includes(t.name)));
    const byName = new Map(tools.map((t) => [t.name, t]));
    const apiTools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: toJsonSchema(t),
        eager_input_streaming: true,
    }));
    const model = opts.model ?? createModel(project);
    const modelName = project.config.ai.provider === 'openrouter' ? project.config.ai.openrouter.model : project.config.ai.model;
    const system = `${AGENT_GUIDE}\n${UNATTENDED}`;
    const messages = [{ role: 'user', content: opts.task }];
    const maxTurns = opts.maxTurns ?? project.config.ai.maxTurns;
    let turns = 0;
    let toolCalls = 0;
    let jsonRetries = 0;
    let usage = emptyUsage();
    try {
        while (turns < maxTurns) {
            throwIfStopped(opts.signal);
            turns++;
            let message;
            try {
                message = await model.next({ system, tools: apiTools, messages, signal: opts.signal });
                jsonRetries = 0;
            }
            catch (err) {
                if (opts.signal?.aborted)
                    throw new StoppedError();
                if (err instanceof Anthropic.AuthenticationError) {
                    throw new Error('The Anthropic API key was rejected (401). Check ANTHROPIC_API_KEY in the project .env, or in the dashboard under Settings → AI agent.');
                }
                if (err instanceof Anthropic.PermissionDeniedError) {
                    throw new Error(`The Anthropic API key is not allowed to use ${modelName} (403). Pick another model in Settings, or check the key's workspace.`);
                }
                // With eager input streaming the SDK rejects a turn whose tool input is not parseable JSON; retry that turn only.
                if (err instanceof Anthropic.APIError || err instanceof ProviderError || err instanceof StoppedError || jsonRetries++ >= 2)
                    throw err;
                log('  (tool input was not valid JSON; asking again)');
                continue;
            }
            usage = addUsage(usage, message.model ?? modelName, message.usage);
            opts.onUsage?.(usage);
            const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
            if (message.stop_reason === 'refusal') {
                return { finalText: text || 'The model declined this request.', turns, toolCalls, stopReason: 'refusal', usage };
            }
            if (message.stop_reason === 'pause_turn') {
                messages.push({ role: 'assistant', content: message.content });
                continue;
            }
            const uses = message.content.filter((b) => b.type === 'tool_use');
            if (!uses.length)
                return { finalText: text, turns, toolCalls, stopReason: message.stop_reason ?? 'end_turn', usage };
            if (message.stop_reason === 'max_tokens')
                throw new Error('A tool call was cut off at max_tokens; the run stopped instead of using a truncated input.');
            if (text)
                log(`  ${short(text.replace(/\s+/g, ' '), 200)}`);
            messages.push({ role: 'assistant', content: message.content });
            const results = [];
            for (const use of uses) {
                toolCalls++;
                const tool = byName.get(use.name);
                if (!tool) {
                    results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Unknown or unavailable tool ${use.name}.` });
                    continue;
                }
                const parsed = z.object(tool.inputSchema).safeParse(use.input);
                if (!parsed.success) {
                    results.push({
                        type: 'tool_result',
                        tool_use_id: use.id,
                        is_error: true,
                        content: `Invalid input for ${use.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`,
                    });
                    continue;
                }
                log(`→ ${use.name} ${short(parsed.data)}`);
                try {
                    const out = await tool.run(parsed.data);
                    log(`  ${short(out.split('\n')[0], 160)}`);
                    results.push({ type: 'tool_result', tool_use_id: use.id, content: out });
                }
                catch (err) {
                    if (err instanceof StoppedError || opts.signal?.aborted)
                        throw new StoppedError();
                    const msg = err instanceof Error ? err.message : String(err);
                    log(`  error: ${short(msg, 160)}`);
                    results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Error: ${msg}` });
                }
            }
            messages.push({ role: 'user', content: results });
        }
        return { finalText: `Stopped after ${maxTurns} turns (ai.maxTurns).`, turns, toolCalls, stopReason: 'max_turns', usage };
    }
    finally {
        // Never leave a browser open if the run ends mid-exploration.
        if (ExploreSession.active)
            await ExploreSession.active.end().catch(() => { });
    }
}
/** Tools an exploration run may use: it explores and records findings, it does not write tests. */
export const EXPLORE_TOOLS = ['status', 'get_requirement', 'get_page', 'explore_start', 'explore_action', 'explore_snapshot', 'explore_record_finding', 'explore_end'];
/** Which requirements a "write tests" run covers: named ones, every gap, or all. */
export function generateTargets(project, opts) {
    const reqs = loadRequirements(project);
    let ids = (opts.ids ?? []).map((r) => r.toUpperCase());
    if (opts.all)
        ids = reqs.map((r) => r.id);
    if (opts.gaps) {
        ids = [...new Set([...ids, ...computeCoverage(project).filter((c) => c.status === 'not-covered' || c.status === 'partial').map((c) => c.requirementId)])];
    }
    if (!ids.length)
        throw new Error(opts.gaps ? 'Every requirement already has tests for all its criteria.' : 'Name at least one requirement.');
    const known = new Set(reqs.map((r) => r.id));
    const unknown = ids.filter((i) => !known.has(i));
    if (unknown.length)
        throw new Error(`Unknown requirement(s): ${unknown.join(', ')}. Import requirements first.`);
    return ids;
}
/** Ready-made tasks for the CLI commands and dashboard buttons. */
export const tasks = {
    explore: (reqId, charter) => `Explore requirement ${reqId} in the browser${charter ? ` with this charter: ${charter}` : ''}. ` +
        'Call get_requirement first. Use explore_start (sign in when the flow needs an account), try each acceptance criterion including edge cases, ' +
        'record every real problem with explore_record_finding, then explore_end. Do not write tests in this run.',
    generate: (reqIds) => `Write tests for ${reqIds.join(', ')}. For each requirement: get_requirement, explore it if you need to learn the flow or locators, ` +
        'then save_test once per acceptance criterion that has no test yet. Skip criteria that are unclear or cannot be checked in a browser and say why. ' +
        `Finish with run_tests for each requirement and report the results.`,
    heal: (testIds) => `These tests still fail because they cannot find or use an element (test-broken), even after automatic healing: ${testIds.join(', ')}. ` +
        'For each: list_tests / get_requirement to see it, explore the page to find the element as it is now, and save_test again with corrected locators or steps. ' +
        'Never weaken or remove an assertion. Then run_tests for the affected requirements.',
};
//# sourceMappingURL=agent.js.map