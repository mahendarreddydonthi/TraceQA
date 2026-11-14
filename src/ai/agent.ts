import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { activeModel, type Project } from '../core/config.js';
import { AGENT_GUIDE } from '../core/init.js';
import { ExploreSession } from '../core/explorer.js';
import { buildTools, toJsonSchema, type ToolDef } from '../tools/registry.js';
import { StoppedError, throwIfStopped } from '../core/proc.js';
import { loadRequirements } from '../core/requirements.js';
import { computeCoverage } from '../core/coverage.js';
import { addUsage, emptyUsage, type Usage } from './pricing.js';
import { OpenRouterModel, ProviderError } from './openrouter.js';
import { LmStudioModel, OllamaModel } from './local.js';

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type Tool = Anthropic.Beta.BetaTool;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

/** One model turn. The real implementation calls Claude; tests pass a scripted fake. */
export interface ModelClient {
  next(request: { system: string; tools: Tool[]; messages: MessageParam[]; signal?: AbortSignal }): Promise<Message>;
}

/** Calls Claude through the official SDK: streaming, adaptive thinking, prompt caching and server-side refusal fallback. */
export class ClaudeModel implements ModelClient {
  private client: Anthropic;

  constructor(
    private settings: { model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' },
    apiKey?: string,
  ) {
    // Without an explicit key the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  async next({ system, tools, messages, signal }: { system: string; tools: Tool[]; messages: MessageParam[]; signal?: AbortSignal }): Promise<Message> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.settings.model,
        max_tokens: 64000,
        system,
        ...(tools.length ? { tools } : {}),
        messages,
        output_config: { effort: this.settings.effort },
        cache_control: { type: 'ephemeral' },
        // If the model declines for policy reasons, the API retries on its default fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal },
    );
    return stream.finalMessage();
  }
}

/** The model client for the provider chosen in traceqa.config.json (ai.provider). */
export function createModel(project: Project): ModelClient {
  const ai = project.config.ai;
  if (ai.provider === 'openrouter') return new OpenRouterModel({ ...ai.openrouter, effort: ai.effort }, project.env.OPENROUTER_API_KEY ?? '');
  if (ai.provider === 'ollama') return new OllamaModel(ai.ollama);
  if (ai.provider === 'lmstudio') return new LmStudioModel(ai.lmstudio, project.env.LMSTUDIO_API_KEY ?? '');
  return new ClaudeModel(ai, project.env.ANTHROPIC_API_KEY || undefined);
}

/**
 * Lets tests and harnesses swap the model without changing callers (the dashboard and CLI use runAgent's default).
 * Not a configuration option: the provider is always chosen in traceqa.config.json.
 */
export const modelFactory = { create: createModel };

/** What the agent is doing, for live progress. Emitted in order while the run is in flight. */
export type AgentEvent =
  | { type: 'turn'; n: number }
  | { type: 'text'; text: string }
  | { type: 'tool-start'; name: string; input: Record<string, unknown> }
  | { type: 'tool-done'; name: string; input: Record<string, unknown>; output: string }
  | { type: 'tool-error'; name: string; input: Record<string, unknown>; error: string };

export interface AgentRun {
  finalText: string;
  turns: number;
  toolCalls: number;
  stopReason: string;
  usage: Usage;
}

export interface AgentOptions {
  task: string;
  /** Limit the tools offered (by name). Human-only tools are never offered. */
  allowTools?: string[];
  maxTurns?: number;
  model?: ModelClient;
  log?: (line: string) => void;
  /** Stops the run between turns and cancels the request in flight. */
  signal?: AbortSignal;
  /** Called after every model turn with the running total. */
  onUsage?: (usage: Usage) => void;
  /** Live progress: turns, the agent's own notes and every tool call. */
  onEvent?: (event: AgentEvent) => void;
}

const UNATTENDED = `
You are running unattended from the TraceQA command line. Nobody is available to answer questions during the run.
- If a requirement is unclear, do not guess: skip it and list it in your final summary.
- You cannot approve, discard, file or delete anything; those decisions belong to a person.
- Work through the task with the tools, then end with a short plain-text summary: what you did, the results, draft bugs created, and anything you skipped and why.`;

