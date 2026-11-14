import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRequirements } from '../src/core/reader.js';
import { textToMarkdown } from '../src/core/documents.js';
import { loadProject } from '../src/core/config.js';
import { importRequirements, loadRequirements } from '../src/core/requirements.js';

const titles = (r: ReturnType<typeof readRequirements>) => r.items.map((i) => i.title);

test('a free-form spec: numbered headings, intro and glossary skipped, sub-sections merged, scenarios grouped', () => {
  const r = readRequirements(`# Online shop requirements

## Introduction
This document describes the shop.

## 1. Search
Customers find products by typing in the search box.
- Searching for "head" lists Wireless Headphones
- No match shows "No products found"

## 2. Checkout
### 2.1 Coupon codes
Customers can enter a coupon code on the payment page. Codes are not case-sensitive.
#### Acceptance criteria
- An expired code shows "This coupon has expired"

### 2.2 Guest checkout
As a shopper, I want to buy without an account so that checkout is faster.
Scenario: guest pays
Given a cart with one product
When the shopper chooses "Continue as guest"
Then the payment page asks for an email address

## Glossary
- SKU: stock keeping unit
`, 'Shop');
  assert.equal(r.mode, 'free-form');
  assert.deepEqual(titles(r), ['Search', 'Coupon codes', 'Guest checkout']);
  assert.deepEqual(r.items.map((i) => i.feature), ['Online shop requirements', 'Checkout', 'Checkout']);
  assert.deepEqual(r.items[0].criteria, ['Searching for "head" lists Wireless Headphones', 'No match shows "No products found"']);
  assert.equal(r.items[0].description, 'Customers find products by typing in the search box.');
  assert.deepEqual(r.items[1].criteria, ['Customers can enter a coupon code on the payment page.', 'Codes are not case-sensitive.', 'An expired code shows "This coupon has expired"']);
  assert.equal(r.items[2].criteria.length, 1);
  assert.match(r.items[2].criteria[0], /^guest pays: Given a cart with one product, When the shopper chooses "Continue as guest", Then the payment page asks/);
  assert.match(r.items[2].description, /^As a shopper/);
  assert.equal(r.items[1].section, 'Online shop requirements › Checkout › Coupon codes');
});

test('user stories without headings, a plain list, a table and a short brief', () => {
  const stories = readRequirements('As a customer, I want to save products for later, so that I can buy them another day.\n- The product page shows a "Save for later" button\n\nAs a customer, I want to remove a saved product.\n- "Remove" takes it off the wishlist', 'Wishlist');
  assert.deepEqual(titles(stories), ['Save products for later', 'Remove a saved product']);
  assert.equal(stories.items[0].criteria[0], 'The product page shows a "Save for later" button');

  const list = readRequirements(textToMarkdown('1. Users can sign in with email and password\n2. A wrong password shows "Email or password is incorrect"'), 'Login');
  assert.equal(list.items.length, 2, 'a bare list of statements: each is a requirement');
  assert.deepEqual(list.items[1].criteria, ['A wrong password shows "Email or password is incorrect"']);

  const titled = readRequirements(textToMarkdown('Login requirements\n1. Users can sign in\n2. Wrong passwords are rejected'), 'Login');
  assert.deepEqual(titles(titled), ['Login requirements'], 'a short title line over a list names it');
  assert.equal(titled.items[0].criteria.length, 2);

  const table = readRequirements('# Payments\n## Card payments\n| Rule | Expected result |\n|---|---|\n| Expired card | "Card expired" is shown |\n', 'Payments');
  assert.deepEqual(table.items[0].criteria, ['Expired card: "Card expired" is shown']);

  const brief = readRequirements('# Loyalty\nWe want to reward repeat customers. Every purchase should earn points. Points expire after one year.', 'Loyalty');
  assert.deepEqual(brief.items[0].criteria, ['Every purchase should earn points.', 'Points expire after one year.']);
  assert.equal(brief.items[0].description, 'We want to reward repeat customers.');
});

