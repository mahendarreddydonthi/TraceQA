import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Project } from './config.js';
import { readRequirements, REQ_ID, usesIds, type ReadMode, type ReadRequirement } from './reader.js';
import { now, readJson, rel, writeJson } from './store.js';
import type { AcceptanceCriterion, Clarifications, Requirement, RequirementIssue, RequirementsFile } from './types.js';

export { REQ_ID };

// Requirements come from documents in requirements/ written in ANY format: Markdown, text, Word or PDF.
// Each document is read by (in this order) a saved AI reading of exactly this version, the strict reader
// when it uses "## REQ-142 Title" headings, or the free-form reader (see reader.ts). Requirements without
// an ID in the document get a stable one from .traceqa/requirement-ids.json.

const REQ_HEADING = new RegExp(`^(#{1,6})\\s+(${REQ_ID})\\s*[:\\-–—]?\\s*(.*)$`);
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
  // An email *field* on the page is fine to test; an email that gets sent is not.
  const outsideUi = quoted.replace(/\be-?mail(\s+(address|field|box|input))+\b|\be-?mail\s+(and|or)\s+password\b/gi, 'field');
  for (const term of NO_UI_PATH) {
    if (findTerm(outsideUi, term)) {
      issues.push({ kind: 'no-ui-path', acId, term, message: `Mentions “${term}”, which a browser test may not reach. Consider a test inbox, an API check or a manual check.` });
      break;
    }
  }
  return issues;
}

export function titleCase(file: string): string {
  return path
    .basename(file, path.extname(file))
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The strict reader: requirements are headings like "## REQ-142 Title"; bullets under them are acceptance criteria. */
export function parseRequirementsMarkdown(text: string, file: string): Requirement[] {
  const out: Requirement[] = [];
  let feature = titleCase(file);
  let current: Requirement | undefined;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const req = line.match(REQ_HEADING);
    if (req) {
      current = { id: req[2].toUpperCase(), title: req[3].trim() || req[2], feature, description: '', criteria: [], issues: [], source: { file, line: i + 1, mode: 'ids' } };
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
    if (line.trim() && !line.trim().startsWith('<!--')) current.description = (current.description ? current.description + ' ' : '') + line.trim();
  });
  return out;
}

function analyse(req: Requirement): Requirement {
  req.issues = [];
  for (const ac of req.criteria) ac.issues = checkText(ac.text, ac.id);
  if (req.criteria.length === 0) {
    req.issues.push({ kind: 'no-criteria', message: 'No acceptance criteria found. Describe what a user does and sees (a list, sentences such as "Customers can …", or Given/When/Then).' });
    req.issues.push(...checkText(`${req.title} ${req.description}`));
  }
  return req;
}

// ---------- documents ----------

export const DOCUMENT_EXTS = ['.md', '.markdown', '.txt', '.docx', '.pdf'];
export const EDITABLE_EXTS = ['.md', '.markdown', '.txt'];
/** Legacy folder for originals of converted documents (v0.4.0); not read. */
export const SOURCES_DIR = '_sources';

export type DocumentType = 'Markdown' | 'Text' | 'Word' | 'PDF';
export const documentType = (file: string): DocumentType => {
  const ext = path.extname(file).toLowerCase();
  return ext === '.docx' ? 'Word' : ext === '.pdf' ? 'PDF' : ext === '.txt' ? 'Text' : 'Markdown';
};

function requirementDocuments(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== SOURCES_DIR && !entry.name.startsWith('.')) out.push(...requirementDocuments(full));
    } else if (DOCUMENT_EXTS.includes(path.extname(entry.name).toLowerCase()) && entry.name.toLowerCase() !== 'readme.md' && !entry.name.startsWith('~$')) {
      out.push(full);
    }
  }
  return out.sort();
}

const sha1 = (buf: Buffer | string) => crypto.createHash('sha1').update(buf).digest('hex');

