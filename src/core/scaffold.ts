import fs from 'node:fs';
import path from 'node:path';
import type { Project } from './config.js';
import { runProcess } from './proc.js';
import { q } from './locators.js';
import { renderAll } from './testgen.js';
import { rel, writeIfMissing } from './store.js';

export const PLAYWRIGHT_VERSION = '1.65.0';

const DEVICE: Record<string, string> = {
  chromium: "{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }",
  firefox: "{ name: 'firefox', use: { ...devices['Desktop Firefox'] } }",
  webkit: "{ name: 'webkit', use: { ...devices['Desktop Safari'] } }",
};

function playwrightConfig(project: Project): string {
  return `import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Loads ../.env (the TraceQA project's test account and URL) without extra packages.
const envFile = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\\r?\\n/)) {
    const m = line.match(/^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*?)\\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\\1$/, '$2');
  }
}

export default defineConfig({
  testDir: './tests',
  outputDir: './results/artifacts',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 2 : 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'results/html', open: 'never' }],
    ['json', { outputFile: 'results/results.json' }],
    ['junit', { outputFile: 'results/junit.xml' }],
  ],
  use: {
    baseURL: process.env.BASE_URL ?? ${q(project.config.baseUrl)},
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
${project.config.browsers.map((b) => `    ${DEVICE[b]},`).join('\n')}
  ],
});
`;
}

function fixtures(project: Project): string {
  const a = project.config.auth;
  const body = a
    ? `      const email = process.env.${a.usernameEnv};
      const password = process.env.${a.passwordEnv};
      if (!email || !password) throw new Error('Set ${a.usernameEnv} and ${a.passwordEnv} in .env');
      await page.goto(${q(a.loginPath)});
      await page.getByLabel(${q(a.usernameLabel)}, { exact: true }).fill(email);
      await page.getByLabel(${q(a.passwordLabel)}, { exact: true }).fill(password);
      await page.getByRole('button', { name: ${q(a.submitButton)}, exact: true }).click();`
    : `      throw new Error('No sign-in is configured. Add an "auth" section to traceqa.config.json and run scaffold again.');`;
  return `// Shared fixtures for the generated tests. Safe to edit: TraceQA only creates this file once.
import { test as base, expect } from '@playwright/test';

type Fixtures = {
  /** Signs in through the UI with the test account from .env. */
  signIn: () => Promise<void>;
};

export const test = base.extend<Fixtures>({
  signIn: async ({ page }, use) => {
    await use(async () => {
${body}
    });
  },
});

export { expect };
`;
}

const BASE_PAGE = `// Base class for generated page objects. Safe to edit: TraceQA only creates this file once.
import type { Page } from '@playwright/test';

export abstract class BasePage {
  abstract readonly path: string;

  constructor(readonly page: Page) {}

  async goto(path: string = this.path): Promise<void> {
    await this.page.goto(path);
  }
}
`;

function readme(project: Project): string {
  return `# ${path.basename(project.dir)} end-to-end tests

Generated and maintained by TraceQA. It is a plain Playwright project, so no AI is needed to run it.

\`\`\`
npm install
npx playwright test                    # everything
npx playwright test --grep @REQ-142    # one requirement
npx playwright show-report results/html
\`\`\`

- \`tests/\`: one spec file per requirement. Each test title carries its acceptance criterion and \`@REQ-…\` tag.
- \`pages/\`: page objects built from the TraceQA app map.
- \`fixtures/test.ts\`: shared fixtures such as \`signIn\`.
- The test account and URL come from \`../.env\` (see \`.env.example\`).
`;
}

export function hasInstalledDeps(project: Project): boolean {
  return fs.existsSync(path.join(project.paths.e2e, 'node_modules', '@playwright', 'test', 'cli.js'));
}

function npmInstall(cwd: string, signal?: AbortSignal, log?: (line: string) => void) {
  // shell is needed on Windows for npm.cmd; the arguments are fixed.
  return runProcess('npm', ['install', '--no-audit', '--no-fund'], { cwd, shell: true, signal, onLine: log });
}

/**
 * Keeps the browser list in an existing playwright.config.ts in step with traceqa.config.json.
 * Only touches the projects block when it still holds nothing but TraceQA's own browser entries.
 */
export function syncBrowsers(project: Project): boolean {
  const file = path.join(project.paths.e2e, 'playwright.config.ts');
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/(\n  projects: \[\n)([\s\S]*?)(\n  \],\n)/);
  if (!m) return false;
  const known = new Set(Object.values(DEVICE));
  const lines = m[2].split('\n').map((l) => l.trim().replace(/,$/, '')).filter(Boolean);
  if (!lines.every((l) => known.has(l))) return false; // hand-edited: leave it alone
  const wanted = project.config.browsers.map((b) => `    ${DEVICE[b]},`).join('\n');
  if (m[2] === wanted) return false;
  fs.writeFileSync(file, text.replace(m[0], `${m[1]}${wanted}${m[3]}`));
  return true;
}

export async function scaffold(
  project: Project,
  opts: { install?: boolean; signal?: AbortSignal; log?: (line: string) => void } = {},
): Promise<{ created: string[]; pageObjects: number; specs: number; installed: boolean; installOutput?: string; browsersUpdated?: boolean }> {
  const e2e = project.paths.e2e;
  const created: string[] = [];
  const files: [string, string][] = [
    [
      'package.json',
      JSON.stringify(
        {
          name: `${path.basename(project.dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-e2e`,
          private: true,
          scripts: { test: 'playwright test', report: 'playwright show-report results/html' },
          devDependencies: { '@playwright/test': PLAYWRIGHT_VERSION, '@types/node': '^22.0.0' },
        },
        null,
        2,
      ) + '\n',
    ],
    ['playwright.config.ts', playwrightConfig(project)],
    ['fixtures/test.ts', fixtures(project)],
    ['pages/BasePage.ts', BASE_PAGE],
    [
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, esModuleInterop: true, skipLibCheck: true, types: ['node'] } }, null, 2) + '\n',
    ],
    ['.gitignore', 'node_modules/\nresults/\n'],
    ['README.md', readme(project)],
  ];
  for (const [name, text] of files) {
    if (writeIfMissing(path.join(e2e, name), text)) created.push(rel(project.dir, path.join(e2e, name)));
  }
  const browsersUpdated = syncBrowsers(project);
  const rendered = renderAll(project);
  let installed = hasInstalledDeps(project);
  let installOutput: string | undefined;
  if (!installed && opts.install !== false) {
    opts.log?.('Installing @playwright/test in the framework folder (npm install) …');
    const res = await npmInstall(e2e, opts.signal, opts.log);
    installOutput = res.output.trim().split('\n').slice(-5).join('\n');
    installed = res.code === 0 && hasInstalledDeps(project);
  }
  return { created, pageObjects: rendered.pageObjects.length, specs: rendered.specs.length, installed, installOutput, browsersUpdated };
}
