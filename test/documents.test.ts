import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  convertRequirementDocument, decodeText, documentFormat, htmlToMarkdown, normalizeRequirementText, pdfPageText, requirementFileName,
} from '../src/core/documents.js';
import { parseRequirementsMarkdown } from '../src/core/requirements.js';
import { startDashboard } from '../src/ui/server.js';

const parse = (md: string) => parseRequirementsMarkdown(md, 'requirements/upload.md');
const summary = (md: string) => parse(md).map((r) => `${r.id} ${r.title} [${r.feature}]: ${r.criteria.map((c) => `${c.id}=${c.text}`).join(' | ')}`);

test('uploaded file names become safe requirement file names', () => {
  assert.equal(requirementFileName('Checkout Requirements v2.docx'), 'Checkout Requirements v2.md');
  assert.equal(requirementFileName('C:\\Users\\qa\\Überblick (final).pdf'), 'Uberblick -final.md');
  assert.equal(requirementFileName('README.txt'), 'readme-requirements.md');
  assert.equal(requirementFileName('???.pdf'), 'requirements.md');
  assert.equal(documentFormat('a.MD'), 'markdown');
  assert.equal(documentFormat('a.docx'), 'word');
  assert.throws(() => documentFormat('old.doc'), /save it as \.docx/);
  assert.throws(() => documentFormat('tool.exe'), /\.md, \.txt, \.docx and \.pdf/);
});

test('text files are decoded whatever editor wrote them', () => {
  assert.equal(decodeText(Buffer.from('\ufeffREQ-1 Café', 'utf8')), 'REQ-1 Café');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('REQ-2 Ok', 'utf16le')])), 'REQ-2 Ok');
  assert.equal(decodeText(Buffer.from([0x52, 0x45, 0x51, 0x20, 0x96, 0x20, 0x63, 0x61, 0x66, 0xe9])), 'REQ – café');
});

test('plain text with IDs, bullet characters and criteria labels becomes requirements', () => {
  const md = normalizeRequirementText(
    [
      '# Checkout',
      '',
      '1. REQ-142: Valid coupon applies a discount',
      'Shoppers can enter a coupon code in the cart.',
      'Acceptance criteria:',
      '• A valid code reduces the total by the coupon value',
      '\uf0b7 Codes are not case-sensitive',
      'AC3 - An expired code shows "Coupon expired"',
      '',
      'REQ-150 – Free shipping over $50',
      '▪ Orders over $50 show "Free shipping"',
      'This depends on REQ-142 being done first.',
      'REQ-142 is referenced again here.',
    ].join('\n'),
  );
  assert.deepEqual(summary(md), [
    'REQ-142 Valid coupon applies a discount [Checkout]: AC1=A valid code reduces the total by the coupon value | AC2=Codes are not case-sensitive | AC3=An expired code shows "Coupon expired"',
    'REQ-150 Free shipping over $50 [Checkout]: AC1=Orders over $50 show "Free shipping"',
  ]);
  const [coupon, shipping] = parse(md);
  assert.equal(coupon.description, 'Shoppers can enter a coupon code in the cart.');
  assert.match(shipping.description, /REQ-142 is referenced again/, 'a repeated ID is a reference, not a new requirement');
});

test('sub-headings inside a requirement do not cut off its criteria', () => {
  const md = normalizeRequirementText(
    ['# Product requirements', '## Accounts', '### REQ-7 Sign in', '#### Description', 'Users sign in with email.', '#### Acceptance criteria', '- Wrong password shows "Try again"', '## Payments', '### REQ-8 Pay by card', '- Card number is masked'].join('\n'),
  );
  assert.deepEqual(summary(md), [
    'REQ-7 Sign in [Accounts]: AC1=Wrong password shows "Try again"',
    'REQ-8 Pay by card [Payments]: AC1=Card number is masked',
  ]);
});