function short(value: unknown, max = 140): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The tool-use loop: ask Claude, run the tools it calls (in order, validated), send results back, repeat. */
export async function runAgent(project: Project, opts: AgentOptions): Promise<AgentRun> {
  const log = opts.log ?? (() => {});
  const tools = buildTools(project.dir, { signal: opts.signal }).filter((t) => !t.humanOnly && (!opts.allowTools || opts.allowTools.includes(t.name)));
  const byName = new Map<string, ToolDef>(tools.map((t) => [t.name, t]));
  const apiTools: Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: toJsonSchema(t) as Tool['input_schema'],
    eager_input_streaming: true,
  }));
  const model = opts.model ?? modelFactory.create(project);
  const emit = (e: AgentEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      // A progress display must never break a run.
    }
  };
  const modelName = activeModel(project.config.ai).model;
  const system = `${AGENT_GUIDE}\n${UNATTENDED}`;
  const messages: MessageParam[] = [{ role: 'user', content: opts.task }];
  const maxTurns = opts.maxTurns ?? project.config.ai.maxTurns;

  let turns = 0;
  let toolCalls = 0;
  let jsonRetries = 0;
  let usage = emptyUsage();
  try {
    while (turns < maxTurns) {
      throwIfStopped(opts.signal);
      turns++;
      emit({ type: 'turn', n: turns });
      let message: Message;
      try {
        message = await model.next({ system, tools: apiTools, messages, signal: opts.signal });
        jsonRetries = 0;
      } catch (err) {
        if (opts.signal?.aborted) throw new StoppedError();
        if (err instanceof Anthropic.AuthenticationError) {
          throw new Error('The Anthropic API key was rejected (401). Check ANTHROPIC_API_KEY in the project .env, or in the dashboard under Settings → AI agent.');
        }
        if (err instanceof Anthropic.PermissionDeniedError) {
          throw new Error(`The Anthropic API key is not allowed to use ${modelName} (403). Pick another model in Settings, or check the key's workspace.`);
        }
        // With eager input streaming the SDK rejects a turn whose tool input is not parseable JSON; retry that turn only.
        if (err instanceof Anthropic.APIError || err instanceof ProviderError || err instanceof StoppedError || jsonRetries++ >= 2) throw err;
        log('  (tool input was not valid JSON; asking again)');
        continue;
      }
      usage = addUsage(usage, message.model ?? modelName, message.usage);
      opts.onUsage?.(usage);

      const text = message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (message.stop_reason === 'refusal') {
        return { finalText: text || 'The model declined this request.', turns, toolCalls, stopReason: 'refusal', usage };
      }
      if (message.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: message.content });
        continue;
      }
      const uses = message.content.filter((b): b is ToolUse => b.type === 'tool_use');
      if (!uses.length) return { finalText: text, turns, toolCalls, stopReason: message.stop_reason ?? 'end_turn', usage };
      if (message.stop_reason === 'max_tokens') throw new Error('A tool call was cut off at max_tokens; the run stopped instead of using a truncated input.');
      if (text) {
        log(`  ${short(text.replace(/\s+/g, ' '), 200)}`);
        emit({ type: 'text', text });
      }

      messages.push({ role: 'assistant', content: message.content });
      const results: ToolResult[] = [];
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
        const input = parsed.data as Record<string, unknown>;
        emit({ type: 'tool-start', name: use.name, input });
        try {
          const out = await tool.run(parsed.data);
          log(`  ${short(out.split('\n')[0], 160)}`);
          emit({ type: 'tool-done', name: use.name, input, output: out });
          results.push({ type: 'tool_result', tool_use_id: use.id, content: out });
        } catch (err) {
          if (err instanceof StoppedError || opts.signal?.aborted) throw new StoppedError();
          const msg = err instanceof Error ? err.message : String(err);
          log(`  error: ${short(msg, 160)}`);
          emit({ type: 'tool-error', name: use.name, input, error: msg });
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Error: ${msg}` });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    return { finalText: `Stopped after ${maxTurns} turns (ai.maxTurns).`, turns, toolCalls, stopReason: 'max_turns', usage };
  } finally {
    // Never leave a browser open if the run ends mid-exploration.
    if (ExploreSession.active) await ExploreSession.active.end().catch(() => {});
  }
}

/** Tools an exploration run may use: it explores and records findings, it does not write tests. */
export const EXPLORE_TOOLS = ['status', 'get_requirement', 'get_page', 'explore_start', 'explore_action', 'explore_snapshot', 'explore_record_finding', 'explore_end'];

/** Which requirements a "write tests" run covers: named ones, every gap, or all. */
export function generateTargets(project: Project, opts: { ids?: string[]; gaps?: boolean; all?: boolean }): string[] {
  const reqs = loadRequirements(project);
  let ids = (opts.ids ?? []).map((r) => r.toUpperCase());
  if (opts.all) ids = reqs.map((r) => r.id);
  if (opts.gaps) {
    ids = [...new Set([...ids, ...computeCoverage(project).filter((c) => c.status === 'not-covered' || c.status === 'partial').map((c) => c.requirementId)])];
  }
  if (!ids.length) throw new Error(opts.gaps ? 'Every requirement already has tests for all its criteria.' : 'Name at least one requirement.');
  const known = new Set(reqs.map((r) => r.id));
  const unknown = ids.filter((i) => !known.has(i));
  if (unknown.length) throw new Error(`Unknown requirement(s): ${unknown.join(', ')}. Import requirements first.`);
  return ids;
}

/** Tools for exploring the whole app and, optionally, automating the flows it finds. */
export const AUTOMATE_TOOLS = [...EXPLORE_TOOLS, 'save_discovered_flow', 'get_requirement', 'scaffold_framework', 'save_test', 'list_tests', 'run_tests'];

export interface ExploreAppOptions {
  /** Path to start from; the whole app when empty. */
  area?: string;
  charter?: string;
  signIn?: boolean;
  headed?: boolean;
  /** Also record the main working flows as E2E requirements and write tests for them. */
  writeTests?: boolean;
  /** At most this many flows. Empty: every important working flow the exploration finds. */
  maxFlows?: number;
}

/** A flow limit from a form or a flag: a whole number from 1 to 100, or nothing for no limit. */
export function parseMaxFlows(value: unknown): number | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw Object.assign(new Error('Flows to automate must be a whole number from 1 to 100, or empty to automate every flow found.'), { status: 400 });
  }
  return n;
}

/** Ready-made tasks for the CLI commands and dashboard buttons. */
export const tasks = {
  exploreApp: (o: ExploreAppOptions) => {
    const flows = o.maxFlows;
    return [
      `Explore the app${o.area && o.area !== '/' ? ` starting at ${o.area} and the pages around it` : ''} like an experienced exploratory tester. There is no requirement for this session${o.charter ? `; focus on: ${o.charter}` : ''}.`,
      '1. Call status, then get_page without arguments to see the pages TraceQA already knows.',
      `2. explore_start with a charter that describes this session, startPath "${o.area || '/'}"${o.signIn ? ', signIn: true' : ''}${o.headed ? ', headed: true' : ''}. Sign in with sign_in when a flow needs an account.`,
      '3. Visit the main pages and user flows: navigation, search, forms, cart and checkout, account. Try edge cases: empty, invalid and very long input, special characters, going back, repeating actions. Watch the console errors and failed requests in each snapshot.',
      '4. Record every real problem with explore_record_finding (no requirementId): broken behaviour, errors, wrong totals or messages, dead links, accessibility blockers. Do not record things that are only matters of taste.',
      '5. explore_end.',
      ...(o.writeTests
        ? [
            `6. ${
              flows
                ? `Pick the ${flows} most important flows that work correctly today (fewer if you found fewer).`
                : 'Automate every distinct flow you found that works correctly today. There is no fixed number: skip near-duplicates and broken flows, and do the most important ones first so they are done if the run stops early.'
            } For each: save_discovered_flow with what a user does and exactly what they should see (one criterion per observable outcome), then save_test once per criterion with requirementId set to the E2E ID it returns, using locators from your session. If the framework is not installed yet, call scaffold_framework first.`,
            '7. run_tests for each E2E requirement you created.',
          ]
        : []),
      `Finish with a short summary: pages visited, bugs recorded (with their BUG IDs)${o.writeTests ? ', flows automated (with their E2E IDs) and test results' : ''}, and anything you could not reach.`,
    ].join('\n');
  },
  explore: (reqId: string, charter?: string) =>
    `Explore requirement ${reqId} in the browser${charter ? ` with this charter: ${charter}` : ''}. ` +
    'Call get_requirement first. Use explore_start (sign in when the flow needs an account), try each acceptance criterion including edge cases, ' +
    'record every real problem with explore_record_finding, then explore_end. Do not write tests in this run.',
  generate: (reqIds: string[]) =>
    `Write tests for ${reqIds.join(', ')}. For each requirement: get_requirement, explore it if you need to learn the flow or locators, ` +
    'then save_test once per acceptance criterion that has no test yet. Skip criteria that are unclear or cannot be checked in a browser and say why. ' +
    `Finish with run_tests for each requirement and report the results.`,
  heal: (testIds: string[]) =>
    `These tests still fail because they cannot find or use an element (test-broken), even after automatic healing: ${testIds.join(', ')}. ` +
    'For each: list_tests / get_requirement to see it, explore the page to find the element as it is now, and save_test again with corrected locators or steps. ' +
    'Never weaken or remove an assertion. Then run_tests for the affected requirements.',
};
