import type Anthropic from '@anthropic-ai/sdk';
import type { TraceQAConfig } from '../core/config.js';
import { StoppedError } from '../core/proc.js';
import type { ModelClient } from './agent.js';

// OpenRouter as an AI provider for TraceQA's agent, over its OpenAI-compatible chat completions API
// (https://openrouter.ai/docs). The agent loop keeps its conversation in the Claude Messages format;
// this client translates each turn to chat completions and the streamed answer back.

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type Tool = Anthropic.Beta.BetaTool;

/** An error from OpenRouter itself (not a bad tool input), with a message a person can act on. */
export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Reasoning returned by the model. It must go back unchanged with the assistant turn during tool use. */
export interface ReasoningDetail {
  type: string;
  index?: number;
  text?: string;
  summary?: string;
  data?: string;
  signature?: string;
  [key: string]: unknown;
}

/** Content block that carries OpenRouter reasoning inside the agent's Claude-format history. */
export interface ReasoningBlock {
  type: 'openrouter_reasoning';
  details: ReasoningDetail[];
}

type ChatMessage =
  | { role: 'system'; content: string | { type: 'text'; text: string }[] }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[]; reasoning_details?: ReasoningDetail[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OpenRouterSettings = TraceQAConfig['ai']['openrouter'] & { effort: TraceQAConfig['ai']['effort'] };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).filter(Boolean).join('\n');
  }
  return '';
}

/** Claude-format history → chat completions messages. */
export function toChatMessages(system: string, messages: MessageParam[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content });
      continue;
    }
    const blocks = m.content as unknown as { type: string; [k: string]: unknown }[];
    if (m.role === 'user') {
      // Tool results must come straight after the assistant turn that asked for them.
      for (const b of blocks.filter((x) => x.type === 'tool_result')) {
        const body = textOf(b.content);
        out.push({ role: 'tool', tool_call_id: String(b.tool_use_id), content: b.is_error ? `Error: ${body.replace(/^Error:\s*/, '')}` : body });
      }
      const text = blocks.filter((x) => x.type === 'text').map((x) => String(x.text)).join('\n');
      if (text) out.push({ role: 'user', content: text });
      continue;
    }
    const text = blocks.filter((x) => x.type === 'text').map((x) => String(x.text)).join('\n');
    const calls: ChatToolCall[] = blocks
      .filter((x) => x.type === 'tool_use')
      .map((x) => ({ id: String(x.id), type: 'function', function: { name: String(x.name), arguments: typeof x.input === 'string' ? x.input : JSON.stringify(x.input ?? {}) } }));
    const reasoning = blocks.filter((x) => x.type === 'openrouter_reasoning').flatMap((x) => (x as unknown as ReasoningBlock).details);
    out.push({
      role: 'assistant',
      content: text || null,
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(reasoning.length ? { reasoning_details: reasoning } : {}),
    });
  }
  return out;
}

export function toChatTools(tools: Tool[]) {
  return tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description ?? '', parameters: t.input_schema } }));
}

/** The request body sent to OpenRouter. Exported for tests. */
export function buildRequest(settings: OpenRouterSettings, system: string, tools: Tool[], messages: MessageParam[]) {
  const isClaude = /^~?anthropic\//.test(settings.model);
  return {
    model: settings.model,
    messages: toChatMessages(system, messages),
    tools: toChatTools(tools),
    tool_choice: 'auto',
    stream: true,
    reasoning: { effort: settings.effort },
    // Claude needs room for its reasoning plus the answer; other models keep their own default limit.
    ...(isClaude ? { max_tokens: 64000, cache_control: { type: 'ephemeral' } } : {}),
    // OpenRouter already sends requests with tools only to providers that support tool calling.
    provider: {
      data_collection: settings.dataCollection,
      ...(settings.zdr ? { zdr: true } : {}),
    },
  };
}

/** Merges streamed reasoning pieces by index, the way the model produced them. */
export function mergeReasoning(target: ReasoningDetail[], pieces: ReasoningDetail[]): void {
  for (const p of pieces) {
    const i = typeof p.index === 'number' ? p.index : target.length;
    const cur = target.find((d) => (d.index ?? -1) === i);
    if (!cur) {
      target.push({ ...p, index: i });
      continue;
    }
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || v === null || k === 'index') continue;
      if ((k === 'text' || k === 'summary' || k === 'data') && typeof v === 'string') cur[k] = `${(cur[k] as string | undefined) ?? ''}${v}`;
      else cur[k] = v;
    }
  }
}

const STOP_REASONS: Record<string, Message['stop_reason']> = {
  tool_calls: 'tool_use',
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'refusal',
};

interface StreamState {
  model: string;
  text: string;
  calls: Map<number, { id: string; name: string; args: string }>;
  reasoning: ReasoningDetail[];
  finish?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

function applyChunk(state: StreamState, chunk: Record<string, unknown>): void {
  if (chunk.error) {
    const e = chunk.error as { message?: string; code?: number };
    throw new ProviderError(`OpenRouter stopped mid-answer: ${e.message ?? 'unknown error'}`, e.code);
  }
  if (typeof chunk.model === 'string') state.model = chunk.model;
  if (chunk.usage) state.usage = chunk.usage as StreamState['usage'];
  const choice = (chunk.choices as { delta?: Record<string, unknown>; finish_reason?: string | null; error?: { message?: string } }[] | undefined)?.[0];
  if (!choice) return;
  if (choice.error) throw new ProviderError(`OpenRouter stopped mid-answer: ${choice.error.message ?? 'unknown error'}`);
  const d = choice.delta ?? {};
  if (typeof d.content === 'string') state.text += d.content;
  if (Array.isArray(d.reasoning_details)) mergeReasoning(state.reasoning, d.reasoning_details as ReasoningDetail[]);
  for (const tc of (d.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] | undefined) ?? []) {
    const i = tc.index ?? 0;
    const cur = state.calls.get(i) ?? { id: '', name: '', args: '' };
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.name += tc.function.name;
    if (tc.function?.arguments) cur.args += tc.function.arguments;
    state.calls.set(i, cur);
  }
  if (choice.finish_reason) state.finish = choice.finish_reason;
}

