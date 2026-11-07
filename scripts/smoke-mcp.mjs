// End-to-end check of the MCP server, acting the way an AI coding tool would.
// Usage: node scripts/smoke-mcp.mjs [projectDir]   (the Demo Store must be running on :4173)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(process.argv[2] ?? path.join(here, '..', '..', 'examples', 'demo-store'));
const cli = path.join(here, '..', 'dist', 'cli.js');

const client = new Client({ name: 'traceqa-smoke', version: '0.0.1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--project', project], stderr: 'inherit' }));

let failures = 0;
async function call(name, args = {}, { expectError = false, show = 30 } = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.map((c) => c.text).join('\n');
  const bad = !!res.isError !== expectError;
  if (bad) failures++;
  console.log(`\n=== ${name}${bad ? '  <-- UNEXPECTED' : ''}`);
  console.log(text.split('\n').slice(0, show).join('\n'));
  return text;
}

const tools = await client.listTools();
console.log(`Tools: ${tools.tools.map((t) => t.name).join(', ')}`);
const prompts = await client.listPrompts();
console.log(`Prompts: ${prompts.prompts.map((p) => p.name).join(', ')}`);

await call('status', {}, { show: 15 });

// --- explore checkout with a lowercase coupon ---
await call('explore_start', { charter: 'Check REQ-142 coupon rules with valid, lowercase and expired codes', requirementId: 'REQ-142', startPath: '/p/1' }, { show: 6 });
await call('explore_action', { action: 'click', locator: { by: 'role', role: 'button', name: 'Add to cart', exact: true } }, { show: 3 });
await call('explore_action', { action: 'click', locator: { by: 'role', role: 'link', name: 'Checkout', exact: true } }, { show: 3 });
await call('explore_action', { action: 'fill', locator: { by: 'label', label: 'Coupon code', exact: true }, value: 'save10' }, { show: 2 });
const afterApply = await call('explore_action', { action: 'click', locator: { by: 'role', role: 'button', name: 'Apply', exact: true } }, { show: 40 });
if (!afterApply.includes('Invalid coupon code')) {
  failures++;
  console.log('<-- expected the planted bug message "Invalid coupon code"');
}
// Safety rule check: "Sign out" is blocked in the demo config.
await call('explore_action', { action: 'goto', path: 'https://example.com/' }, { show: 2 });
await call('explore_record_finding', {
  title: 'Lowercase coupon codes are rejected',
  severity: 'high',
  requirementId: 'REQ-142',
  acId: 'AC3',
  expected: '"save10" applies the same 10% discount as "SAVE10"',
  actual: 'The page shows "Invalid coupon code" and the total stays $84.00',
});
await call('explore_end', {}, { show: 8 });

// The payment page is now in the app map, so page objects can use it.
await call('get_page', { path: '/checkout/payment' }, { show: 25 });

// --- write tests through the MCP server ---
const toPayment = [
  { action: 'goto', path: '/p/1' },
  { action: 'click', target: { by: 'role', role: 'button', name: 'Add to cart', exact: true } },
  { action: 'click', target: { by: 'role', role: 'link', name: 'Checkout', exact: true } },
];
const applyCode = (code) => [
  { action: 'fill', target: { by: 'label', label: 'Coupon code', exact: true }, value: code },
  { action: 'click', target: { by: 'role', role: 'button', name: 'Apply', exact: true } },
];
await call('save_test', {
  requirementId: 'REQ-142', acId: 'AC1', title: 'SAVE10 takes 10% off the total',
  steps: [...toPayment, ...applyCode('SAVE10'), { action: 'expectText', target: { by: 'testId', testId: 'order-total' }, text: '$75.60' }],
}, { show: 6 });
await call('save_test', {
  requirementId: 'REQ-142', acId: 'AC2', title: 'discount shows as its own line',
  steps: [...toPayment, ...applyCode('SAVE10'), { action: 'expectVisible', target: { by: 'testId', testId: 'discount' } }],
}, { show: 6 });
await call('save_test', {
  requirementId: 'REQ-142', acId: 'AC3', title: 'codes are not case-sensitive',
  steps: [...toPayment, ...applyCode('save10'), { action: 'expectText', target: { by: 'testId', testId: 'order-total' }, text: '$75.60' }],
}, { show: 12 });
await call('save_test', {
  requirementId: 'REQ-142', acId: 'AC4', title: 'expired code explains it has expired',
  steps: [...toPayment, ...applyCode('OLD5'), { action: 'expectText', target: { by: 'role', role: 'alert' }, text: 'This coupon has expired' }],
}, { show: 12 });
await call('save_test', {
  requirementId: 'REQ-104', acId: 'AC1', title: 'valid credentials open My account', signedIn: true,
  steps: [{ action: 'goto', path: '/account' }, { action: 'expectVisible', target: { by: 'role', role: 'heading', name: 'My account', exact: true } }],
}, { show: 6 });
await call('save_test', {
  requirementId: 'REQ-104', acId: 'AC2', title: 'wrong password shows an error',
  steps: [
    { action: 'goto', path: '/signin' },
    { action: 'fill', target: { by: 'label', label: 'Email', exact: true }, value: '${TEST_USER_EMAIL}' },
    { action: 'fill', target: { by: 'label', label: 'Password', exact: true }, value: 'not-the-password' },
    { action: 'click', target: { by: 'role', role: 'button', name: 'Sign in', exact: true } },
    { action: 'expectText', target: { by: 'role', role: 'alert' }, text: 'Email or password is incorrect' },
  ],
}, { show: 6 });
await call('save_test', {
  requirementId: 'REQ-112', acId: 'AC1', title: '"head" finds Wireless Headphones',
  steps: [
    { action: 'goto', path: '/search' },
    { action: 'fill', target: { by: 'role', role: 'searchbox', name: 'Search products', exact: true }, value: 'head' },
    { action: 'click', target: { by: 'role', role: 'button', name: 'Search', exact: true } },
    { action: 'expectVisible', target: { by: 'role', role: 'link', name: 'Wireless Headphones', exact: true } },
  ],
}, { show: 6 });
// A test without any expectation is refused.
await call('save_test', { requirementId: 'REQ-101', title: 'no checks', steps: [{ action: 'goto', path: '/' }] }, { expectError: true, show: 2 });

await call('run_tests', {}, { show: 30 });
await call('list_bugs', {}, { show: 10 });
await call('report', {}, { show: 20 });
await call('status', {}, { show: 15 });

await client.close();
console.log(failures ? `\nSMOKE FAILED: ${failures} unexpected result(s)` : '\nSMOKE PASSED');
process.exit(failures ? 1 : 0);
