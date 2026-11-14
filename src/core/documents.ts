import fs from 'node:fs';
import path from 'node:path';
import type { Project } from './config.js';
import { REQ_ID } from './reader.js';
import { freeDocumentName, importRequirements, resolveRequirementFile } from './requirements.js';

// Requirement documents: Word (.docx), PDF, plain text and Markdown are read as they are. This file turns
// Word and PDF into Markdown text (headings, lists and tables kept) for the requirement reader; the original
// document is never changed.

export const DOCUMENT_TYPES = ['.md', '.markdown', '.txt', '.docx', '.pdf'];
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const BULLET = /^\s*(?:[-*+•●◦▪▫■□‣⁃–]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s+/;
/**
 * IDs found in documents, normalised to PREFIX-123. In running text an ID needs a dash or underscore
 * (FR-12, REQ_003) so that "Q3 2026" or "HTTP 404" stay text; in headings and table ID columns
 * a space is fine too (US 7 → US-7).
 */
const STRICT_ID = /^([A-Z][A-Z0-9]{0,15})[_-](\d[A-Za-z0-9_-]*)\b[\s:.)\-–—]*(.*)$/;
const LOOSE_ID = /^([A-Z][A-Z0-9]{0,15})[\s_-]?(\d[A-Za-z0-9_-]*)\b[\s:.)\-–—]*(.*)$/;

function normaliseId(text: string, loose = false): { id: string; rest: string } | undefined {
  const m = text.trim().match(loose ? LOOSE_ID : STRICT_ID);
  if (!m) return undefined;
  const id = `${m[1]}-${m[2]}`;
  return new RegExp(`^${REQ_ID}$`).test(id) ? { id, rest: m[3].trim() } : undefined;
}

const decode = (s: string) =>
  s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').trim();

/** Rows of a table as plain cell text. */
function tableRows(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => decode(c[1].replace(/<\/p>\s*<p[^>]*>/gi, '\n'))));
}

/** A requirements table (first column holds IDs) becomes headings with criteria; any other table becomes text lines. */
function tableToMarkdown(rows: string[][]): string[] {
  if (!rows.length) return [];
  const [head, ...body] = rows;
  const idRows = body.filter((r) => r[0] && normaliseId(r[0], true));
  if (idRows.length && idRows.length >= Math.ceil(body.length / 2)) {
    const out: string[] = [];
    const titleCol = head.findIndex((h, i) => i > 0 && /title|name|summary|requirement|story|description/i.test(h));
    const acCols = head.map((h, i) => (/accept|criteria|\bac\b|expected|verification/i.test(h) ? i : -1)).filter((i) => i > 0);
    for (const r of body) {
      const id = normaliseId(r[0] ?? '', true);
      if (!id) continue;
      const ti = titleCol > 0 ? titleCol : 1;
      const title = (id.rest || r[ti] || '').split('\n')[0];
      out.push('', `## ${id.id} ${title}`);
      r.forEach((cell, i) => {
        if (i === 0 || !cell || (i === ti && !id.rest && cell.split('\n')[0] === title && !cell.includes('\n'))) return;
        if (acCols.includes(i)) for (const line of cell.split('\n').map((l) => l.replace(BULLET, '').trim()).filter(Boolean)) out.push(`- ${line}`);
        else out.push(`${head[i] ? `${head[i]}: ` : ''}${cell.replace(/\n+/g, ' ')}`);
      });
    }
    return out;
  }
  return rows.map((r) => r.filter(Boolean).join(' | ')).filter(Boolean);
}

const BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li']);

/** The HTML mammoth produces from Word → Markdown that TraceQA can read. Nested lists are flattened. */
export function htmlToMarkdown(html: string): string {
  const out: string[] = [];
  let type: string | null = null;
  let buf = '';
  const flush = () => {
    const text = decode(buf);
    buf = '';
    if (!text) return;
    if (type && type.startsWith('h')) {
      const id = normaliseId(text, true);
      // A heading that starts with an ID is a requirement; other headings name features and sections.
      out.push('', id ? `## ${id.id} ${id.rest}` : `${'#'.repeat(Math.min(Number(type[1]), 3))} ${text}`, '');
    } else if (type === 'li') {
      out.push(`- ${text.replace(/\n+/g, ' ')}`);
    } else {
      for (const line of text.split('\n')) out.push(lineToMarkdown(line));
    }
  };
  for (const m of html.matchAll(/<table[\s\S]*?<\/table>|<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>|[^<]+/g)) {
    const tok = m[0];
    if (/^<table/i.test(tok)) {
      flush();
      out.push('', ...tableToMarkdown(tableRows(tok)), '');
      continue;
    }
    const tag = m[1]?.toLowerCase();
    if (!tag) {
      buf += tok;
      continue;
    }
    if (tag === 'br') buf += '\n';
    else if (BLOCK_TAGS.has(tag)) {
      flush();
      type = tok.startsWith('</') ? null : tag;
    } else if (tag === 'ul' || tag === 'ol') {
      flush();
      out.push('');
    }
  }
  flush();
  return tidy(out.join('\n'));
}

