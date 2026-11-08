import path from 'node:path';

// Turns uploaded requirement documents (Markdown, plain text, Word .docx, PDF) into the Markdown format
// TraceQA reads: "## REQ-142 Title" headings with acceptance criteria as bullets underneath.
// Markdown is kept exactly as written; the other formats are converted and then tidied up so that
// requirement IDs, bullets and "Acceptance criteria" sub-headings land where the parser expects them.

export const MAX_UPLOAD = 20 * 1024 * 1024;

export type DocumentFormat = 'markdown' | 'text' | 'word' | 'pdf';

export interface ConvertedDocument {
  /** Name for the file in the requirements folder (always .md). */
  file: string;
  format: DocumentFormat;
  markdown: string;
  /** Things worth telling the person, e.g. that a PDF has no text in it. */
  notes: string[];
}

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** "Checkout Requirements v2.docx" → "Checkout Requirements v2.md", using only characters a requirement file name may have. */
export function requirementFileName(original: string): string {
  const base = path.posix.basename(String(original ?? '').replace(/\\/g, '/'));
  let stem = base
    .replace(/\.[^.]*$/, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w .-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .slice(0, 80)
    .trim();
  if (!stem) stem = 'requirements';
  if (stem.toLowerCase() === 'readme') stem = 'readme-requirements'; // README.md is never read as requirements
  return `${stem}.md`;
}

export function documentFormat(name: string): DocumentFormat {
  const ext = path.extname(String(name ?? '')).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.txt') return 'text';
  if (ext === '.docx') return 'word';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.doc') throw fail(415, 'Old Word files (.doc) cannot be read. Open the file in Word, save it as .docx, and upload that.');
  throw fail(415, `TraceQA can read .md, .txt, .docx and .pdf files, not ${ext ? `${ext} files` : 'files without an extension'}.`);
}

/** Text files from Windows editors are often UTF-16 or Windows-1252 rather than UTF-8. */
export function decodeText(data: Buffer): string {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return data.subarray(3).toString('utf8');
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('windows-1252').decode(data);
  }
}

// ---------- tidying converted text ----------

const REQ_START = /^(?:(?:[-*+]|\d+(?:\.\d+)*[.)]?)\s+)?(REQ-[A-Za-z0-9_-]+)(?:\s*[:\-–—.)]\s*|\s+|$)(.*)$/i;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
/** Bullet characters Word, PDFs and other tools use instead of "-" (including the Symbol and Wingdings ones). */
const GLYPH_BULLET = /^(\s*)(?:[•●○◦▪▫■□‣⁃∙·➢➤►▶✓✔☐☑]\s*|[–—]\s+|o\s+(?=[A-Z]))/;
const AC_LINE = /^AC[-\s]?\d+\s*[:.)\-–—]/i;
const CRITERIA_LABEL = /^(?:acceptance\s+criteria|criteria|acs?|conditions\s+of\s+satisfaction)\s*:?$/i;
const SECTION_LABEL = /^(?:description|details|notes?)\s*:?$/i;
const PAGE_NUMBER = /^(?:page\s+)?\d+(?:\s*(?:of|\/)\s*\d+)?$/i;

/**
 * Makes converted text readable as TraceQA requirements:
 * - a line or heading that starts with an ID such as REQ-142 becomes "## REQ-142 Title";
 * - other headings become "# Feature" headings, except sub-headings inside a requirement
 *   ("Acceptance criteria", "Notes" …), which would otherwise end it;
 * - bullet characters (•, ▪, –, Word's Symbol bullets) become "- ", and "AC1: …" lines become bullets;
 * - with joinWrapped (PDFs), lines that were only wrapped by the page width are joined again.
 */
