import type { Project } from './config.js';
import { call, jiraConfig } from './jira.js';
import { importRequirements, writeRequirementFile } from './requirements.js';
import { now, slug } from './store.js';

// Requirements from Jira: each issue (story, requirement …) becomes a requirement with its Jira key as the ID,
// and its acceptance criteria come from a custom field or from the "Acceptance criteria" part of the description.
// The result is written to requirements/jira/<project>.md and replaced on every sync.

type Adf = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: Adf[] };

function inline(nodes: Adf[] = []): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text': return n.text ?? '';
        case 'hardBreak': return '\n';
        case 'mention': return String(n.attrs?.text ?? '');
        case 'emoji': return String(n.attrs?.text ?? n.attrs?.shortName ?? '');
        case 'inlineCard': return String(n.attrs?.url ?? '');
        case 'status': return String(n.attrs?.text ?? '');
        case 'date': return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : '';
        default: return inline(n.content);
      }
    })
    .join('');
}

/** Atlassian Document Format (Jira Cloud rich text) → Markdown lines. */
export function adfToMarkdown(node: Adf | null | undefined): string {
  if (!node) return '';
  const out: string[] = [];
  const walk = (n: Adf, depth = 0) => {
    switch (n.type) {
      case 'doc':
      case 'panel':
      case 'blockquote':
      case 'expand':
      case 'nestedExpand':
      case 'layoutSection':
      case 'layoutColumn':
        for (const c of n.content ?? []) walk(c, depth);
        break;
      case 'heading':
        out.push('', `${'#'.repeat(Math.min(Number(n.attrs?.level ?? 3) + 2, 6))} ${inline(n.content)}`);
        break;
      case 'paragraph': {
        const t = inline(n.content);
        if (t.trim()) out.push(...t.split('\n'));
        break;
      }
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        for (const li of n.content ?? []) {
          if (li.type === 'taskItem') {
            out.push(`${'  '.repeat(depth)}- ${inline(li.content)}`);
            continue;
          }
          const [first, ...rest] = li.content ?? [];
          out.push(`${'  '.repeat(depth)}- ${first ? inline(first.content) : ''}`);
          for (const r of rest) walk(r, depth + 1);
        }
        break;
      case 'codeBlock':
        out.push(...inline(n.content).split('\n'));
        break;
      case 'table':
        for (const row of n.content ?? []) out.push((row.content ?? []).map((c) => (c.content ?? []).map((p) => inline(p.content)).join(' ')).join(' | '));
        break;
      case 'rule':
        out.push('');
        break;
      default:
        if (n.content) for (const c of n.content) walk(c, depth);
        else if (n.text) out.push(n.text);
    }
  };
  walk(node);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Jira Data Center / Server wiki markup → Markdown lines (headings and lists; formatting dropped). */
export function wikiToMarkdown(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .split(/\r?\n/)
    .map((l) => {
      const h = l.match(/^h([1-6])\.\s*(.*)$/);
      if (h) return `${'#'.repeat(Math.min(Number(h[1]) + 2, 6))} ${h[2]}`;
      const li = l.match(/^\s*([*#-]+)\s+(.*)$/);
      if (li) return `${'  '.repeat(li[1].length - 1)}- ${li[2]}`;
      return l.replace(/\{(code|noformat|quote|panel)[^}]*\}/g, '').replace(/[*_+]([^*_+\n]+)[*_+]/g, '$1');
    })
    .join('\n')
    .trim();
}

const AC_HEADING = /^(?:#{1,6}\s*|\*\*)?\s*(acceptance\s+criteri(?:a|on)|acceptance\s+tests?|\bAC\b|definition\s+of\s+done)\b[*:\s]*$/i;
const AC_INLINE = /^(?:#{1,6}\s*|\*\*)?\s*(acceptance\s+criteri(?:a|on)|\bAC\b)\s*[*:]+\s*(.+)$/i;

/** Splits a description into the part before the acceptance criteria and the criteria themselves. */
export function splitCriteria(markdown: string, fieldMarkdown?: string): { description: string; criteria: string[] } {
  const lines = markdown.split('\n');
  const acStart = lines.findIndex((l) => AC_HEADING.test(l.trim()) || AC_INLINE.test(l.trim()));
  let acLines: string[] = [];
  let descLines = lines;
  if (acStart >= 0) {
    descLines = lines.slice(0, acStart);
    const inlineAc = lines[acStart].trim().match(AC_INLINE);
    const rest = lines.slice(acStart + 1);
    const end = rest.findIndex((l) => /^#{1,6}\s/.test(l.trim()));
    acLines = [...(inlineAc ? [inlineAc[2]] : []), ...(end >= 0 ? rest.slice(0, end) : rest)];
  }
  if (fieldMarkdown?.trim()) acLines = fieldMarkdown.split('\n');
  return { description: descLines.join(' ').replace(/^#+\s*/gm, '').replace(/\s*-\s+/g, '; ').replace(/\s+/g, ' ').replace(/^;\s*/, '').trim(), criteria: criteriaFrom(acLines) };
}

/** Bullets become criteria; Gherkin scenarios become one criterion each; otherwise each line is one. */
function criteriaFrom(lines: string[]): string[] {
  const clean = lines.map((l) => l.trim()).filter(Boolean);
  if (!clean.length) return [];
  const gherkin = clean.some((l) => /^(-\s*)?(scenario|given|when|then)\b/i.test(l));
  if (gherkin) {
    const out: string[] = [];
    let cur: string[] = [];
    let name = '';
    const flush = () => {
      if (cur.length) out.push(`${name ? `${name}: ` : ''}${cur.join(', ')}`);
      cur = [];
      name = '';
    };
    for (const l of clean.map((x) => x.replace(/^-\s*/, ''))) {
      const sc = l.match(/^scenario(?:\s+outline)?\s*:\s*(.*)$/i);
      if (sc) {
        flush();
        name = sc[1];
      } else if (/^given\b/i.test(l) && cur.some((c) => /^then\b/i.test(c) || /^and\b/i.test(c))) {
        flush();
        cur.push(l);
      } else cur.push(l);
    }
    flush();
    return out;
  }
  const bullets = clean.filter((l) => /^-\s+/.test(l));
  return (bullets.length ? bullets : clean).map((l) => l.replace(/^-\s+/, '').replace(/^AC\s*\d+\s*[:.)-]\s*/i, '').trim()).filter(Boolean);
}

interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    description?: Adf | string | null;
    issuetype?: { name?: string };
    status?: { name?: string };
    components?: { name?: string }[];
    [field: string]: unknown;
  };
}

export interface JiraImportResult {
  file: string;
  jql: string;
  issues: number;
  withCriteria: number;
  keys: string[];
}

/** Searches Jira and writes the matching issues as requirements. Jira Cloud (basic auth) uses API v3, Data Center (bearer) v2. */
export async function importJiraRequirements(project: Project, opts: { jql?: string; max?: number; log?: (l: string) => void } = {}): Promise<JiraImportResult> {
  const cfg = jiraConfig(project);
  const log = opts.log ?? (() => {});
  const jql = opts.jql?.trim() || cfg.requirementsJql || `project = "${cfg.projectKey}" AND issuetype = Story AND statusCategory != Done ORDER BY key ASC`;
  const max = Math.min(Math.max(opts.max ?? 200, 1), 1000);
  const acField = cfg.acceptanceCriteriaField;
  const fields = ['summary', 'description', 'issuetype', 'status', 'components', ...(acField ? [acField] : [])].join(',');
  const cloud = cfg.auth === 'basic';
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  log(`Searching Jira: ${jql}`);
  while (issues.length < max) {
    const size = Math.min(100, max - issues.length);
    const q = `jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(fields)}&maxResults=${size}`;
    if (cloud) {
      const page = await call<{ issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>(cfg, 'GET', `/rest/api/3/search/jql?${q}${nextPageToken ? `&nextPageToken=${encodeURIComponent(nextPageToken)}` : ''}`);
      issues.push(...(page.issues ?? []));
      nextPageToken = page.nextPageToken;
      if (!page.issues?.length || !nextPageToken || page.isLast) break;
    } else {
      const page = await call<{ issues?: JiraIssue[]; total?: number }>(cfg, 'GET', `/rest/api/2/search?${q}&startAt=${issues.length}`);
      issues.push(...(page.issues ?? []));
      if (!page.issues?.length || issues.length >= (page.total ?? 0)) break;
    }
    log(`  ${issues.length} issue(s) so far …`);
  }
  if (!issues.length) throw new Error(`No Jira issues match: ${jql}`);

  const toMd = (v: unknown) => (typeof v === 'string' ? wikiToMarkdown(v) : adfToMarkdown(v as Adf));
  const byFeature = new Map<string, string[]>();
  let withCriteria = 0;
  for (const issue of issues.slice(0, max)) {
    const f = issue.fields;
    const { description, criteria } = splitCriteria(toMd(f.description), acField ? toMd(f[acField]) : undefined);
    if (criteria.length) withCriteria++;
    const feature = f.components?.[0]?.name || f.issuetype?.name || 'Jira';
    const block = [
      `## ${issue.key} ${(f.summary ?? issue.key).replace(/\s+/g, ' ').trim()}`,
      [description.slice(0, 600), `(Jira: ${cfg.base}/browse/${issue.key}${f.issuetype?.name ? ` · ${f.issuetype.name}` : ''}${f.status?.name ? ` · ${f.status.name}` : ''})`].filter(Boolean).join(' '),
      ...criteria.map((c, i) => `- AC${i + 1}: ${c.replace(/\s+/g, ' ')}`),
    ].join('\n');
    byFeature.set(feature, [...(byFeature.get(feature) ?? []), block]);
  }
  const name = `jira/${slug(cfg.projectKey) || 'issues'}.md`;
  const content = [
    `<!-- Synced from Jira by TraceQA on ${now().slice(0, 10)}. JQL: ${jql.replace(/--/g, '- -')}`,
    '     This file is replaced on every sync: change requirements in Jira, not here. -->',
    ...[...byFeature.entries()].flatMap(([feature, blocks]) => ['', `# ${feature}`, '', blocks.join('\n\n')]),
    '',
  ].join('\n');
  writeRequirementFile(project, name, content);
  await importRequirements(project);
  log(`Wrote ${issues.length} issue(s) to requirements/${name}: ${withCriteria} with acceptance criteria.`);
  return { file: name, jql, issues: Math.min(issues.length, max), withCriteria, keys: issues.slice(0, max).map((i) => i.key) };
}
