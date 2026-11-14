import type Anthropic from '@anthropic-ai/sdk';
import type { TraceQAConfig } from '../core/config.js';
import type { ModelClient } from './agent.js';
import {
  addToolCalls, errorText, newStreamState, ProviderError, sleep, streamChatCompletions, toChatMessages, toChatTools, toMessage, unreachable,
} from './openrouter.js';

// Local models: Ollama (native /api/chat, so TraceQA can set the context length) and LM Studio
// (its OpenAI-compatible server). Nothing leaves the computer and there is no cost.

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type Tool = Anthropic.Beta.BetaTool;

export type OllamaSettings = TraceQAConfig['ai']['ollama'];
export type LmStudioSettings = TraceQAConfig['ai']['lmstudio'];

const free = (m: Message): Message => {
  (m.usage as unknown as { cost: number }).cost = 0;
  return m;
};

// ---------- Ollama ----------

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

/** Claude-format history → Ollama chat messages. Tool results carry the tool's name, as Ollama expects. */
export function toOllamaMessages(system: string, messages: MessageParam[]): OllamaMessage[] {
  const names = new Map<string, string>();
  const out: OllamaMessage[] = [];
  for (const m of toChatMessages(system, messages)) {
    if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map((c) => {
        names.set(c.id, c.function.name);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.function.arguments || '{}');
        } catch {
          args = {};
        }
        return { function: { name: c.function.name, arguments: args } };
      });
      out.push({ role: 'assistant', content: m.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_name: names.get(m.tool_call_id) ?? '' });
    } else {
      out.push({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map((p) => p.text).join('\n') });
    }
  }
  return out;
}

export function buildOllamaRequest(settings: OllamaSettings, system: string, tools: Tool[], messages: MessageParam[]) {
  return {
    model: settings.model,
    messages: toOllamaMessages(system, messages),
    ...(tools.length ? { tools: toChatTools(tools) } : {}),
    stream: true,
    // Ollama's default context is too small for TraceQA's tools and page snapshots.
    options: { num_ctx: settings.contextLength },
  };
}

function explainOllama(status: number, message: string, model: string): string {
  if (status === 404 || /not found|pull/i.test(message)) return `Ollama does not have the model "${model}". Run "ollama pull ${model}", or pick an installed model under Settings → AI agent.`;
  if (/does not support tools|tools are not supported/i.test(message)) return `"${model}" cannot use tools, and TraceQA's agent needs them. Pick a model with tool support under Settings → AI agent (the list marks them).`;
  return `Ollama request failed (${status}): ${message}`;
}

export class OllamaModel implements ModelClient {
  constructor(private settings: OllamaSettings, private fetchImpl: typeof fetch = fetch) {
    if (!settings.model) throw new ProviderError('Pick an Ollama model under Settings → AI agent (or ai.ollama.model in traceqa.config.json).');
  }

  async next({ system, tools, messages, signal }: { system: string; tools: Tool[]; messages: MessageParam[]; signal?: AbortSignal }): Promise<Message> {
    const url = `${this.settings.baseUrl.replace(/\/+$/, '')}/api/chat`;
    const body = JSON.stringify(buildOllamaRequest(this.settings, system, tools, messages));
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
      } catch (err) {
        throw unreachable(err, 'Ollama', url, 'Start Ollama (the app, or "ollama serve"), or check the address under Settings → AI agent.') ?? err;
      }
      if (!res.ok) {
        const message = await errorText(res);
        if ((res.status === 503 || res.status === 429) && attempt < 2) {
          await sleep(attempt === 0 ? 1500 : 4000, signal);
          continue;
        }
        throw new ProviderError(explainOllama(res.status, message, this.settings.model), res.status);
      }
      return free(await this.read(res));
    }
  }

  private async read(res: Response): Promise<Message> {
    const state = newStreamState(this.settings.model);
    if (!res.body) throw new ProviderError('Ollama returned an empty response.');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handle = (line: string) => {
      if (!line.trim()) return;
      let chunk: {
        error?: string; model?: string; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number;
        message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: Record<string, unknown> | string } }[] };
      };
      try {
        chunk = JSON.parse(line);
      } catch {
        return;
      }
      if (chunk.error) throw new ProviderError(explainOllama(500, chunk.error, this.settings.model));
      if (chunk.model) state.model = chunk.model;
      if (chunk.message?.content) state.text += chunk.message.content;
      if (chunk.message?.tool_calls?.length) {
        // Ollama sends whole calls without an index: each one is a new call.
        for (const tc of chunk.message.tool_calls) addToolCalls(state, [{ index: state.calls.size, id: tc.id, function: tc.function }]);
      }
      if (chunk.done) {
        state.finish = chunk.done_reason === 'length' ? 'length' : 'stop';
        state.usage = { prompt_tokens: chunk.prompt_eval_count ?? 0, completion_tokens: chunk.eval_count ?? 0 };
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    handle(buffer);
    return toMessage(state);
  }
}