export function normalizeRequirementText(text: string, opts: { joinWrapped?: boolean } = {}): string {
  const out: string[] = [];
  /** Heading level that ends the current requirement; undefined outside a requirement. */
  let boundary: number | undefined;
  /** Level of the latest heading that is not a requirement, i.e. the section a plain "REQ-…" line lives in. */
  let sectionLevel = 0;
  const seen = new Set<string>();
  const lastLine = () => out[out.length - 1] ?? '';

  for (const raw of text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/\t/g, '  ').split('\n')) {
    let line = raw.replace(/\s+$/, '');
    const t = line.trim();
    if (!t) {
      if (lastLine() !== '') out.push('');
      continue;
    }
    if (opts.joinWrapped && PAGE_NUMBER.test(t)) continue;

    const heading = t.match(HEADING);
    const headingText = heading ? heading[2].trim() : t;
    const req = headingText.match(REQ_START);
    // An ID seen before is a cross-reference ("REQ-100 must pass first"), not a new requirement.
    if (req && !seen.has(req[1].toUpperCase())) {
      seen.add(req[1].toUpperCase());
      out.push(`## ${req[1].toUpperCase()}${req[2].trim() ? ` ${req[2].trim()}` : ''}`);
      // A plain "REQ-…" line belongs to the section above it; with no section, any top-level heading ends it.
      boundary = heading ? heading[1].length : Math.max(sectionLevel, 1);
      continue;
    }
    if (heading) {
      const level = heading[1].length;
      if (boundary !== undefined && level > boundary) {
        // A sub-heading inside a requirement: keep its words, but not as a heading.
        if (!CRITERIA_LABEL.test(headingText) && !SECTION_LABEL.test(headingText)) out.push(headingText);
        continue;
      }
      boundary = undefined;
      sectionLevel = level;
      out.push(`# ${headingText}`);
      continue;
    }
    if (boundary !== undefined && (CRITERIA_LABEL.test(t) || SECTION_LABEL.test(t))) continue;

    const glyph = line.match(GLYPH_BULLET);
    if (glyph) line = `${glyph[1]}- ${line.slice(glyph[0].length).trim()}`;
    else if (AC_LINE.test(t)) line = `- ${t}`;

    const isBullet = BULLET.test(line);
    const prev = lastLine();
    if (opts.joinWrapped && !isBullet && prev && !/^#/.test(prev) && BULLET.test(prev) && (/^[a-z(]/.test(t) || !/[.!?:;]$/.test(prev))) {
      out[out.length - 1] = `${prev} ${t}`;
      continue;
    }
    if (opts.joinWrapped && !isBullet && /^## REQ-/.test(prev) && /^[a-z]/.test(t)) {
      out[out.length - 1] = `${prev} ${t}`; // a title that wrapped onto a second line
      continue;
    }
    out.push(isBullet ? line : t);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  while (out.length && out[0] === '') out.shift();
  return out.length ? `${out.join('\n')}\n` : '';
}

// ---------- Word (.docx): mammoth gives clean HTML, which is turned into Markdown here ----------

type HtmlNode = string | { tag: string; children: HtmlNode[] };
type HtmlElement = Exclude<HtmlNode, string>;

const VOID_TAGS = new Set(['br', 'img', 'hr', 'col', 'wbr']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** A small, forgiving parser for the well-formed HTML subset mammoth writes. */
export function parseHtml(html: string): HtmlNode[] {
  const root: HtmlElement = { tag: '#root', children: [] };
  const stack: HtmlElement[] = [root];
  for (const m of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>|([^<]+)|</g)) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) {
      top.children.push(decodeEntities(m[4]));
      continue;
    }
    if (!m[2]) {
      if (m[0] === '<') top.children.push('<');
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const i = stack.map((n) => n.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
      continue;
    }
    const node: HtmlElement = { tag, children: [] };
    top.children.push(node);
    if (!m[3] && !VOID_TAGS.has(tag)) stack.push(node);
  }
  return root.children;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Visible text of a node; <br> becomes a line break and images are dropped. */
function inlineText(node: HtmlNode): string {
  if (typeof node === 'string') return node;
  if (node.tag === 'br') return '\n';
  if (node.tag === 'img') return '';
  return node.children.map(inlineText).join('');
}

const isList = (n: HtmlNode): n is HtmlElement & { tag: 'ul' | 'ol' } => typeof n !== 'string' && (n.tag === 'ul' || n.tag === 'ol');

function listLines(list: HtmlElement, depth: number, out: string[]): void {
  for (const li of list.children) {
    if (typeof li === 'string' || li.tag !== 'li') continue;
    const own = squash(li.children.filter((c) => !isList(c)).map(inlineText).join(' '));
    if (own) out.push(`${'  '.repeat(depth)}- ${own}`);
    for (const c of li.children) if (isList(c)) listLines(c, depth + 1, out);
  }
}