/** The text of a requirement document as Markdown. Word and PDF conversions are cached by content. */
export async function documentText(project: Project, abs: string): Promise<{ text: string; hash: string; warnings: string[] }> {
  const buf = fs.readFileSync(abs);
  const hash = sha1(buf);
  const type = documentType(abs);
  if (type === 'Markdown') return { text: buf.toString('utf8'), hash, warnings: [] };
  const { textToMarkdown, documentToMarkdown } = await import('./documents.js');
  if (type === 'Text') return { text: textToMarkdown(buf.toString('utf8')), hash, warnings: [] };
  const cache = path.join(project.paths.state, 'doc-cache', `${hash}.md`);
  if (fs.existsSync(cache)) return { text: fs.readFileSync(cache, 'utf8'), hash, warnings: [] };
  const r = await documentToMarkdown(buf, path.basename(abs));
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, r.markdown);
  return { text: r.markdown, hash, warnings: r.warnings };
}

// ---------- AI readings (optional; saved per document version) ----------

export interface ReadingItem {
  id?: string;
  feature?: string;
  title: string;
  description?: string;
  criteria: string[];
}

export interface DocumentReading {
  file: string;
  /** sha1 of the document this reading belongs to; a changed document falls back to the automatic reader. */
  hash: string;
  by: string;
  at: string;
  requirements: ReadingItem[];
}

const readingPath = (project: Project, file: string) => path.join(project.paths.state, 'readings', `${file.replace(/[\\/]/g, '__')}.json`);

export function loadReading(project: Project, file: string): DocumentReading | undefined {
  return readJson<DocumentReading | undefined>(readingPath(project, file), undefined);
}

export function deleteReading(project: Project, file: string): boolean {
  const p = readingPath(project, file);
  if (!fs.existsSync(p)) return false;
  fs.rmSync(p);
  return true;
}

/** Saves requirements an AI read from a document (TraceQA's agent, or an AI coding tool), for this version of it. */
export async function saveReading(project: Project, file: string, requirements: ReadingItem[], by: string): Promise<DocumentReading> {
  const abs = resolveRequirementFile(project, file, true);
  if (!fs.existsSync(abs)) throw Object.assign(new Error(`No requirement document ${file}.`), { status: 404 });
  const items = requirements
    .map((r) => ({ ...r, title: String(r.title ?? '').replace(/\s+/g, ' ').trim(), criteria: (r.criteria ?? []).map((c) => String(c).replace(/\s+/g, ' ').trim()).filter(Boolean) }))
    .filter((r) => r.title);
  if (!items.length) throw new Error('The reading has no requirements.');
  const reading: DocumentReading = { file: rel(project.paths.requirementsDir, abs), hash: sha1(fs.readFileSync(abs)), by, at: now(), requirements: items };
  writeJson(readingPath(project, reading.file), reading);
  return reading;
}

// ---------- stable IDs for requirements without one ----------

