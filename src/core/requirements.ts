import fs from 'node:fs';
import path from 'node:path';
import type { Project } from './config.js';
import { now, readJson, rel, writeJson } from './store.js';
import type { AcceptanceCriterion, Clarifications, Requirement, RequirementIssue, RequirementsFile } from './types.js';

const REQ_HEADING = /^(#{1,6})\s+(REQ-[A-Za-z0-9_-]+)\s*[:\-–—]?\s*(.*)$/;
const H1 = /^#\s+(.+)$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const AC_PREFIX = /^AC[-\s]?(\d+)\s*[:.)\-–—]\s*(.*)$/i;

/** Words a test cannot check without a number or an observable outcome. */
const VAGUE: { terms: string[]; hint: string }[] = [
  { terms: ['quickly', 'fast', 'slow', 'promptly', 'instantly', 'responsive', 'performant', 'in a timely manner'], hint: 'Give a time limit, e.g. "within 2 seconds".' },
  { terms: ['easy', 'easily', 'simple', 'intuitive', 'user-friendly', 'user friendly', 'seamless', 'nice', 'clean'], hint: 'Describe what the user sees or can do, step by step.' },
  { terms: ['relevant', 'appropriate', 'appropriately', 'properly', 'correctly', 'reasonable', 'adequate', 'sufficient', 'suitable', 'as expected'], hint: 'Say exactly what should appear or happen.' },
  { terms: ['some', 'many', 'several', 'few', 'etc', 'and so on', 'as needed', 'if possible', 'approximately'], hint: 'Give an exact number or a complete list.' },
];

const NO_UI_PATH = ['email', 'e-mail', 'sms', 'text message', 'push notification', 'webhook', 'background job', 'cron', 'audit log'];

function findTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z])${escaped}([^A-Za-z]|$)`, 'i').test(text);
}

export function checkText(text: string, acId?: string): RequirementIssue[] {
  const issues: RequirementIssue[] = [];
  const quoted = text.replace(/"[^"]*"|“[^”]*”/g, '""'); // ignore words inside quoted UI text
  for (const group of VAGUE) {
    for (const term of group.terms) {
      if (findTerm(quoted, term)) {
        issues.push({ kind: 'vague', acId, term, message: `“${term}” has no measurable target, so a test can’t pass or fail. ${group.hint}` });
        break;
      }
    }
  }
  for (const term of NO_UI_PATH) {
    if (findTerm(quoted, term)) {
      issues.push({ kind: 'no-ui-path', acId, term, message: `Mentions “${term}”, which a browser test may not reach. Consider a test inbox, an API check or a manual check.` });
      break;
    }
  }
  return issues;
}

function titleCase(file: string): string {
  return path
    .basename(file, path.extname(file))
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Parses one Markdown file. Requirements are headings like "## REQ-142 Title"; bullets under them are acceptance criteria. */
export function parseRequirementsMarkdown(text: string, file: string): Requirement[] {
  const out: Requirement[] = [];
  let feature = titleCase(file);
  let current: Requirement | undefined;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const req = line.match(REQ_HEADING);
    if (req) {
      current = {
        id: req[2].toUpperCase(),
        title: req[3].trim() || req[2],
        feature,
        description: '',
        criteria: [],
        issues: [],
        source: { file, line: i + 1 },
      };
      out.push(current);
      return;
    }
    const h1 = line.match(H1);
    if (h1) {
      feature = h1[1].trim();
      current = undefined;
      return;
    }
    if (/^#{1,6}\s/.test(line)) {
      current = undefined;
      return;
    }
    if (!current) return;
    const bullet = line.match(BULLET);
    if (bullet) {
      const ac = bullet[1].match(AC_PREFIX);
      const id = ac ? `AC${Number(ac[1])}` : `AC${current.criteria.length + 1}`;
      current.criteria.push({ id, text: (ac ? ac[2] : bullet[1]).trim(), issues: [] });
      return;
    }
    if (line.trim()) current.description = (current.description ? current.description + ' ' : '') + line.trim();
  });
  return out;
}

function analyse(req: Requirement): Requirement {
  req.issues = [];
  for (const ac of req.criteria) ac.issues = checkText(ac.text, ac.id);
  if (req.criteria.length === 0) {
    req.issues.push({ kind: 'no-criteria', message: 'No acceptance criteria. Add bullets that describe what a test should check.' });
    req.issues.push(...checkText(`${req.title} ${req.description}`));
  }
  return req;
}

function markdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') out.push(full);
  }
  return out.sort();
}

export function applyClarifications(reqs: Requirement[], clar: Clarifications): void {
  for (const req of reqs) {
    const byAc = clar[req.id];
    if (!byAc) continue;
    for (const ac of req.criteria) {
      const c = byAc[ac.id];
      if (c) {
        ac.text = c.text;
        ac.clarified = true;
        ac.issues = checkText(ac.text, ac.id);
      }
    }
  }
}

export function importRequirements(project: Project): { file: RequirementsFile; files: string[]; duplicates: string[] } {
  const files = markdownFiles(project.paths.requirementsDir);
  const all: Requirement[] = [];
  const duplicates: string[] = [];
  for (const f of files) {
    const parsed = parseRequirementsMarkdown(fs.readFileSync(f, 'utf8'), rel(project.dir, f));
    for (const r of parsed) {
      if (all.some((x) => x.id === r.id)) duplicates.push(r.id);
      else all.push(analyse(r));
    }
  }
  applyClarifications(all, loadClarifications(project));
  const file: RequirementsFile = { importedAt: now(), requirements: all };
  writeJson(project.paths.requirements, file);
  return { file, files: files.map((f) => rel(project.dir, f)), duplicates };
}

export function loadRequirements(project: Project): Requirement[] {
  return readJson<RequirementsFile>(project.paths.requirements, { importedAt: '', requirements: [] }).requirements;
}

export function loadClarifications(project: Project): Clarifications {
  return readJson<Clarifications>(project.paths.clarifications, {});
}

/** Records a clearer wording for one acceptance criterion (the source file is left as it is). */
export function clarify(project: Project, requirementId: string, acId: string, text: string): AcceptanceCriterion {
  const reqs = loadRequirements(project);
  const req = reqs.find((r) => r.id === requirementId.toUpperCase());
  if (!req) throw new Error(`Unknown requirement ${requirementId}. Run import_requirements first.`);
  const ac = req.criteria.find((c) => c.id === acId.toUpperCase());
  if (!ac) throw new Error(`${req.id} has no ${acId}. Its criteria are ${req.criteria.map((c) => c.id).join(', ') || 'none'}.`);
  const clar = loadClarifications(project);
  clar[req.id] = { ...(clar[req.id] ?? {}), [ac.id]: { text, at: now() } };
  writeJson(project.paths.clarifications, clar);
  ac.text = text;
  ac.clarified = true;
  ac.issues = checkText(text, ac.id);
  writeJson(project.paths.requirements, { importedAt: now(), requirements: reqs });
  return ac;
}

export function openIssues(req: Requirement): RequirementIssue[] {
  return [...req.issues, ...req.criteria.flatMap((c) => c.issues)];
}

// ---------- requirement files (for the dashboard editor) ----------

export const MAX_REQUIREMENT_FILE = 512 * 1024;

/** Resolves a requirement file name safely: a .md file inside the requirements folder, never README.md. */
const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

export function resolveRequirementFile(project: Project, name: string): string {
  const clean = String(name ?? '').trim().replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    throw bad('Use a plain file name such as checkout.md (sub-folders are fine, ".." is not).');
  }
  if (!/^[\w .\-/]+$/.test(clean)) throw bad('File names may use letters, numbers, spaces, dots, dashes and underscores.');
  if (!clean.toLowerCase().endsWith('.md')) throw bad('Requirement files must end in .md.');
  if (path.basename(clean).toLowerCase() === 'readme.md') throw bad('README.md is not read as requirements; pick another name.');
  const root = path.resolve(project.paths.requirementsDir);
  const full = path.resolve(root, clean);
  if (!full.startsWith(root + path.sep)) throw bad('The file must be inside the requirements folder.');
  return full;
}

export function listRequirementFiles(project: Project): { file: string; size: number; updatedAt: string; requirements: number }[] {
  const root = project.paths.requirementsDir;
  return markdownFiles(root).map((f) => {
    const text = fs.readFileSync(f, 'utf8');
    const stat = fs.statSync(f);
    return {
      file: rel(root, f),
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      requirements: parseRequirementsMarkdown(text, rel(project.dir, f)).length,
    };
  });
}

export function readRequirementFile(project: Project, name: string): string {
  const file = resolveRequirementFile(project, name);
  if (!fs.existsSync(file)) throw Object.assign(new Error(`No requirement file ${name}.`), { status: 404 });
  return fs.readFileSync(file, 'utf8');
}

export function writeRequirementFile(project: Project, name: string, content: string): { file: string; created: boolean } {
  const file = resolveRequirementFile(project, name);
  if (typeof content !== 'string') throw new Error('Content must be text.');
  if (Buffer.byteLength(content) > MAX_REQUIREMENT_FILE) throw new Error('Requirement files are limited to 512 KB.');
  const created = !fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.replace(/\r\n/g, '\n'));
  return { file: rel(project.paths.requirementsDir, file), created };
}

/** Moves a requirement file to .traceqa/trash/ instead of deleting it, so it can be recovered. */
export function trashRequirementFile(project: Project, name: string): string {
  const file = resolveRequirementFile(project, name);
  if (!fs.existsSync(file)) throw Object.assign(new Error(`No requirement file ${name}.`), { status: 404 });
  const stamp = now().replace(/[:.]/g, '-');
  const target = path.join(project.paths.state, 'trash', `${stamp}-${path.basename(file)}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(file, target);
  return rel(project.dir, target);
}

/** Parses text without saving anything, so an editor can show what TraceQA will read. */
export function previewRequirements(content: string, name: string): Requirement[] {
  const reqs = parseRequirementsMarkdown(content, name).map(analyse);
  return reqs;
}
