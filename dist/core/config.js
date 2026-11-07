import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
export const CONFIG_FILE = 'traceqa.config.json';
export const OPENROUTER_DEFAULTS = {
    model: 'anthropic/claude-opus-5.5',
    baseUrl: 'https://openrouter.ai/api/v1',
    dataCollection: 'deny',
    zdr: false,
};
export const ConfigSchema = z.object({
    baseUrl: z.string().url(),
    requirements: z.object({ path: z.string().default('requirements') }).default({ path: 'requirements' }),
    output: z.object({ dir: z.string().default('e2e') }).default({ dir: 'e2e' }),
    // Web only: desktop Chromium, Firefox and WebKit.
    browsers: z.array(z.enum(['chromium', 'firefox', 'webkit'])).default(['chromium']),
    auth: z
        .object({
        loginPath: z.string(),
        usernameLabel: z.string(),
        passwordLabel: z.string(),
        submitButton: z.string(),
        usernameEnv: z.string().default('TEST_USER_EMAIL'),
        passwordEnv: z.string().default('TEST_USER_PASSWORD'),
    })
        .optional(),
    safety: z
        .object({
        allowedHosts: z.array(z.string()).default([]),
        blockedActions: z.array(z.string()).default([]),
        maxPagesPerSession: z.number().int().positive().default(40),
        maxMinutesPerSession: z.number().positive().default(15),
    })
        .default({ allowedHosts: [], blockedActions: [], maxPagesPerSession: 40, maxMinutesPerSession: 15 }),
    ai: z
        .object({
        /** anthropic = Claude API with ANTHROPIC_API_KEY; openrouter = OpenRouter with OPENROUTER_API_KEY. */
        provider: z.enum(['anthropic', 'openrouter']).default('anthropic'),
        /** Model on the Claude API. */
        model: z.string().min(1).default('claude-opus-5-5'),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
        maxTurns: z.number().int().positive().default(60),
        openrouter: z
            .object({
            /** OpenRouter model id, e.g. anthropic/claude-opus-5.5. Must support tool calling. */
            model: z.string().min(1).default(OPENROUTER_DEFAULTS.model),
            baseUrl: z.string().url().default(OPENROUTER_DEFAULTS.baseUrl),
            /** deny = only providers that do not store or train on your data. */
            dataCollection: z.enum(['allow', 'deny']).default(OPENROUTER_DEFAULTS.dataCollection),
            /** true = only Zero Data Retention endpoints. */
            zdr: z.boolean().default(OPENROUTER_DEFAULTS.zdr),
        })
            .default(OPENROUTER_DEFAULTS),
    })
        .default({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high', maxTurns: 60, openrouter: OPENROUTER_DEFAULTS }),
    jira: z
        .object({
        baseUrl: z.string().url(),
        projectKey: z.string(),
        issueType: z.string().default('Bug'),
        auth: z.enum(['basic', 'bearer']).default('basic'),
        emailEnv: z.string().default('JIRA_EMAIL'),
        tokenEnv: z.string().default('JIRA_API_TOKEN'),
        labels: z.array(z.string()).default(['traceqa']),
    })
        .optional(),
    analyze: z
        .object({
        maxPages: z.number().int().positive().default(30),
        skipLinks: z.array(z.string()).default(['sign out', 'log out', 'logout', 'delete']),
    })
        .default({ maxPages: 30, skipLinks: ['sign out', 'log out', 'logout', 'delete'] }),
});
/** The model the AI agent will actually use, with its provider, for display and logs. */
export function activeModel(ai) {
    return ai.provider === 'openrouter'
        ? { provider: 'openrouter', model: ai.openrouter.model, keyName: 'OPENROUTER_API_KEY', label: `OpenRouter · ${ai.openrouter.model}` }
        : { provider: 'anthropic', model: ai.model, keyName: 'ANTHROPIC_API_KEY', label: ai.model };
}
/** Finds the project folder: the given dir, TRACEQA_PROJECT, or the nearest parent holding traceqa.config.json. */
export function findProjectDir(start) {
    const explicit = start ?? process.env.TRACEQA_PROJECT;
    if (explicit) {
        const dir = path.resolve(explicit);
        return fs.existsSync(path.join(dir, CONFIG_FILE)) ? dir : undefined;
    }
    let dir = process.cwd();
    for (;;) {
        if (fs.existsSync(path.join(dir, CONFIG_FILE)))
            return dir;
        const parent = path.dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
/** Minimal .env reader (KEY=value lines, # comments, optional quotes). */
export function readEnvFile(file) {
    const out = {};
    if (!fs.existsSync(file))
        return out;
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#'))
            continue;
        const eq = line.indexOf('=');
        if (eq < 1)
            continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}
export function loadProject(start) {
    const dir = findProjectDir(start);
    if (!dir) {
        throw new Error(`No ${CONFIG_FILE} found${start ? ` in ${path.resolve(start)}` : ' here or in any parent folder'}. Run "traceqa init" first.`);
    }
    const raw = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8'));
    const env = { ...readEnvFile(path.join(dir, '.env')), ...pickEnv(process.env) };
    if (env.BASE_URL)
        raw.baseUrl = env.BASE_URL;
    // Jira can also be configured from the environment (handy in CI).
    if (env.JIRA_BASE_URL && (raw.jira?.projectKey || env.JIRA_PROJECT_KEY)) {
        raw.jira = { ...(raw.jira ?? {}), baseUrl: env.JIRA_BASE_URL, projectKey: env.JIRA_PROJECT_KEY ?? raw.jira.projectKey };
    }
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
        throw new Error(`${CONFIG_FILE} is not valid:\n${issues}`);
    }
    const config = parsed.data;
    if (config.safety.allowedHosts.length === 0)
        config.safety.allowedHosts = [new URL(config.baseUrl).host];
    return { dir, config, env, paths: projectPaths(dir, config) };
}
/** Checks a config object; returns readable problems instead of throwing. */
export function validateConfig(raw) {
    const parsed = ConfigSchema.safeParse(raw);
    if (parsed.success)
        return { ok: true, config: parsed.data };
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
export function readRawConfig(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8'));
}
export function writeRawConfig(dir, raw) {
    fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(raw, null, 2) + '\n');
}
/** Quotes a value only when needed, in a way both TraceQA and the generated Playwright config read back unchanged. */
function envLine(key, value) {
    if (/^[^\s"'#]*$/.test(value))
        return `${key}=${value}`;
    if (!value.includes("'"))
        return `${key}='${value}'`;
    if (!value.includes('"'))
        return `${key}="${value}"`;
    throw new Error(`${key} cannot contain both ' and " characters.`);
}
/**
 * Sets or removes keys in a .env file and keeps every other line (comments included).
 * null removes the key. Values cannot contain line breaks.
 */
export function setEnvValues(file, values) {
    for (const [key, value] of Object.entries(values)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            throw new Error(`${key} is not a valid environment variable name.`);
        if (value !== null && /[\r\n]/.test(value))
            throw new Error(`${key} cannot contain a line break.`);
    }
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
    if (lines.length && lines[lines.length - 1] === '')
        lines.pop();
    const done = new Set();
    const out = [];
    for (const line of lines) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (m && m[1] in values) {
            if (done.has(m[1]))
                continue; // drop repeats of a key we set
            done.add(m[1]);
            const v = values[m[1]];
            if (v !== null)
                out.push(envLine(m[1], v));
            continue;
        }
        out.push(line);
    }
    for (const [key, value] of Object.entries(values))
        if (!done.has(key) && value !== null)
            out.push(envLine(key, value));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, out.join('\n') + '\n');
}
function pickEnv(source) {
    const out = {};
    for (const [k, v] of Object.entries(source))
        if (typeof v === 'string')
            out[k] = v;
    return out;
}
export function projectPaths(dir, config) {
    const state = path.join(dir, '.traceqa');
    return {
        state,
        appMap: path.join(state, 'app-map.json'),
        requirements: path.join(state, 'requirements.json'),
        clarifications: path.join(state, 'clarifications.json'),
        traceability: path.join(state, 'traceability.json'),
        tests: path.join(state, 'tests.json'),
        sessions: path.join(state, 'sessions'),
        runs: path.join(state, 'runs'),
        bugs: path.join(state, 'bugs'),
        report: path.join(state, 'report'),
        requirementsDir: path.join(dir, config.requirements.path),
        e2e: path.join(dir, config.output.dir),
    };
}
export function isAllowedUrl(project, url) {
    try {
        const u = new URL(url);
        if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:')
            return true;
        return project.config.safety.allowedHosts.some((h) => h.toLowerCase() === u.host.toLowerCase());
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=config.js.map