/** One line of plain text: IDs at the start make a requirement heading; bullet markers become "- ". */
function lineToMarkdown(line: string): string {
  const t = line.trim();
  if (!t) return '';
  if (BULLET.test(t)) return `- ${t.replace(BULLET, '').trim()}`;
  const id = normaliseId(t);
  if (id && id.rest) return `\n## ${id.id} ${id.rest}`;
  return t;
}

function tidy(md: string): string {
  return md.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function textToMarkdown(text: string): string {
  return tidy(text.split(/\r?\n/).map(lineToMarkdown).join('\n'));
}

/** PDF text with line breaks; larger text becomes headings. Uses Mozilla's pdf.js. */
export async function pdfToMarkdown(buffer: Buffer): Promise<{ markdown: string; pages: number }> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const lines: { text: string; size: number }[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let text = '';
    let size = 0;
    let lastY: number | undefined;
    const flush = () => {
      if (text.trim()) lines.push({ text: text.replace(/\s+/g, ' ').trim(), size });
      text = '';
      size = 0;
    };
    for (const item of content.items as { str?: string; transform?: number[]; hasEOL?: boolean; height?: number }[]) {
      if (typeof item.str !== 'string') continue;
      const y = item.transform?.[5];
      if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 2) flush();
      text += item.str;
      size = Math.max(size, Math.abs(item.transform?.[3] ?? item.height ?? 0));
      lastY = y;
      if (item.hasEOL) flush();
    }
    flush();
    page.cleanup();
  }
  const pages = doc.numPages;
  await task.destroy();
  const sizes = lines.map((l) => l.size).filter((s) => s > 0).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 12;
  const md = lines.map((l) => {
    const id = normaliseId(l.text);
    if (id && id.rest && !BULLET.test(l.text)) return `\n## ${id.id} ${id.rest}`;
    if (l.size >= body * 1.5) return `\n# ${l.text}\n`;
    if (l.size >= body * 1.2) return `\n### ${l.text}\n`;
    return lineToMarkdown(l.text);
  });
  return { markdown: tidy(md.join('\n')), pages };
}

export async function documentToMarkdown(buffer: Buffer, name: string): Promise<{ markdown: string; kind: string; warnings: string[] }> {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.doc') throw Object.assign(new Error('Old Word .doc files are not supported. Save the document as .docx (Word: File → Save As), then upload that.'), { status: 400 });
  if (!DOCUMENT_TYPES.includes(ext)) throw Object.assign(new Error(`Upload a Word (.docx), PDF, text or Markdown file. ${ext || 'This file'} is not supported.`), { status: 400 });
  if (buffer.length > MAX_DOCUMENT_BYTES) throw Object.assign(new Error('Documents are limited to 25 MB.'), { status: 413 });
  if (ext === '.md' || ext === '.markdown') return { markdown: buffer.toString('utf8'), kind: 'Markdown', warnings: [] };
  if (ext === '.txt') return { markdown: textToMarkdown(buffer.toString('utf8')), kind: 'text', warnings: [] };
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const result = await (mammoth.default ?? mammoth).convertToHtml({ buffer });
    const warnings = result.messages.filter((m: { type: string }) => m.type === 'error').map((m: { message: string }) => m.message);
    return { markdown: htmlToMarkdown(result.value), kind: 'Word', warnings };
  }
  try {
    const { markdown, pages } = await pdfToMarkdown(buffer);
    const warnings = markdown.trim() ? [] : [`No text found in ${pages} page(s). Scanned PDFs need text recognition (OCR) first.`];
    return { markdown, kind: 'PDF', warnings };
  } catch (err) {
    throw Object.assign(new Error(`Could not read this PDF: ${(err as Error).message}`), { status: 400 });
  }
}

export interface DocumentImport {
  file: string;
  kind: string;
  requirements: number;
  criteria: number;
  mode: string;
  /** Few or no requirements were found: reading it with AI may do better. */
  suggestAi: boolean;
  warnings: string[];
}

const SAFE_NAME = /[^A-Za-z0-9 ._()-]+/g;

/** Saves an uploaded document into requirements/ as it is (no conversion, no rewriting) and imports it. */
export async function importDocument(project: Project, originalName: string, buffer: Buffer): Promise<DocumentImport> {
  const name = path.basename(originalName).replace(SAFE_NAME, '-').replace(/^-+/, '') || 'document';
  // Check that it can be read before saving it (wrong type, old .doc, unreadable PDF).
  const { kind, warnings } = await documentToMarkdown(buffer, name);
  const target = freeDocumentName(project, name.toLowerCase().endsWith('.markdown') ? name.replace(/\.markdown$/i, '.md') : name);
  const abs = resolveRequirementFile(project, target, true);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  const r = await importRequirements(project);
  const doc = r.documents.find((d) => d.file === target);
  const count = doc?.requirements ?? 0;
  return { file: target, kind, requirements: count, criteria: doc?.criteria ?? 0, mode: doc?.mode ?? 'free-form', suggestAi: count === 0 || (doc?.criteria ?? 0) === 0, warnings: [...warnings, ...(doc?.warnings ?? [])] };
}
