// Reads requirements from documents written in any format: headings with or without IDs, user stories,
// bullet and numbered lists, Given/When/Then scenarios, tables and plain sentences. No AI involved.
//
// - A document that uses IDs in its headings (## REQ-142 Title) is read exactly as before ("ids" mode).
// - Anything else is read "free-form": headings become requirements; bullets, numbered items, scenarios and
//   sentences that describe behaviour ("must", "can", "shows", "within 2 seconds" …) become acceptance criteria.

/**
 * A requirement ID: REQ-142, a Jira key such as SHOP-142, or a discovered flow such as E2E-001.
 * An uppercase prefix, a dash, and a part that contains at least one digit.
 */
export const REQ_ID = '[A-Z][A-Z0-9]{0,15}-[A-Za-z0-9_]*\\d[A-Za-z0-9_-]*';

export interface ReadRequirement {
  /** Only when the document itself gives one; otherwise TraceQA assigns a stable ID. */
  id?: string;
  feature: string;
  title: string;
  description: string;
  criteria: string[];
  line: number;
  /** Heading path, e.g. "Checkout › Coupon codes". */
  section?: string;
}

export type ReadMode = 'ids' | 'free-form';

type Block =
  | { kind: 'h'; level: number; text: string; line: number }
  | { kind: 'li'; text: string; line: number }
  | { kind: 'p'; text: string; line: number }
  | { kind: 'table'; rows: string[][]; line: number };