/** Streamed chunks → one Claude-format message, so the agent loop works the same for every provider. */
export function toMessage(state: StreamState): Message {
  const content: unknown[] = [];
  if (state.reasoning.length) content.push({ type: 'openrouter_reasoning', details: state.reasoning } satisfies ReasoningBlock);
  if (state.text.trim()) content.push({ type: 'text', text: state.text, citations: null });
  const calls = [...state.calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  calls.forEach((c, n) => {
    let input: unknown;
    try {
      input = c.args.trim() ? JSON.parse(c.args) : {};
    } catch {
      input = c.args; // not JSON: the agent loop rejects it and tells the model
    }
    content.push({ type: 'tool_use', id: c.id || `call_${n}`, name: c.name, input });
  });
  const u = state.usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const written = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  const stop = calls.length ? 'tool_use' : (STOP_REASONS[state.finish ?? 'stop'] ?? 'end_turn');
  return {
    id: 'openrouter',
    type: 'message',
    role: 'assistant',
    model: state.model,
    content,
    stop_reason: stop === 'tool_use' && state.finish === 'length' ? 'max_tokens' : stop,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, (u.prompt_tokens ?? 0) - cached - written),
      output_tokens: u.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: written,
      cost: typeof u.cost === 'number' ? u.cost : undefined,
    },
  } as unknown as Message;
}

function friendly(status: number, message: string, settings: OpenRouterSettings): string {
  if (status === 401) return 'The OpenRouter API key was rejected (401). Check OPENROUTER_API_KEY in the project .env, or in the dashboard under Settings → AI agent.';
  if (status === 402) return 'Your OpenRouter account has no credits left (402). Add credits at openrouter.ai, then try again.';
  if (status === 404 && /endpoint|data policy|privacy|zdr/i.test(message)) {
    return `OpenRouter found no provider for ${settings.model} that matches your settings (${message}). Try another model, or allow data collection / turn off "Zero Data Retention only" under Settings → AI agent.`;
  }
  if (status === 400 && /not a valid model|model.*not found|invalid model/i.test(message)) return `OpenRouter does not know the model "${settings.model}". Pick one from the list under Settings → AI agent.`;
  return `OpenRouter request failed (${status}): ${message}`;
}

const RETRY = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new StoppedError()); }, { once: true });
  });
}

/** Calls OpenRouter's chat completions API with streaming, tool calling, reasoning and privacy routing. */
export class OpenRouterModel implements ModelClient {
  constructor(
    private settings: OpenRouterSettings,
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    if (!apiKey) throw new ProviderError('Set OPENROUTER_API_KEY in the project .env (or under Settings → AI agent in the dashboard) to use OpenRouter.');
  }

  async next({ system, tools, messages, signal }: { system: string; tools: Tool[]; messages: MessageParam[]; signal?: AbortSignal }): Promise<Message> {
    const body = JSON.stringify(buildRequest(this.settings, system, tools, messages));
    const url = `${this.settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'X-Title': 'TraceQA',
        },
        body,
        signal,
      });
      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        let message = raw.slice(0, 400);
        try {
          message = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? message;
        } catch {
          // not JSON
        }
        if (RETRY.has(res.status) && attempt < 2) {
          await sleep(attempt === 0 ? 1500 : 4000, signal);
          continue;
        }
        throw new ProviderError(friendly(res.status, message, this.settings), res.status);
      }
      return this.read(res);
    }
  }

  private async read(res: Response): Promise<Message> {
    const state: StreamState = { model: this.settings.model, text: '', calls: new Map(), reasoning: [] };
    if (!res.body) throw new ProviderError('OpenRouter returned an empty response.');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    while (!done) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue; // ": OPENROUTER PROCESSING" keep-alives and blank lines
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          done = true;
          break;
        }
        try {
          applyChunk(state, JSON.parse(payload));
        } catch (err) {
          if (err instanceof ProviderError) throw err;
          // A malformed chunk: skip it rather than fail the whole turn.
        }
      }
    }
    await reader.cancel().catch(() => {});
    return toMessage(state);
  }
}

/** Tool-capable models from OpenRouter's public model list, for the settings page. */
export async function listOpenRouterModels(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<{ id: string; name: string; input: number; output: number; context: number }[]> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new ProviderError(`Could not load OpenRouter models (${res.status}).`, res.status);
  const json = (await res.json()) as { data?: { id: string; name?: string; context_length?: number; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[] }[] };
  return (json.data ?? [])
    .filter((m) => (m.supported_parameters ?? []).includes('tools') && !m.id.includes(':batch'))
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      input: Number(m.pricing?.prompt ?? 0) * 1_000_000,
      output: Number(m.pricing?.completion ?? 0) * 1_000_000,
      context: m.context_length ?? 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
