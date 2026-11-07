import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequirementsMarkdown, checkText } from '../src/core/requirements.js';
import { pageIdFor, templatePath } from '../src/core/appMap.js';
import { locatorCode, matchesElement } from '../src/core/locators.js';
import { classify } from '../src/core/runner.js';
import { parseAriaSnapshot, elementKey } from '../src/core/browser.js';
import { renderPageObject } from '../src/core/testgen.js';
import type { AppPage } from '../src/core/types.js';

test('parses requirements, criteria and features from Markdown', () => {
  const md = [
    '# Checkout',
    '',
    '## REQ-142 Valid coupon applies a discount',
    'Applies to signed-in and guest customers.',
    '- AC1: A valid code reduces the total',
    '- Codes are not case-sensitive',
    '',
    '## REQ-118: Search results load quickly',
    '- AC1: Results appear quickly',
  ].join('\n');
  const reqs = parseRequirementsMarkdown(md, 'requirements/checkout.md');
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].id, 'REQ-142');
  assert.equal(reqs[0].feature, 'Checkout');
  assert.equal(reqs[0].description, 'Applies to signed-in and guest customers.');
  assert.deepEqual(reqs[0].criteria.map((c) => c.id), ['AC1', 'AC2']);
  assert.equal(reqs[0].criteria[1].text, 'Codes are not case-sensitive');
  assert.equal(reqs[1].title, 'Search results load quickly');
  assert.equal(reqs[0].source.line, 3);
});

test('flags vague and UI-unreachable wording, but not words inside quotes', () => {
  assert.equal(checkText('Results appear quickly')[0].kind, 'vague');
  assert.equal(checkText('The customer receives an email')[0].kind, 'no-ui-path');
  assert.equal(checkText('The page shows "Search quickly"').length, 0);
  assert.equal(checkText('An expired code shows "This coupon has expired"').length, 0);
});

test('collapses ids in paths and names pages', () => {
  assert.equal(templatePath('/p/12'), '/p/:id');
  assert.equal(templatePath('/orders/9f3c2a1b-77aa-4c2e-9a1d-1234567890ab/items'), '/orders/:id/items');
  assert.equal(templatePath('/'), '/');
  assert.equal(pageIdFor('/p/:id'), 'product-detail');
  assert.equal(pageIdFor('/checkout/payment'), 'checkout-payment');
  assert.equal(pageIdFor('/'), 'home');
});

test('renders locator code with safe quoting', () => {
  assert.equal(locatorCode({ by: 'role', role: 'button', name: "Don't stop", exact: true }), "page.getByRole('button', { name: 'Don\\'t stop', exact: true })");
  assert.equal(locatorCode({ by: 'testId', testId: 'order-total' }), "page.getByTestId('order-total')");
  assert.equal(locatorCode({ by: 'label', label: 'Email', exact: true }), "page.getByLabel('Email', { exact: true })");
});

test('matches differently phrased locators to app map elements', () => {
  const el = { role: 'textbox', name: 'Coupon code', locator: { by: 'role' as const, role: 'textbox', name: 'Coupon code', exact: true } };
  assert.ok(matchesElement(el, { by: 'label', label: 'coupon code' }));
  assert.ok(matchesElement(el, { by: 'role', role: 'textbox', name: 'Coupon code' }));
  assert.ok(!matchesElement(el, { by: 'label', label: 'Email' }));
});

test('sorts failures into verdicts', () => {
  assert.equal(classify('Error: expect(locator).toContainText(expected) failed\nExpected substring: "$75.60"'), 'app-bug');
  assert.equal(classify("locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Update' })"), 'test-broken');
  assert.equal(classify('page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4173/'), 'environment');
  assert.equal(classify("Error: strict mode violation: getByRole('button') resolved to 3 elements"), 'test-broken');
  assert.equal(classify("Test timeout of 30000ms exceeded.\nError: locator.click: Test timeout of 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Apply', exact: true })"), 'test-broken');
  // The code frame around the failing click mentions the next expect(); it must not count as an assertion failure.
  assert.equal(classify("TimeoutError: locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Apply', exact: true })\n\n  17 |     await page.getByLabel('Coupon code').fill('SAVE10');\n> 18 |     await checkoutPayment.applyButton.click();\n     |                                       ^\n  19 |     await expect(checkoutPayment.orderTotalText).toContainText('$75.60');"), 'test-broken');
});

test('parses aria snapshots and builds element keys', () => {
  const nodes = parseAriaSnapshot([
    '- banner:',
    '  - link "Demo Store":',
    '    - /url: /',
    '- heading "Payment" [level=1]',
    '- textbox "Coupon code"',
    '- button "Say \\"hi\\""',
    '- alert: Invalid coupon code',
    '- text: hello',
  ].join('\n'));
  assert.deepEqual(nodes.map((n) => `${n.role}:${n.name}`), ['banner:', 'link:Demo Store', 'heading:Payment', 'textbox:Coupon code', 'button:Say "hi"', 'alert:']);
  assert.equal(nodes[2].level, 1);
  const taken = new Set<string>();
  assert.equal(elementKey('button', 'Apply', taken), 'applyButton');
  assert.equal(elementKey('button', 'Apply', taken), 'applyButton2');
  assert.equal(elementKey('alert', 'alert', taken), 'alert');
  assert.equal(elementKey('textbox', '2nd line', taken), 'el2ndLineInput');
});

test('renders a page object without ambiguous elements', () => {
  const page: AppPage = {
    id: 'cart', className: 'CartPage', name: 'Your cart', path: '/cart', templatePath: '/cart', title: 'Cart', headings: ['Your cart'],
    links: [], forms: 1, textSample: '', source: 'analyze', updatedAt: '',
    elements: [
      { key: 'checkoutLink', role: 'link', name: 'Checkout', locator: { by: 'role', role: 'link', name: 'Checkout', exact: true }, stability: 'stable' },
      { key: 'updateQuantityButton', role: 'button', name: 'Update quantity', locator: { by: 'role', role: 'button', name: 'Update quantity', exact: true }, stability: 'ambiguous' },
    ],
  };
  const code = renderPageObject(page);
  assert.match(code, /export class CartPage extends BasePage/);
  assert.match(code, /this\.checkoutLink = page\.getByRole\('link', \{ name: 'Checkout', exact: true \}\);/);
  assert.doesNotMatch(code, /updateQuantityButton/);
});