test('Word HTML: headings, nested lists and requirement tables become Markdown', () => {
  const html =
    '<h1>Cart</h1><p>Intro text &amp; scope.</p>' +
    '<h2><a id="_Toc1"></a>REQ-20 Cart badge</h2><p>The badge shows the item count.</p>' +
    '<ul><li>Adding an item adds 1<ul><li>also for bundles</li></ul></li><li><strong>Removing</strong> an item subtracts 1</li></ul>' +
    '<img src="data:image/png;base64,AAAA" />' +
    '<table><tr><td><p>ID</p></td><td><p>Title</p></td><td><p>Description</p></td><td><p>Acceptance criteria</p></td></tr>' +
    '<tr><td><p>REQ-21</p></td><td><p>Empty cart</p></td><td><p>When nothing is in the cart.</p></td><td><ul><li>Shows "Your cart is empty"</li><li>Checkout is disabled</li></ul></td></tr>' +
    '<tr><td><p>Total</p></td><td><p>n/a</p></td><td></td><td></td></tr></table>';
  const md = normalizeRequirementText(htmlToMarkdown(html));
  assert.ok(!md.includes('base64'), 'images are dropped');
  assert.deepEqual(summary(md), [
    'REQ-20 Cart badge [Cart]: AC1=Adding an item adds 1 | AC2=also for bundles | AC3=Removing an item subtracts 1',
    'REQ-21 Empty cart [Cart]: AC1=Shows "Your cart is empty" | AC2=Checkout is disabled',
  ]);
  assert.equal(parse(md)[1].description, 'When nothing is in the cart. Total · n/a');
});

test('PDF text items are rebuilt into lines; wrapped bullets and page numbers are fixed', () => {
  const item = (str: string, x: number, y: number, hasEOL = true) => ({ str, x, y, width: str.length * 6, height: 12, fontSize: 12, hasEOL });
  const text = pdfPageText([
    item('REQ-30 Search', 72, 720),
    item('•', 72, 706, false),
    item('Results appear for a product name and', 84, 706),
    item('its category', 84, 692),
    item('•', 72, 678, false),
    item('No results shows "Nothing found".', 84, 678),
    item('Page 1 of 2', 280, 40),
  ]);
  assert.equal(text, 'REQ-30 Search\n• Results appear for a product name and\nits category\n• No results shows "Nothing found".\n\nPage 1 of 2');
  const md = normalizeRequirementText(text, { joinWrapped: true });
  assert.deepEqual(summary(md), ['REQ-30 Search [Upload]: AC1=Results appear for a product name and its category | AC2=No results shows "Nothing found".']);
  assert.ok(!md.includes('Page 1'));
});