export interface LocalModelInfo {
  id: string;
  name: string;
  /** true = supports tool calling; false = does not; null = unknown. */
  tools: boolean | null;
  context?: number;
}

/** Installed Ollama models, with whether each can use tools and its context window. */
export async function listOllamaModels(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<LocalModelInfo[]> {
  const base = baseUrl.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/tags`);
  } catch (err) {
    throw unreachable(err, 'Ollama', base, 'Start Ollama (the app, or "ollama serve"), or check the address.') ?? err;
  }
  if (!res.ok) throw new ProviderError(`Ollama answered ${res.status} for the model list. Is ${base} an Ollama server?`, res.status);
  const tags = (await res.json()) as { models?: { name: string; details?: { parameter_size?: string } }[] };
  const models = (tags.models ?? []).slice(0, 60);
  return Promise.all(
    models.map(async (m) => {
      let tools: boolean | null = null;
      let context: number | undefined;
      try {
        const show = await fetchImpl(`${base}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: m.name }) });
        if (show.ok) {
          const info = (await show.json()) as { capabilities?: string[]; model_info?: Record<string, unknown> };
          if (Array.isArray(info.capabilities)) tools = info.capabilities.includes('tools');
          const ctx = Object.entries(info.model_info ?? {}).find(([k]) => k.endsWith('.context_length'))?.[1];
          if (typeof ctx === 'number') context = ctx;
        }
      } catch {
        // details are optional
      }
      return { id: m.name, name: `${m.name}${m.details?.parameter_size ? ` (${m.details.parameter_size})` : ''}`, tools, context };
    }),
  ).then((list) => list.sort((a, b) => Number(b.tools === true) - Number(a.tools === true) || a.id.localeCompare(b.id)));
}

// ---------- LM Studio ----------

export function buildLmStudioRequest(settings: LmStudioSettings, system: string, tools: Tool[], messages: MessageParam[]) {
  return {
    model: settings.model,
    messages: toChatMessages(system, messages),
    ...(tools.length ? { tools: toChatTools(tools), tool_choice: 'auto' } : {}),
    stream: true,
    stream_options: { include_usage: true },
  };
}

function explainLmStudio(status: number, message: string, model: string): string {
  if (status === 401 || status === 403) return 'LM Studio refused the request. If its server requires an API key, set LMSTUDIO_API_KEY under Settings → AI agent.';
  if (status === 404 || /no models? loaded|not found|does not exist/i.test(message)) return `LM Studio has no model "${model}". Load or download it in LM Studio, or pick one under Settings → AI agent.`;
  return `LM Studio request failed (${status}): ${message}`;
}

export class LmStudioModel implements ModelClient {
  constructor(private settings: LmStudioSettings, private apiKey = '', private fetchImpl: typeof fetch = fetch) {
    if (!settings.model) throw new ProviderError('Pick an LM Studio model under Settings → AI agent (or ai.lmstudio.model in traceqa.config.json).');
  }

  async next({ system, tools, messages, signal }: { system: string; tools: Tool[]; messages: MessageParam[]; signal?: AbortSignal }): Promise<Message> {
    return free(
      await streamChatCompletions({
        label: 'LM Studio',
        url: `${this.settings.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        body: buildLmStudioRequest(this.settings, system, tools, messages),
        signal,
        fetchImpl: this.fetchImpl,
        model: this.settings.model,
        explain: (status, message) => explainLmStudio(status, message, this.settings.model),
        unreachableHint: 'Start the server in LM Studio (Developer → Start server, or "lms server start"), or check the address under Settings → AI agent.',
      }),
    );
  }
}

/** Models LM Studio offers (downloaded models load on first use). */
export async function listLmStudioModels(baseUrl: string, apiKey = '', fetchImpl: typeof fetch = fetch): Promise<LocalModelInfo[]> {
  const base = baseUrl.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetchImpl(`${base}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
  } catch (err) {
    throw unreachable(err, 'LM Studio', base, 'Start the server in LM Studio (Developer → Start server, or "lms server start").') ?? err;
  }
  if (!res.ok) throw new ProviderError(explainLmStudio(res.status, await errorText(res), ''), res.status);
  const json = (await res.json()) as { data?: { id: string }[] };
  return (json.data ?? []).filter((m) => !/embed/i.test(m.id)).map((m) => ({ id: m.id, name: m.id, tools: null })).sort((a, b) => a.id.localeCompare(b.id));
}
