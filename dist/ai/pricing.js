// Token usage and an approximate cost for AI runs, so people can see what a run spent.
// Prices are US dollars per million tokens (list prices; cache writes use the 5-minute rate, 1.25x input).
// Unknown models show tokens only. Your Anthropic Console has the exact bill.
const PRICES = [
    { prefix: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2 },
    { prefix: 'claude-sonnet-5-5', input: 2, output: 10, cacheRead: 0.2 },
    { prefix: 'claude-fable-5-1', input: 10, output: 50, cacheRead: 0.25 },
    { prefix: 'claude-opus-5', input: 5, output: 25, cacheRead: 0.5 },
];
export function emptyUsage() {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}
/** Adds one response's usage. `model` is the model that actually answered (it can be the fallback model). */
export function addUsage(total, model, u) {
    if (!u)
        return total;
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const read = u.cache_read_input_tokens ?? 0;
    const write = u.cache_creation_input_tokens ?? 0;
    const price = PRICES.find((p) => model.startsWith(p.prefix));
    const cost = typeof u.cost === 'number'
        ? u.cost
        : price ? (input * price.input + output * price.output + read * price.cacheRead + write * price.input * 1.25) / 1_000_000 : undefined;
    return {
        inputTokens: total.inputTokens + input,
        outputTokens: total.outputTokens + output,
        cacheReadTokens: total.cacheReadTokens + read,
        cacheWriteTokens: total.cacheWriteTokens + write,
        costUsd: total.costUsd === undefined || cost === undefined ? undefined : total.costUsd + cost,
    };
}
export function formatUsage(u) {
    const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
    return `${k(tokens)} tokens (${k(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens)} in, ${k(u.outputTokens)} out)${u.costUsd !== undefined ? ` · about $${u.costUsd.toFixed(2)}` : ''}`;
}
//# sourceMappingURL=pricing.js.map