test('free-form requirements get stable IDs; explicit IDs and the old format keep working', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqa-reader-'));
  fs.writeFileSync(path.join(dir, 'traceqa.config.json'), JSON.stringify({ baseUrl: 'http://localhost:4173' }));
  const req = path.join(dir, 'requirements');
  fs.mkdirSync(req);
  fs.writeFileSync(path.join(req, 'old.md'), '# Shopping\n## REQ-101 Home page lists products\n- AC1: Shows 6 products\n');
  fs.writeFileSync(path.join(req, 'notes.md'), '# Checkout\n## Coupons\n- Valid codes reduce the total\n## Guest checkout\n- "Continue as guest" is offered\n');
  const p = loadProject(dir);
  await importRequirements(p);
  const first = Object.fromEntries(loadRequirements(p).map((r) => [r.title, r.id]));
  assert.equal(first['Home page lists products'], 'REQ-101');
  assert.equal(first['Coupons'], 'REQ-102', 'numbering continues after explicit IDs');
  assert.equal(first['Guest checkout'], 'REQ-103');

  // A new section above the others, and edits elsewhere: existing IDs do not move.
  fs.writeFileSync(path.join(req, 'notes.md'), '# Checkout\n## Gift cards\n- A gift card pays part of the total\n## Coupons\n- Valid codes reduce the total\n- Expired codes are rejected\n## Guest checkout\n- "Continue as guest" is offered\n');
  await importRequirements(p);
  const second = Object.fromEntries(loadRequirements(p).map((r) => [r.title, r.id]));
  assert.equal(second['Coupons'], 'REQ-102');
  assert.equal(second['Guest checkout'], 'REQ-103');
  assert.equal(second['Gift cards'], 'REQ-104');
  assert.ok(fs.existsSync(path.join(dir, '.traceqa', 'requirement-ids.json')));
  const old = loadRequirements(p).find((r) => r.id === 'REQ-101')!;
  assert.equal(old.source.mode, 'ids');
  assert.equal(old.criteria[0].id, 'AC1');
  assert.ok(!old.autoId);
});

test('Word and PDF files dropped into the folder are read where they are; an AI coding tool can save a better reading', async () => {
  const { makeDocx, makePdf } = await import('../scripts/doc-fixtures.mjs');
  const { buildTools } = await import('../src/tools/registry.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqa-reader-'));
  fs.writeFileSync(path.join(dir, 'traceqa.config.json'), JSON.stringify({ baseUrl: 'http://localhost:4173' }));
  const req = path.join(dir, 'requirements');
  fs.mkdirSync(path.join(req, 'specs'), { recursive: true });
  const docx = makeDocx([['h1', 'Wishlist'], ['h2', 'Save for later'], ['li', 'The product page shows "Save for later"'], ['h2', 'Remove'], ['li', '"Remove" takes it off the wishlist']]);
  fs.writeFileSync(path.join(req, 'specs', 'wishlist.docx'), docx);
  fs.writeFileSync(path.join(req, 'returns.pdf'), makePdf([['Returns', 20], ['Customers can return delivered orders within 30 days.'], ['- Each delivered order shows "Request return"']]));
  const p = loadProject(dir);
  const r = await importRequirements(p);
  const wish = r.documents.find((d) => d.file === 'specs/wishlist.docx')!;
  assert.equal(wish.requirements, 2);
  assert.equal(wish.mode, 'free-form');
  const ret = r.documents.find((d) => d.file === 'returns.pdf')!;
  assert.equal(ret.requirements, 1);
  assert.ok(ret.criteria >= 1);
  assert.deepEqual(fs.readFileSync(path.join(req, 'specs', 'wishlist.docx')), docx, 'never rewritten');

  const tools = buildTools(dir);
  const read = tools.find((t) => t.name === 'read_requirement_document')!;
  const text = await read.run({ file: 'specs/wishlist.docx' } as never);
  assert.match(String(text), /reads 2 requirement\(s\)/);
  assert.match(String(text), /Save for later/);
  const save = tools.find((t) => t.name === 'save_document_reading')!;
  const saved = await save.run({ file: 'returns.pdf', requirements: [
    { title: 'Request a return', criteria: ['Each delivered order shows "Request return"'] },
    { title: 'Return window', criteria: ['Orders delivered more than 30 days ago do not show "Request return"'] },
  ] } as never);
  assert.match(String(saved), /now reads as 2 requirement\(s\)/);
  const fromPdf = loadRequirements(loadProject(dir)).filter((q) => q.source.file.endsWith('returns.pdf'));
  assert.equal(fromPdf.length, 2);
  assert.ok(fromPdf.every((q) => q.source.mode === 'ai' && q.autoId));
  await assert.rejects(Promise.resolve().then(() => save.run({ file: '../outside.pdf', requirements: [{ title: 'x', criteria: ['y'] }] } as never)));
});
