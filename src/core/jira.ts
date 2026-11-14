import fs from 'node:fs';
import path from 'node:path';
import type { Project } from './config.js';
import { getBug, saveBugRecord } from './bugs.js';
import { now } from './store.js';
import type { Bug } from './types.js';

// Minimal Jira Cloud REST v3 client: duplicate check, create issue, attach evidence, comment.

type AdfNode = Record<string, unknown>;

const text = (t: string): AdfNode => ({ type: 'text', text: t });
const para = (t: string): AdfNode => ({ type: 'paragraph', content: t ? [text(t)] : [] });
const heading = (t: string): AdfNode => ({ type: 'heading', attrs: { level: 3 }, content: [text(t)] });

/** Bug → Atlassian Document Format, the rich-text format Jira Cloud expects. */
export function bugToAdf(bug: Bug): AdfNode {
  const content: AdfNode[] = [];
  if (bug.requirementId) content.push(para(`Requirement: ${bug.requirementId}${bug.acId ? ` ${bug.acId}` : ''}`));
  content.push(para(`Environment: ${bug.environment}`));
  content.push(heading('Steps to reproduce'));
  content.push({
    type: 'orderedList',
    content: (bug.steps.length ? bug.steps : ['See the attached evidence.']).map((s) => ({ type: 'listItem', content: [para(s)] })),
  });
  content.push(heading('Expected'));
  for (const line of bug.expected.split('\n')) content.push(para(line));
  content.push(heading('Actual'));
  for (const line of bug.actual.split('\n')) content.push(para(line));
  content.push(para(`Found by TraceQA (${bug.id}, ${bug.source.kind} ${bug.source.ref}). Evidence is attached.`));
  return { type: 'doc', version: 1, content };
}

/** One label per requirement criterion lets TraceQA find an open duplicate from any machine. */
export function trackingLabel(bug: Bug): string {
  const base = bug.requirementId ? `${bug.requirementId}${bug.acId ? `-${bug.acId}` : ''}` : bug.id;
  return `tqa-${base}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

export function jiraConfig(project: Project) {
  const j = project.config.jira;
  if (!j) {
    throw new Error('Jira is not configured. Add a "jira" section to traceqa.config.json (baseUrl, projectKey) or set JIRA_BASE_URL and JIRA_PROJECT_KEY.');
  }
  const token = project.env[j.tokenEnv];
  const email = project.env[j.emailEnv];
  if (!token || (j.auth === 'basic' && !email)) {
    throw new Error(`Set ${j.auth === 'basic' ? `${j.emailEnv} and ` : ''}${j.tokenEnv} in the project's .env file to file bugs in Jira.`);
  }
  const authorization = j.auth === 'basic' ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` : `Bearer ${token}`;
  return { ...j, base: j.baseUrl.replace(/\/+$/, ''), authorization };
}

export async function call<T>(cfg: ReturnType<typeof jiraConfig>, method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`${cfg.base}${url}`, {
    method,
    headers: {
      Authorization: cfg.authorization,
      Accept: 'application/json',
      ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Jira ${method} ${url} failed: ${res.status} ${raw.slice(0, 300)}`);
  return (raw ? JSON.parse(raw) : {}) as T;
}

const ATTACHABLE = /\.(png|jpe?g|webm|zip|md|json|txt|har)$/i;
const MAX_ATTACHMENT = 10 * 1024 * 1024;

/**
 * Files a bug in Jira. If an open issue already carries this requirement criterion's tracking label,
 * TraceQA comments on that issue instead of creating a duplicate.
 */
export async function fileBugInJira(project: Project, bugId: string): Promise<{ bug: Bug; created: boolean; attached: number }> {
  const cfg = jiraConfig(project);
  const bug = getBug(project, bugId);
  if (bug.status === 'discarded') throw new Error(`${bug.id} was discarded; it will not be filed.`);
  if (bug.ticket) return { bug, created: false, attached: 0 };
  const label = trackingLabel(bug);

  const jql = `project = "${cfg.projectKey}" AND labels = "${label}" AND statusCategory != Done ORDER BY created DESC`;
  const search = await call<{ issues?: { key: string }[] }>(cfg, 'GET', `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,status&maxResults=1`);
  const existing = search.issues?.[0];

  let key: string;
  let created = false;
  if (existing) {
    key = existing.key;
    await call(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      body: { type: 'doc', version: 1, content: [para(`TraceQA saw this again (${bug.id}).`), ...((bugToAdf(bug).content as AdfNode[]) ?? [])] },
    });
  } else {
    const res = await call<{ key: string }>(cfg, 'POST', '/rest/api/3/issue', {
      fields: {
        project: { key: cfg.projectKey },
        issuetype: { name: cfg.issueType },
        summary: bug.title.slice(0, 250),
        description: bugToAdf(bug),
        labels: [...new Set([...cfg.labels, label, ...(bug.requirementId ? [bug.requirementId] : [])])],
      },
    });
    key = res.key;
    created = true;
  }

  // New issue: up to 10 files, screenshots first. Existing issue: just the newest screenshots, to avoid noise.
  const files = bug.evidence
    .filter((e) => ATTACHABLE.test(e.path) && fs.existsSync(e.path) && fs.statSync(e.path).size <= MAX_ATTACHMENT)
    .filter((e) => created || /\.(png|jpe?g)$/i.test(e.path))
    .sort((a, b) => Number(/\.(png|jpe?g)$/i.test(b.path)) - Number(/\.(png|jpe?g)$/i.test(a.path)))
    .slice(0, created ? 10 : 2);
  let attached = 0;
  for (const e of files) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(e.path)]), `${bug.id}-${e.name}-${path.basename(e.path)}`);
    await call(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, form, { 'X-Atlassian-Token': 'no-check' });
    attached++;
  }

  bug.status = 'filed';
  bug.ticket = { system: 'jira', key, url: `${cfg.base}/browse/${key}`, duplicate: !created || undefined };
  bug.updatedAt = now();
  saveBugRecord(project, bug);
  return { bug, created, attached };
}