interface IdRegistry {
  ids: Record<string, string>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Gives every requirement without an ID a stable one (REQ-001 …): the same document section keeps its ID across
 * imports, as long as its title stays the same. Explicit IDs in documents always win.
 */
function assignIds(project: Project, docs: { file: string; items: ReadRequirement[] }[], save: boolean): Map<ReadRequirement, { id: string; auto: boolean }> {
  const regFile = path.join(project.paths.state, 'requirement-ids.json');
  const reg = readJson<IdRegistry>(regFile, { ids: {} });
  const explicit = new Set(docs.flatMap((d) => d.items.map((i) => i.id).filter((x): x is string => !!x)));
  const used = new Set(explicit);
  const out = new Map<ReadRequirement, { id: string; auto: boolean }>();
  let max = [...explicit, ...Object.values(reg.ids)].map((id) => id.match(/^REQ-(\d+)$/)?.[1]).filter(Boolean).reduce((m, n) => Math.max(m, Number(n)), 0);
  let changed = false;
  for (const d of docs) {
    const seen = new Map<string, number>();
    for (const item of d.items) {
      if (item.id) {
        out.set(item, { id: item.id, auto: false });
        continue;
      }
      const base = `${d.file}|${norm(item.title)}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const key = n > 1 ? `${base}#${n}` : base;
      let id = reg.ids[key];
      if (!id || used.has(id)) {
        id = `REQ-${String(++max).padStart(3, '0')}`;
        while (used.has(id)) id = `REQ-${String(++max).padStart(3, '0')}`;
        reg.ids[key] = id;
        changed = true;
      }
      used.add(id);
      out.set(item, { id, auto: true });
    }
  }
  if (save && changed) writeJson(regFile, reg);
  return out;
}

// ---------- import ----------

export interface DocumentSummary {
  file: string;
  type: DocumentType;
  mode: ReadMode | 'ai';
  requirements: number;
  criteria: number;
  hash: string;
  warnings: string[];
  reading?: { by: string; at: string; stale: boolean };
}

const toRequirement = (item: ReadRequirement, id: string, auto: boolean, sourceFile: string, mode: ReadMode | 'ai'): Requirement => ({
  id,
  title: item.title,
  feature: item.feature,
  description: item.description,
  criteria: item.criteria.map((text, i) => ({ id: `AC${i + 1}`, text, issues: [] })),
  issues: [],
  source: { file: sourceFile, line: item.line, section: item.section, mode },
  autoId: auto || undefined,
});

/** Reads one document; used by import and by the editor preview. */
async function readDocument(project: Project, abs: string, text?: string): Promise<{ mode: ReadMode | 'ai'; items: ReadRequirement[]; hash: string; warnings: string[]; reading?: DocumentReading; stale: boolean }> {
  const file = rel(project.paths.requirementsDir, abs);
  const doc = text !== undefined ? { text, hash: sha1(text), warnings: [] } : await documentText(project, abs);
  const reading = text === undefined ? loadReading(project, file) : undefined;
  if (reading && reading.hash === doc.hash) {
    const items = reading.requirements.map((r) => ({
      // An ID the AI gives is used only if it really appears in the document.
      id: r.id && new RegExp(`^${REQ_ID}$`).test(r.id) && doc.text.includes(r.id) ? r.id.toUpperCase() : undefined,
      feature: r.feature?.trim() || titleCase(file),
      title: r.title,
      description: r.description ?? '',
      criteria: r.criteria,
      line: 0,
    }));
    return { mode: 'ai', items, hash: doc.hash, warnings: doc.warnings, reading, stale: false };
  }
  if (usesIds(doc.text)) {
    const items = parseRequirementsMarkdown(doc.text, file).map((r) => ({ id: r.id, feature: r.feature, title: r.title, description: r.description, criteria: r.criteria.map((c) => c.text), line: r.source.line, acIds: r.criteria.map((c) => c.id) }));
    return { mode: 'ids', items, hash: doc.hash, warnings: doc.warnings, reading, stale: !!reading };
  }
  const read = readRequirements(doc.text, titleCase(file));
  return { mode: read.mode, items: read.items, hash: doc.hash, warnings: doc.warnings, reading, stale: !!reading };
}

export async function importRequirements(project: Project): Promise<{ file: RequirementsFile; files: string[]; duplicates: string[]; documents: DocumentSummary[] }> {
  const docs = requirementDocuments(project.paths.requirementsDir);
  const reads: { abs: string; file: string; r: Awaited<ReturnType<typeof readDocument>> }[] = [];
  for (const abs of docs) {
    try {
      reads.push({ abs, file: rel(project.paths.requirementsDir, abs), r: await readDocument(project, abs) });
    } catch (err) {
      reads.push({ abs, file: rel(project.paths.requirementsDir, abs), r: { mode: 'free-form', items: [], hash: '', warnings: [(err as Error).message], stale: false } });
    }
  }
  const ids = assignIds(project, reads.map((x) => ({ file: x.file, items: x.r.items })), true);
  const all: Requirement[] = [];
  const duplicates: string[] = [];
  const documents: DocumentSummary[] = [];
  for (const { abs, file, r } of reads) {
    let count = 0;
    let criteria = 0;
    for (const item of r.items) {
      const { id, auto } = ids.get(item)!;
      const req = toRequirement(item, id, auto, rel(project.dir, abs), r.mode);
      const acIds = (item as { acIds?: string[] }).acIds;
      if (acIds) req.criteria.forEach((c, i) => (c.id = acIds[i] ?? c.id));
      if (all.some((x) => x.id === req.id)) {
        duplicates.push(req.id);
        continue;
      }
      all.push(analyse(req));
      count++;
      criteria += req.criteria.length;
    }
    documents.push({
      file,
      type: documentType(abs),
      mode: r.mode,
      requirements: count,
      criteria,
      hash: r.hash,
      warnings: r.warnings,
      reading: r.reading ? { by: r.reading.by, at: r.reading.at, stale: r.stale } : undefined,
    });
  }
  applyClarifications(all, loadClarifications(project));
  const file: RequirementsFile = { importedAt: now(), requirements: all };
  writeJson(project.paths.requirements, file);
  writeJson(path.join(project.paths.state, 'documents.json'), { importedAt: file.importedAt, documents });
  return { file, files: reads.map((x) => rel(project.dir, x.abs)), duplicates, documents };
}

export function loadRequirements(project: Project): Requirement[] {
  return readJson<RequirementsFile>(project.paths.requirements, { importedAt: '', requirements: [] }).requirements;
}

/** The requirements read from one document (a path inside the requirements folder). */
export function requirementsFromFile(project: Project, file: string): Requirement[] {
  const abs = path.resolve(project.paths.requirementsDir, file);
  return loadRequirements(project).filter((r) => path.resolve(project.dir, r.source.file) === abs);
}

export function loadDocumentIndex(project: Project): DocumentSummary[] {
  return readJson<{ documents: DocumentSummary[] }>(path.join(project.paths.state, 'documents.json'), { documents: [] }).documents;
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

// ---------- requirement files (for the dashboard) ----------

export const MAX_REQUIREMENT_FILE = 512 * 1024;
const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

/**
 * Resolves a file name safely inside the requirements folder. By default only text files that can be edited
 * (.md, .txt); with anyDocument also Word and PDF.
 */
export function resolveRequirementFile(project: Project, name: string, anyDocument = false): string {
  const clean = String(name ?? '').trim().replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    throw bad('Use a plain file name such as checkout.md (sub-folders are fine, ".." is not).');
  }
  if (!/^[\w .()\-/]+$/.test(clean)) throw bad('File names may use letters, numbers, spaces, dots, brackets, dashes and underscores.');
  const ext = path.extname(clean).toLowerCase();
  const allowed = anyDocument ? DOCUMENT_EXTS : EDITABLE_EXTS;
  if (!allowed.includes(ext)) throw bad(anyDocument ? 'Requirement documents are .md, .txt, .docx or .pdf files.' : 'Requirement files you edit here end in .md or .txt.');
  if (path.basename(clean).toLowerCase() === 'readme.md') throw bad('README.md is not read as requirements; pick another name.');
  if (clean.split('/')[0] === SOURCES_DIR) throw bad(`${SOURCES_DIR}/ is not read as requirements; save files outside it.`);
  const root = path.resolve(project.paths.requirementsDir);
  const full = path.resolve(root, clean);
  if (!full.startsWith(root + path.sep)) throw bad('The file must be inside the requirements folder.');
  return full;
}

/** Where a requirement file came from, from its first-line comment. */
export function fileOrigin(name: string, text: string): { origin: 'written' | 'document' | 'ai' | 'jira' | 'discovered'; from?: string } {
  if (path.basename(name) === DISCOVERED_FILE) return { origin: 'discovered' };
  const conv = text.match(/^<!-- Converted from (.+?) (?:\((\w+)\)|by AI)/);
  if (conv) return { origin: conv[2] ? 'document' : 'ai', from: conv[1] };
  if (/^<!-- Synced from Jira/.test(text)) return { origin: 'jira' };
  return { origin: 'written' };
}

export function listRequirementFiles(project: Project): (Omit<DocumentSummary, 'hash'> & { size: number; updatedAt: string; editable: boolean; origin: string; changed: boolean })[] {
  const index = new Map(loadDocumentIndex(project).map((d) => [d.file, d]));
  return requirementDocuments(project.paths.requirementsDir).map((abs) => {
    const file = rel(project.paths.requirementsDir, abs);
    const stat = fs.statSync(abs);
    const d = index.get(file);
    const editable = EDITABLE_EXTS.includes(path.extname(abs).toLowerCase());
    const head = editable ? fs.readFileSync(abs, 'utf8').slice(0, 200) : '';
    return {
      file,
      type: documentType(abs),
      mode: d?.mode ?? 'free-form',
      requirements: d?.requirements ?? 0,
      criteria: d?.criteria ?? 0,
      warnings: d?.warnings ?? [],
      reading: d?.reading,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      editable,
      origin: fileOrigin(file, head).origin,
      changed: !d,
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

/** Moves a requirement document to .traceqa/trash/ instead of deleting it, so it can be recovered. */
export function trashRequirementFile(project: Project, name: string): string {
  const file = resolveRequirementFile(project, name, true);
  if (!fs.existsSync(file)) throw Object.assign(new Error(`No requirement file ${name}.`), { status: 404 });
  const stamp = now().replace(/[:.]/g, '-');
  const target = path.join(project.paths.state, 'trash', `${stamp}-${path.basename(file)}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(file, target);
  deleteReading(project, rel(project.paths.requirementsDir, file));
  return rel(project.dir, target);
}

/** What TraceQA would read from text being edited, with the IDs it would get, without saving anything. */
export async function previewRequirements(project: Project, content: string, name: string): Promise<{ mode: ReadMode | 'ai'; requirements: Requirement[] }> {
  const abs = path.join(project.paths.requirementsDir, name || 'new.md');
  const text = path.extname(name).toLowerCase() === '.txt' ? (await import('./documents.js')).textToMarkdown(content) : content;
  const r = await readDocument(project, abs, text);
  // Other documents' explicit IDs and the registry decide which IDs are free; nothing is written.
  const others = loadRequirements(project).filter((q) => q.source.file !== rel(project.dir, abs));
  const ids = assignIds(project, [{ file: '\u0000others', items: others.filter((q) => !q.autoId).map((q) => ({ id: q.id, feature: q.feature, title: q.title, description: '', criteria: [], line: 0 })) }, { file: rel(project.paths.requirementsDir, abs), items: r.items }], false);
  return { mode: r.mode, requirements: r.items.map((item) => analyse(toRequirement(item, ids.get(item)!.id, ids.get(item)!.auto, rel(project.dir, abs), r.mode))) };
}

/** A free file name like `wanted` (spec.docx, spec-2.docx, …) inside the requirements folder. */
export function freeDocumentName(project: Project, wanted: string): string {
  const ext = path.extname(wanted);
  const base = wanted.slice(0, wanted.length - ext.length);
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}${ext}` : `${base}-${i}${ext}`;
    if (!fs.existsSync(resolveRequirementFile(project, name, true))) return name;
  }
}

// ---------- discovered flows (exploration without requirements) ----------

export const DISCOVERED_FILE = 'discovered-flows.md';

/**
 * Records a user flow found while exploring without a requirement, as an E2E-### requirement in
 * requirements/discovered-flows.md, so tests for it are traced like any other requirement.
 * The criteria describe what the app does today; a person should confirm that it is the intended behaviour.
 */
export async function addDiscoveredFlow(project: Project, input: { title: string; description?: string; criteria: string[] }): Promise<Requirement> {
  const title = input.title.replace(/\s+/g, ' ').trim();
  const criteria = input.criteria.map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!title) throw new Error('A flow needs a title.');
  if (!criteria.length) throw new Error('A flow needs at least one criterion: what the user should see.');
  const file = resolveRequirementFile(project, DISCOVERED_FILE);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const known = [...loadRequirements(project).map((r) => r.id), ...parseRequirementsMarkdown(existing, DISCOVERED_FILE).map((r) => r.id)];
  const max = known.map((id) => id.match(/^E2E-(\d+)$/)?.[1]).filter(Boolean).reduce((m, n) => Math.max(m, Number(n)), 0);
  const id = `E2E-${String(max + 1).padStart(3, '0')}`;
  const header = existing.trim()
    ? existing.trimEnd()
    : `<!-- Flows TraceQA found while exploring the app without a requirement. They describe what the app does today:\n     check each one with the team, edit it if the intended behaviour differs, and move it into a real requirement file when it is agreed. -->\n# Discovered flows`;
  const block = [`## ${id} ${title}`, ...(input.description?.trim() ? [input.description.replace(/\s+/g, ' ').trim()] : []), ...criteria.map((c, i) => `- AC${i + 1}: ${c}`)].join('\n');
  writeRequirementFile(project, DISCOVERED_FILE, `${header}\n\n${block}\n`);
  const imported = (await importRequirements(project)).file.requirements.find((r) => r.id === id);
  if (!imported) throw new Error(`${id} was written but could not be read back.`);
  return imported;
}
