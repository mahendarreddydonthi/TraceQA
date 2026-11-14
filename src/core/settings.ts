import path from 'node:path';
import { loadProject, readEnvFile, readRawConfig, setEnvValues, validateConfig, writeRawConfig, type Project, type TraceQAConfig } from './config.js';
import { syncBrowsers } from './scaffold.js';

// Settings for the dashboard: the editable parts of traceqa.config.json plus the .env values TraceQA uses.
// Secret values are write-only: they are saved to .env and never sent back.

export interface EnvField {
  key: string;
  label: string;
  secret: boolean;
  group: 'auth' | 'ai' | 'jira';
}

export function envFields(config: Pick<TraceQAConfig, 'auth' | 'jira'>): EnvField[] {
  return [
    { key: config.auth?.usernameEnv ?? 'TEST_USER_EMAIL', label: 'Test account user name or email', secret: false, group: 'auth' },
    { key: config.auth?.passwordEnv ?? 'TEST_USER_PASSWORD', label: 'Test account password', secret: true, group: 'auth' },
    { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true, group: 'ai' },
    { key: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', secret: true, group: 'ai' },
    { key: 'LMSTUDIO_API_KEY', label: 'LM Studio API key (only if its server requires one)', secret: true, group: 'ai' },
    { key: config.jira?.emailEnv ?? 'JIRA_EMAIL', label: 'Jira account email', secret: false, group: 'jira' },
    { key: config.jira?.tokenEnv ?? 'JIRA_API_TOKEN', label: 'Jira API token', secret: true, group: 'jira' },
  ];
}

/** Names that would change how Node, npm or the browsers start. TraceQA never writes these. */
const UNSAFE_ENV = /^(PATH|PATHEXT|COMSPEC|SHELL|HOME|USERPROFILE|NODE_.*|NPM_.*|LD_.*|DYLD_.*|PLAYWRIGHT_.*)$/i;

const EDITABLE = ['baseUrl', 'browsers', 'auth', 'safety', 'ai', 'jira', 'analyze'] as const;
export type SettingsPatch = Partial<Record<(typeof EDITABLE)[number], unknown>>;

/**
 * Whether the chosen AI provider is ready: a key for Anthropic and OpenRouter, a chosen model for
 * Ollama and LM Studio (they run on this computer; LM Studio's key is optional).
 */
export function aiKeyStatus(project: Project): { configured: boolean; source: string | null; keyName: string; missing: 'key' | 'model' | null; local: boolean } {
  const ai = project.config.ai;
  const from = (k: string) => (process.env[k] ? 'environment' : '.env');
  if (ai.provider === 'ollama' || ai.provider === 'lmstudio') {
    const model = ai.provider === 'ollama' ? ai.ollama.model : ai.lmstudio.model;
    return { configured: !!model, source: 'this computer', keyName: '', missing: model ? null : 'model', local: true };
  }
  if (ai.provider === 'openrouter') {
    const keyName = 'OPENROUTER_API_KEY';
    if (project.env[keyName]) return { configured: true, source: from(keyName), keyName, missing: null, local: false };
    return { configured: false, source: null, keyName, missing: 'key', local: false };
  }
  const keyName = 'ANTHROPIC_API_KEY';
  if (project.env[keyName]) return { configured: true, source: from(keyName), keyName, missing: null, local: false };
  if (project.env.ANTHROPIC_AUTH_TOKEN) return { configured: true, source: 'ANTHROPIC_AUTH_TOKEN', keyName, missing: null, local: false };
  return { configured: false, source: null, keyName, missing: 'key', local: false };
}

export function getSettings(project: Project) {
  const raw = readRawConfig(project.dir);
  const fileEnv = readEnvFile(path.join(project.dir, '.env'));
  const notes: string[] = [];
  if (project.env.BASE_URL && project.env.BASE_URL !== raw.baseUrl) {
    notes.push(`BASE_URL ${process.env.BASE_URL ? 'in the environment' : 'in .env'} overrides the app URL: ${project.env.BASE_URL}`);
  }
  if (process.env.JIRA_BASE_URL) notes.push('JIRA_BASE_URL in the environment overrides the Jira site.');
  return {
    dir: project.dir,
    config: { ...project.config, baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : project.config.baseUrl },
    effectiveBaseUrl: project.config.baseUrl,
    env: envFields(project.config).map((f) => {
      const inProcess = !!process.env[f.key];
      const inFile = !!fileEnv[f.key];
      return {
        ...f,
        set: inProcess || inFile,
        source: inProcess ? 'environment' : inFile ? '.env' : null,
        value: f.secret ? undefined : project.env[f.key] ?? '',
      };
    }),
    ai: aiKeyStatus(project),
    notes,
  };
}

/**
 * Saves edited settings. Sections are replaced as a whole (null removes an optional section such as jira),
 * the result is validated before anything is written, and env values go to .env (empty string = leave as is).
 */
export function saveSettings(dir: string, input: { config?: SettingsPatch; env?: Record<string, string | null> }): { notes: string[] } {
  const notes: string[] = [];
  const raw = readRawConfig(dir);
  const next: Record<string, unknown> = { ...raw };
  const patch = input.config ?? {};
  for (const key of Object.keys(patch)) {
    if (!(EDITABLE as readonly string[]).includes(key)) throw Object.assign(new Error(`${key} cannot be changed here.`), { status: 400 });
    const value = patch[key as keyof SettingsPatch];
    if (value === null) delete next[key];
    else next[key] = value;
  }

  // A new app URL needs its host in the allowed hosts, or every browser step would be blocked.
  const oldHost = typeof raw.baseUrl === 'string' ? safeHost(raw.baseUrl) : undefined;
  const newHost = typeof next.baseUrl === 'string' ? safeHost(next.baseUrl) : undefined;
  const safety = next.safety as { allowedHosts?: string[] } | undefined;
  if (newHost && safety?.allowedHosts?.length && !safety.allowedHosts.some((h) => h.toLowerCase() === newHost.toLowerCase())) {
    safety.allowedHosts = [...safety.allowedHosts, newHost];
    notes.push(`Added ${newHost} to the allowed hosts so TraceQA can open the new app URL.`);
  }

  const checked = validateConfig(next);
  if (!checked.ok) throw Object.assign(new Error(`Not saved:\n${checked.errors.join('\n')}`), { status: 400 });

  const allowed = new Map(envFields(checked.config).map((f) => [f.key, f]));
  const envUpdates: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!allowed.has(key)) throw Object.assign(new Error(`${key} is not a setting TraceQA manages.`), { status: 400 });
    if (UNSAFE_ENV.test(key)) throw Object.assign(new Error(`${key} is a system variable; pick another name for it in the config.`), { status: 400 });
    if (value === null) envUpdates[key] = null;
    else if (typeof value === 'string' && value !== '') envUpdates[key] = value;
  }
  const envFile = path.join(dir, '.env');
  if (newHost && newHost !== oldHost && readEnvFile(envFile).BASE_URL) {
    envUpdates.BASE_URL = next.baseUrl as string;
    notes.push('Updated BASE_URL in .env to match.');
  }

  writeRawConfig(dir, next);
  if (Object.keys(envUpdates).length) setEnvValues(envFile, envUpdates);
  if (process.env.BASE_URL && patch.baseUrl !== undefined) notes.push('BASE_URL is also set in the environment and still overrides the app URL until it is removed there.');

  if (patch.browsers !== undefined) {
    const project = loadProject(dir);
    try {
      if (syncBrowsers(project)) notes.push('Updated the browser list in the Playwright config.');
    } catch {
      notes.push('Could not update the browser list in the Playwright config; edit its projects list by hand.');
    }
  }
  return { notes };
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