/** The text lines of a table cell: one per paragraph or list item. */
function cellLines(cell: HtmlElement): string[] {
  const lines: string[] = [];
  const walk = (nodes: HtmlNode[]) => {
    for (const n of nodes) {
      if (typeof n === 'string') {
        if (squash(n)) lines.push(squash(n));
      } else if (isList(n)) {
        const items: string[] = [];
        listLines(n, 0, items);
        lines.push(...items.map((l) => l.replace(/^\s*-\s+/, '')));
      } else if (n.tag === 'p' || /^h[1-6]$/.test(n.tag)) {
        for (const l of inlineText(n).split('\n')) if (squash(l)) lines.push(squash(l));
      } else walk(n.children);
    }
  };
  walk(cell.children);
  return lines;
}

function descendants(node: HtmlElement, tag: string): HtmlElement[] {
  const found: HtmlElement[] = [];
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    if (c.tag === tag) found.push(c);
    else if (c.tag !== 'table') found.push(...descendants(c, tag)); // nested tables are handled as cell text
  }
  return found;
}

type Column = 'id' | 'title' | 'criteria' | 'description' | 'other';

function columnRole(header: string): Column | undefined {
  const h = header.toLowerCase();
  if (/\bid\b|^#$|^no\.?$|number|\bkey\b|\bref/.test(h)) return 'id';
  if (/accept|criteri|\bacs?\b|condition/.test(h)) return 'criteria';
  if (/desc|detail|story|notes?|rationale/.test(h)) return 'description';
  if (/title|name|requirement|summary|feature/.test(h)) return 'title';
  return undefined;
}

/**
 * Requirement tables (ID | Title | Description | Acceptance criteria) become one requirement per row.
 * Other tables become plain lines with the cells separated by " · ".
 */
function tableLines(table: HtmlElement, out: string[]): void {
  const rows = descendants(table, 'tr').map((tr) => tr.children.filter((c): c is HtmlElement => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th')).map(cellLines));
  if (!rows.length) return;
  const roles = rows[0].map((cell) => columnRole(cell.join(' ')));
  const hasHeader = !rows[0].some((cell) => REQ_START.test(cell.join(' '))) && roles.some(Boolean);
  for (const cells of hasHeader ? rows.slice(1) : rows) {
    const idAt = cells.findIndex((c) => /^REQ-[A-Za-z0-9_-]+/i.test(c[0] ?? ''));
    if (idAt < 0) {
      const line = cells.map((c) => c.join(' ')).filter(Boolean).join(' · ');
      if (line) out.push(line);
      continue;
    }
    const m = cells[idAt][0].match(REQ_START)!;
    let title = squash(m[2]);
    const description: string[] = [...cells[idAt].slice(1)];
    const criteria: string[] = [];
    cells.forEach((lines, i) => {
      if (i === idAt || !lines.length) return;
      if (hasHeader) {
        if (roles[i] === 'title' && !title) title = lines.join(' ');
        else if (roles[i] === 'criteria') criteria.push(...lines);
        else description.push(...lines); // description, notes, or a column TraceQA does not know
      } else if (!title) {
        // No header row: the first cell after the ID is the title …
        title = lines[0];
        criteria.push(...lines.slice(1));
      } else criteria.push(...lines); // … and the other cells are criteria.
    });
    out.push('', `## ${m[1].toUpperCase()}${title ? ` ${title}` : ''}`, ...description, ...criteria.map((c) => `- ${c}`), '');
  }
}

function blockLines(nodes: HtmlNode[], out: string[]): void {
  for (const n of nodes) {
    if (typeof n === 'string') {
      if (squash(n)) out.push(squash(n));
      continue;
    }
    const h = n.tag.match(/^h([1-6])$/);
    if (h) out.push('', `${'#'.repeat(Number(h[1]))} ${squash(inlineText(n))}`, '');
    else if (n.tag === 'p') {
      for (const l of inlineText(n).split('\n')) if (squash(l)) out.push(squash(l));
      out.push('');
    } else if (isList(n)) {
      listLines(n, 0, out);
      out.push('');
    } else if (n.tag === 'table') {
      tableLines(n, out);
      out.push('');
    } else if (n.tag !== 'img' && n.tag !== 'br') blockLines(n.children, out);
  }
}

export function htmlToMarkdown(html: string): string {
  const out: string[] = [];
  blockLines(parseHtml(html), out);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

async function wordToMarkdown(data: Buffer): Promise<string> {
  if (data.subarray(0, 4).toString('binary') !== 'PK\x03\x04') throw fail(400, 'This file is not a Word document (.docx). If it opens in Word, save it again as .docx and upload that.');
  const mammoth = (await import('mammoth')).default;
  try {
    const result = await mammoth.convertToHtml(
      { buffer: data },
      { ignoreEmptyParagraphs: true, convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
    );
    return htmlToMarkdown(result.value);
  } catch (err) {
    throw fail(400, `Could not read the Word document: ${(err as Error).message}`);
  }
}

// ---------- PDF: text items with positions become lines, a blank line where the gap is wide ----------

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  hasEOL?: boolean;
}

/** Rebuilds the lines of one PDF page from its text items. */
export function pdfPageText(items: PdfTextItem[]): string {
  const lines: { text: string; y: number; size: number }[] = [];
  let cur: { text: string; y: number; size: number; end: number } | undefined;
  for (const it of items) {
    const size = it.fontSize || it.height || 10;
    if (!it.str) {
      if (it.hasEOL && cur) {
        lines.push(cur);
        cur = undefined;
      }
      continue;
    }
    if (cur && Math.abs(it.y - cur.y) > size * 0.5) {
      lines.push(cur);
      cur = undefined;
    }
    if (!cur) {
      if (!it.str.trim()) continue;
      cur = { text: '', y: it.y, size, end: it.x };
    }
    if (cur.text && !/\s$/.test(cur.text) && !/^\s/.test(it.str) && it.x - cur.end > size * 0.15) cur.text += ' ';
    cur.text += it.str;
    cur.end = it.x + it.width;
    if (it.hasEOL) {
      lines.push(cur);
      cur = undefined;
    }
  }
  if (cur) lines.push(cur);
  const out: string[] = [];
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    if (prev && prev.y - l.y > Math.max(prev.size, l.size) * 1.6) out.push('');
    out.push(squash(l.text));
  });
  return out.join('\n');
}

async function pdfToText(data: Buffer): Promise<string> {
  if (data.subarray(0, 1024).indexOf('%PDF-') < 0) throw fail(400, 'This file is not a PDF.');
  const { extractTextItems } = await import('unpdf');
  try {
    const { items } = await extractTextItems(new Uint8Array(data));
    return items.map((page) => pdfPageText(page)).join('\n\n');
  } catch (err) {
    const e = err as Error;
    if (e.name === 'PasswordException') throw fail(400, 'This PDF is password-protected. Remove the password (or export it again without one) and upload it again.');
    throw fail(400, `Could not read the PDF: ${e.message}`);
  }
}

// ---------- entry point ----------

/** Converts an uploaded file to TraceQA requirement Markdown. Throws errors with an HTTP status for bad input. */
export async function convertRequirementDocument(name: string, data: Buffer): Promise<ConvertedDocument> {
  const format = documentFormat(name);
  const file = requirementFileName(name);
  const notes: string[] = [];
  if (!data.length) throw fail(400, `${path.basename(name)} is empty.`);
  let markdown: string;
  switch (format) {
    case 'markdown':
      markdown = decodeText(data).replace(/\r\n?/g, '\n');
      break;
    case 'text':
      markdown = normalizeRequirementText(decodeText(data));
      break;
    case 'word':
      markdown = normalizeRequirementText(await wordToMarkdown(data));
      notes.push('Converted from Word. Images, colours and comments are left out.');
      break;
    case 'pdf': {
      const text = await pdfToText(data);
      if (!text.trim()) {
        notes.push('This PDF has no text in it (it may be a scan). Upload the original Word or text document instead.');
        markdown = '';
      } else {
        markdown = normalizeRequirementText(text, { joinWrapped: true });
        notes.push('Converted from PDF. Check line breaks and bullets in the file before relying on it.');
      }
      break;
    }
  }
  return { file, format, markdown, notes };
}