/** A real .docx with a heading style, a bulleted list (numbering.xml) and a requirement table. */
async function makeDocx(): Promise<Buffer> {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const p = (text: string, style?: string, bullet = false) =>
    `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ''}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const cell = (inner: string) => `<w:tc>${inner}</w:tc>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`);
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/></w:style></w:styles>`);
  zip.file('word/numbering.xml', `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>` +
    p('Checkout', 'Heading1') +
    p('REQ-142 Valid coupon applies a discount', 'Heading2') +
    p('Shoppers can enter a coupon in the cart.') +
    p('Acceptance criteria', 'Heading3') +
    p('A valid code reduces the total', undefined, true) +
    p('Codes are not case-sensitive', undefined, true) +
    `<w:tbl><w:tr>${cell(p('ID'))}${cell(p('Title'))}${cell(p('Acceptance criteria'))}</w:tr>` +
    `<w:tr>${cell(p('REQ-150'))}${cell(p('Free shipping'))}${cell(p('Orders over $50 ship free') + p('The banner says "Free shipping"'))}</w:tr></w:tbl>` +
    `</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('a Word document converts end to end', async () => {
  const doc = await convertRequirementDocument('Checkout spec.docx', await makeDocx());
  assert.equal(doc.file, 'Checkout spec.md');
  assert.equal(doc.format, 'word');
  assert.deepEqual(summary(doc.markdown), [
    'REQ-142 Valid coupon applies a discount [Checkout]: AC1=A valid code reduces the total | AC2=Codes are not case-sensitive',
    'REQ-150 Free shipping [Checkout]: AC1=Orders over $50 ship free | AC2=The banner says "Free shipping"',
  ]);
  await assert.rejects(convertRequirementDocument('fake.docx', Buffer.from('not a zip')), /not a Word document/);
});

/** A minimal one-page PDF with Helvetica text, one line per entry (null = a paragraph gap). */
function makePdf(lines: (string | null)[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  let y = 720;
  const ops = ['BT', '/F1 12 Tf'];
  for (const l of lines) {
    if (l === null) { y -= 14; continue; }
    ops.push(`1 0 0 1 72 ${y} Tm (${esc(l)}) Tj`);
    y -= 15;
  }
  ops.push('1 0 0 1 280 40 Tm (Page 1 of 1) Tj', 'ET');
  const stream = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

test('a PDF converts end to end', async () => {
  const pdf = makePdf(['Search', null, 'REQ-30 Product search', '\x95 Results appear for a product name and', 'its category', '\x95 No results shows "Nothing found".']);
  const doc = await convertRequirementDocument('search.pdf', pdf);
  assert.equal(doc.format, 'pdf');
  // "Search" is plain text in a PDF, not a heading, so the feature comes from the file name.
  assert.deepEqual(summary(doc.markdown), ['REQ-30 Product search [Upload]: AC1=Results appear for a product name and its category | AC2=No results shows "Nothing found".']);
  assert.ok(!doc.markdown.includes('Page 1 of 1'));
  await assert.rejects(convertRequirementDocument('fake.pdf', Buffer.from('hello')), /not a PDF/);
});

test('dashboard upload: saves and imports, asks before replacing, keeps files without requirements out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqa-upload-'));
  fs.writeFileSync(path.join(dir, 'traceqa.config.json'), JSON.stringify({ baseUrl: 'http://localhost:4173' }));
  const dash = await startDashboard(dir, { port: 0 });
  const upload = (name: string, body: Buffer | string, query = '', headers: Record<string, string> = { 'X-TraceQA': '1' }) =>
    fetch(`http://127.0.0.1:${dash.port}/api/requirement-files/upload?name=${encodeURIComponent(name)}${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...headers },
      body: typeof body === 'string' ? Buffer.from(body) : body,
    });
  try {
    assert.equal((await upload('cart.txt', 'REQ-1 Cart\n- shows items', '', {})).status, 403, 'needs the X-TraceQA header');

    let res = await upload('cart.txt', 'Cart\n\nREQ-1 Cart badge\n• Adding an item adds 1\n');
    assert.equal(res.status, 200);
    let r = await res.json();
    assert.equal(r.saved, true);
    assert.equal(r.file, 'cart.md');
    assert.deepEqual(r.requirements, ['REQ-1']);
    assert.equal(r.imported, 1);
    assert.match(fs.readFileSync(path.join(dir, 'requirements', 'cart.md'), 'utf8'), /^## REQ-1 Cart badge\n- Adding an item adds 1/m);

    res = await upload('cart.md', '## REQ-1 Cart badge\n- Adding an item adds 1\n- Removing an item subtracts 1\n');
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'exists');

    res = await upload('cart.md', '## REQ-1 Cart badge\n- Adding an item adds 1\n- Removing an item subtracts 1\n', '&replace=1');
    r = await res.json();
    assert.equal(r.saved, true);
    assert.match(r.replaced, /^\.traceqa\/trash\/.*cart\.md$/);
    assert.ok(fs.existsSync(path.join(dir, r.replaced)), 'the old version is in the trash');

    res = await upload('notes.txt', 'Just some meeting notes.\n');
    r = await res.json();
    assert.equal(r.saved, false);
    assert.match(r.reason, /No requirements found/);
    assert.equal(r.content, 'Just some meeting notes.\n');
    assert.ok(!fs.existsSync(path.join(dir, 'requirements', 'notes.md')));

    res = await upload('draft.docx', await makeDocx(), '&mode=convert');
    r = await res.json();
    assert.equal(r.saved, false);
    assert.deepEqual(r.requirements, ['REQ-142', 'REQ-150']);
    assert.ok(!fs.existsSync(path.join(dir, 'requirements', 'draft.md')), 'convert mode does not save');

    assert.equal((await upload('tool.exe', 'MZ')).status, 415);
    assert.equal((await upload('big.txt', Buffer.alloc(21 * 1024 * 1024, 0x61))).status, 413);
  } finally {
    dash.close();
  }
});