const ID_HEADING = new RegExp(`^#{1,6}\\s+(${REQ_ID})\\b`, 'm');
const ID_AT_START = new RegExp(`^(${REQ_ID})\\s*[:\\-–—.)]?\\s*(.*)$`);
const BULLET = /^\s*(?:[-*+•●◦▪▫■□‣⁃–]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s+/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Sections that describe the document, not the product. */
const SKIP = /^(introduction|overview|purpose|scope|background|context|glossary|definitions?|terms|abbreviations|acronyms|revision history|version history|change ?log|document (control|history|information)|table of contents|contents|assumptions|dependencies|constraints|out of scope|non[- ]goals|references|appendix|appendices|approvals?|sign[- ]?off|stakeholders|team|contacts?|open questions|risks|timeline|milestones|summary)\b/i;
/** Sub-headings that belong to the requirement above them. */
const SUBSECTION = /^(acceptance criteria|acceptance tests?|criteria|ac|business rules?|rules|validations?|validation rules|scenarios?|test scenarios|examples?|expected (results?|behaviou?r|outcomes?)|conditions|definition of done|notes|details|requirements?|behaviou?r|error (handling|messages|cases)|edge cases)\b/i;
/** Sentences that describe something a test can check. */
const BEHAVIOUR = /\b(must|shall|should|will|can(?:not)?|can't|cannot|may not|won't|is able to|are able to|able to|needs? to|has to|have to|is required|are required|only|never|always|at least|at most|no more than|up to|within|less than|more than|shows?|displays?|appears?|lists?|redirects?|navigates?|opens?|closes?|returns?|sends?|rejects?|accepts?|allows?|prevents?|blocks?|expires?|requires?|contains?|updates?|adds?|removes?|reduces?|increases?|calculates?|validates?|saves?|deletes?|disables?|enables?|is (shown|displayed|visible|hidden|disabled|enabled|required|sent|saved|removed|added|applied)|are (shown|displayed|visible|hidden|listed|applied)|(?:is|are|isn't|aren't)(?: not)? (?:case[- ]?(?:in)?sensitive|mandatory|optional|unique|valid|invalid|available|unavailable|locked|unlocked|free|limited|editable|read-only|sorted|selected|checked|unchecked|empty|pre-?filled|rounded|capped|greyed out|grayed out))\b/i;
const INTRO = /^(we (want|would like|need to|aim|plan|believe)|our goal|the (purpose|goal|aim|objective) of|this (document|section|page|spec|specification|brief) |in this (document|section)|note\b|for example\b|e\.g\.|see |please )/i;
const STORY = /^as an? ([^,]+?),?\s+i (?:want|need|would like|wish)(?: to)?\s+(.+?)(?:,?\s+so (?:that|i can)\s+(.+))?$/i;
const GHERKIN = /^(scenario(?: outline)?|given|when|then|and|but)\b/i;

const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/\*\*|__|`/g, '').trim();
const stripNumbering = (s: string) => s.replace(/^(?:\d+(?:\.\d+)*\.?|[A-Z]\.|[ivx]+\.)\s+/i, '').trim();
const shorten = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function splitSentences(text: string): string[] {
  return clean(text)
    .split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toBlocks(text: string): Block[] {
  const lines = text.replace(/<!--[\s\S]*?-->/g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length)).split(/\r?\n/);
  const blocks: Block[] = [];
  let para: { text: string; line: number } | null = null;
  const endPara = () => {
    if (para) blocks.push({ kind: 'p', text: para.text, line: para.line });
    para = null;
  };
  lines.forEach((raw, i) => {
    const line = raw.replace(/\t/g, '  ');
    const t = line.trim();
    const n = i + 1;
    if (!t) return endPara();
    const h = t.match(HEADING);
    if (h) {
      endPara();
      return blocks.push({ kind: 'h', level: h[1].length, text: clean(h[2]), line: n });
    }
    if (t.startsWith('|')) {
      endPara();
      const cells = t.replace(/^\||\|$/g, '').split('|').map((c) => clean(c));
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return;
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'table') last.rows.push(cells);
      else blocks.push({ kind: 'table', rows: [cells], line: n });
      return;
    }
    if (BULLET.test(line)) {
      endPara();
      return blocks.push({ kind: 'li', text: clean(t.replace(BULLET, '')), line: n });
    }
    // Gherkin lines stay separate so a scenario reads as one criterion.
    if (/^(scenario(?: outline)?\s*:|given|when|then|and|but)\b/i.test(t) && (/^scenario/i.test(t) || /^(given|when|then)\b/i.test(t) || blocks[blocks.length - 1]?.kind === 'li')) {
      endPara();
      return blocks.push({ kind: 'li', text: clean(t), line: n });
    }
    // A wrapped line that continues a list item (common in PDFs).
    const last = blocks[blocks.length - 1];
    if (!para && last?.kind === 'li' && /^[a-z(]/.test(t)) {
      last.text = clean(`${last.text} ${t}`);
      return;
    }
    if (para) para.text = `${para.text} ${t}`;
    else para = { text: t, line: n };
  });
  endPara();
  // A short line without a full stop, followed by a list, is a heading in plain-text documents ("Login:").
  return blocks.map((b, i) =>
    b.kind === 'p' && blocks[i + 1]?.kind === 'li' && b.text.length <= 70 && !/[.!?]$/.test(b.text) && !BEHAVIOUR.test(b.text)
      ? { kind: 'h' as const, level: 7, text: b.text.replace(/:$/, ''), line: b.line }
      : b,
  );
}

/** Groups Given / When / Then lines into one criterion per scenario; other lines stay as they are. */
export function groupScenarios(lines: string[]): string[] {
  if (!lines.some((l) => /^(given|when|then)\b/i.test(l))) return lines;
  const out: string[] = [];
  let cur: string[] = [];
  let name = '';
  const flush = () => {
    if (cur.length) out.push(`${name ? `${name}: ` : ''}${cur.join(', ')}`);
    else if (name) out.push(name);
    cur = [];
    name = '';
  };
  for (const l of lines) {
    const sc = l.match(/^scenario(?: outline)?\s*:\s*(.*)$/i);
    if (sc) {
      flush();
      name = sc[1];
    } else if (/^given\b/i.test(l) && cur.some((c) => /^then\b/i.test(c))) {
      flush();
      cur.push(l);
    } else if (GHERKIN.test(l)) cur.push(l);
    else {
      flush();
      out.push(l);
    }
  }
  flush();
  return out;
}

const isCriterion = (s: string) => !INTRO.test(s) && (BEHAVIOUR.test(s) || GHERKIN.test(s) || /"[^"]+"|“[^”]+”/.test(s));

interface Draft {
  id?: string;
  level: number;
  feature: string;
  title: string;
  desc: string[];
  criteria: string[];
  line: number;
  section: string;
}

function finish(d: Draft): ReadRequirement {
  const seen = new Set<string>();
  const criteria = groupScenarios(d.criteria.map((c) => c.replace(/^AC[-\s]?\d+\s*[:.)\-–—]\s*/i, '').trim()).filter((c) => c && !/^(acceptance criteria|criteria)\s*:?$/i.test(c)))
    .filter((c) => (seen.has(c.toLowerCase()) ? false : (seen.add(c.toLowerCase()), true)))
    .slice(0, 30);
  return { id: d.id, feature: d.feature, title: d.title, description: shorten(d.desc.join(' '), 400), criteria, line: d.line, section: d.section || undefined };
}

/** Reads a document (as Markdown text) written in any format. */
export function readRequirements(text: string, documentTitle: string): { mode: ReadMode; items: ReadRequirement[] } {
  const blocks = toBlocks(text);
  const headings = blocks.filter((b): b is Extract<Block, { kind: 'h' }> => b.kind === 'h' && !SKIP.test(stripNumbering(b.text)) && !SUBSECTION.test(stripNumbering(b.text)));
  const levels = [...new Set(headings.map((h) => h.level))].sort((a, b) => a - b);
  // With several heading levels the top one names the feature; with one level, each heading is a requirement.
  const featureLevel = levels.length >= 2 ? levels[0] : 0;

  const out: ReadRequirement[] = [];
  const containers: { level: number; title: string }[] = [];
  const orphans: Block[] = [];
  let cur: Draft | undefined;
  let skipping: number | null = null;
  const feature = () => containers[containers.length - 1]?.title ?? documentTitle;
  const flush = () => {
    if (cur && (cur.criteria.length || cur.desc.length)) out.push(finish(cur));
    cur = undefined;
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === 'h') {
      const title = stripNumbering(b.text);
      if (skipping !== null && b.level > skipping) continue;
      skipping = null;
      if (SKIP.test(title)) {
        flush();
        skipping = b.level;
        continue;
      }
      if (SUBSECTION.test(title) && cur) continue;
      while (containers.length && containers[containers.length - 1].level >= b.level) containers.pop();
      const next = blocks[i + 1];
      const holdsOnlyHeadings = next?.kind === 'h' && next.level > b.level;
      if (b.level <= featureLevel || (holdsOnlyHeadings && !SUBSECTION.test(stripNumbering(next.text)))) {
        flush();
        containers.push({ level: b.level, title });
        continue;
      }
      flush();
      const m = title.match(ID_AT_START);
      cur = {
        id: m ? m[1].toUpperCase() : undefined,
        level: b.level,
        feature: feature(),
        title: m ? m[2] || m[1] : title,
        desc: [],
        criteria: [],
        line: b.line,
        section: [...containers.map((c) => c.title), m ? m[2] || m[1] : title].join(' › '),
      };
      continue;
    }
    if (skipping !== null) continue;
    if (!cur) {
      orphans.push(b);
      continue;
    }
    addContent(cur, b);
  }
  flush();

  // A document without usable headings: user stories, a plain list of statements, or paragraphs.
  if (!out.length && orphans.length) out.push(...readFlat(orphans, documentTitle));
  return { mode: 'free-form', items: out };
}

function addContent(cur: Draft, b: Block): void {
  if (b.kind === 'li') {
    const story = b.text.match(STORY);
    if (story) cur.desc.push(b.text);
    else cur.criteria.push(b.text);
  } else if (b.kind === 'p') {
    for (const s of splitSentences(b.text)) {
      if (STORY.test(s) || !isCriterion(s)) cur.desc.push(s);
      else cur.criteria.push(s);
    }
  } else if (b.kind === 'table') {
    const [head, ...rows] = b.rows;
    const acCol = head.findIndex((h) => /accept|criteria|expected|\bac\b|result/i.test(h));
    for (const r of rows.length ? rows : [head]) {
      const cells = r.filter(Boolean);
      if (!cells.length) continue;
      if (acCol >= 0 && r[acCol]) {
        // Keep the row's condition with its expected result: "Expired card: \"Card expired\" is shown".
        const condition = r.filter((c, i) => i !== acCol && c).join(', ');
        for (const expected of r[acCol].split(/\s*(?:;|\s•\s)\s*/).filter(Boolean)) cur.criteria.push(condition ? `${condition}: ${expected}` : expected);
      } else cur.criteria.push(cells.join(' — '));
    }
  }
}

function readFlat(blocks: Block[], documentTitle: string): ReadRequirement[] {
  const out: ReadRequirement[] = [];
  const paras = blocks.filter((b) => b.kind === 'p');
  const items = blocks.filter((b) => b.kind === 'li');
  // User stories start requirements; the bullets after a story are its criteria.
  if (blocks.some((b) => (b.kind === 'p' || b.kind === 'li') && STORY.test(b.text))) {
    let cur: Draft | undefined;
    for (const b of blocks) {
      const story = (b.kind === 'p' || b.kind === 'li') && b.text.match(STORY);
      if (story) {
        if (cur) out.push(finish(cur));
        const title = capitalise(clean(story[2]).replace(/[.!]$/, ''));
        cur = { level: 0, feature: documentTitle, title: shorten(title, 80), desc: [b.text], criteria: [], line: b.line, section: '' };
      } else if (cur) addContent(cur, b);
    }
    if (cur) out.push(finish(cur));
    return out;
  }
  // A plain list of statements: each statement is a requirement that checks itself.
  if (items.length && !paras.some((p) => splitSentences((p as { text: string }).text).some(isCriterion))) {
    return items.map((b) => {
      const text = (b as { text: string }).text;
      const m = text.match(ID_AT_START);
      return { id: m ? m[1].toUpperCase() : undefined, feature: documentTitle, title: shorten((m ? m[2] : text).replace(/[.!]$/, ''), 80), description: '', criteria: [m ? m[2] : text], line: b.line };
    });
  }
  // Paragraphs: one requirement each, named after its first sentence.
  for (const b of blocks) {
    if (b.kind !== 'p') continue;
    const sentences = splitSentences(b.text);
    const criteria = sentences.filter(isCriterion);
    if (!criteria.length) continue;
    const first = sentences[0];
    out.push({ feature: documentTitle, title: shorten(first.replace(/[.!]$/, ''), 80), description: sentences.filter((s) => !isCriterion(s)).join(' '), criteria, line: b.line });
  }
  return out;
}

/** Whether a document uses requirement IDs in its headings (then it is read the strict way). */
export function usesIds(text: string): boolean {
  return ID_HEADING.test(text.replace(/<!--[\s\S]*?-->/g, ''));
}
