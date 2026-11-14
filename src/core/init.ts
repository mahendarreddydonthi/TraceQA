import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE } from './config.js';
import { writeIfMissing, writeText } from './store.js';

export const AGENT_GUIDE = `This project is tested with TraceQA, an MCP server named "traceqa". It checks the web app against the requirements in the requirements folder and keeps a plain Playwright framework in e2e/.

## Workflow
1. Call \`status\` first. It says what exists and what to do next.
2. If the app map is empty or old, call \`analyze_app\`.
3. Call \`import_requirements\`, then \`map_requirements\`. Ask the user about anything listed as unclear and save their answer with \`clarify_requirement\`.
   - Requirement documents can be in any format: Markdown, text, Word or PDF, with or without requirement IDs. TraceQA reads them as they are and gives requirements without an ID a stable REQ-… ID. Add a document with \`import_requirement_document\`, or pull Jira issues with \`import_jira_requirements\` (the Jira key becomes the requirement ID).
   - If a document reads as too few requirements, call \`read_requirement_document\`, then \`save_document_reading\` with the requirements you find in it (the document's own words; an id only if the document has one). Never rewrite the user's document to fit a format.
   - No requirements at all? Explore the app anyway: \`explore_start\` with a charter and no requirementId, record real problems with \`explore_record_finding\`, and to automate a flow that works, call \`save_discovered_flow\` (it returns an E2E-… ID) and then \`save_test\` with that ID.
4. Call \`scaffold_framework\` once, so e2e/ exists.
5. For each requirement to test:
   - \`get_requirement\` to see its acceptance criteria and mapped pages.
   - \`explore_start\` → \`explore_action\` (repeat) to try it in the browser. Use \`sign_in\` when the flow needs an account.
   - \`explore_record_finding\` only for real problems you saw (it attaches a screenshot and drafts a bug).
   - \`explore_end\`.
   - \`save_test\` once per acceptance criterion, using locators from the snapshot or \`get_page\`. Steps are structured (goto, click, fill, expectText …) and TraceQA writes the Playwright code, so every tool produces the same framework.
6. \`run_tests\` (for one requirement or all). Verdicts: **app-bug** = the app breaks the requirement (a draft bug is created); **test-broken** = call \`heal_tests\` first, and fix what it cannot with \`save_test\`; **environment** = tell the user; **flaky** = passed on retry.
7. \`report\` for the coverage summary and HTML report. The user can also watch everything live with \`traceqa ui\`.

## Rules
- Test only the app at the configured base URL. Never edit the safety rules in traceqa.config.json to get past a block.
- Prefer role, label and test-id locators. Avoid CSS selectors.
- Write secrets as \${TEST_USER_EMAIL} and \${TEST_USER_PASSWORD}, never as literal values.
- A test must check the acceptance criterion as written. If the app disagrees, keep the test failing so it becomes a bug. Never weaken an assertion to make a test pass.
- Do not approve, discard or file bugs (\`update_bug\`, \`file_bug\`) unless the user asks.
- If a requirement is unclear, ask the user instead of guessing.
`;

export interface ServerCommand {
  command: string;
  args: string[];
}

/** The package on npm. Its command is still "traceqa". */
export const NPM_PACKAGE = '@mahendarreddy/traceqa';

/** How AI tools should start the server: this installation's cli.js, or "npx -y @mahendarreddy/traceqa" with useNpx. */
export function serverCommand(projectDir: string, useNpx = false): ServerCommand {
  const project = projectDir.split(path.sep).join('/');
  if (useNpx) return { command: 'npx', args: ['-y', NPM_PACKAGE, 'mcp', '--project', project] };
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js').split(path.sep).join('/');
  return { command: 'node', args: [cli, 'mcp', '--project', project] };
}

/** Double-click launchers for the dashboard, so people who never use a terminal can open it. */
export function dashboardLaunchers(useNpx = false): { name: string; text: string; executable?: boolean }[] {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
  const win = useNpx ? `npx -y ${NPM_PACKAGE}` : `node "${cli}"`;
  const unix = useNpx ? `npx -y ${NPM_PACKAGE}` : `node "${cli.split(path.sep).join('/')}"`;
  return [
    {
      name: 'TraceQA Dashboard.cmd',
      text: `@echo off\r\nrem Opens the TraceQA dashboard for this project. Close this window to stop it.\r\ntitle TraceQA dashboard\r\ncd /d "%~dp0"\r\n${win} ui --open\r\nif errorlevel 1 pause\r\n`,
    },
    {
      name: 'TraceQA Dashboard.command',
      text: `#!/bin/sh\n# Opens the TraceQA dashboard for this project (macOS: double-click; Linux: sh "TraceQA Dashboard.command").\ncd "$(dirname "$0")"\n${unix} ui --open\n`,
      executable: true,
    },
  ];
}

function mergeMcpJson(file: string, cmd: ServerCommand): void {
  let data: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${file} is not valid JSON; fix it or add the traceqa server by hand.`);
    }
  }
  data.mcpServers = { ...(data.mcpServers ?? {}), traceqa: { command: cmd.command, args: cmd.args } };
  writeText(file, JSON.stringify(data, null, 2) + '\n');
}

function upsertSection(file: string, title: string, body: string): void {
  const start = '<!-- traceqa:start -->';
  const end = '<!-- traceqa:end -->';
  const block = `${start}\n## ${title}\n\n${body.trim()}\n${end}`;
  if (!fs.existsSync(file)) {
    writeText(file, `# Agent instructions\n\n${block}\n`);
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  writeText(file, re.test(text) ? text.replace(re, block) : `${text.trimEnd()}\n\n${block}\n`);
}

export interface InitResult {
  created: string[];
  updated: string[];
  antigravity: string;
}

export function initProject(dir: string, opts: { url?: string; agents?: boolean; npx?: boolean } = {}): InitResult {
  const created: string[] = [];
  const updated: string[] = [];
  const url = opts.url ?? 'http://localhost:3000';
  const host = new URL(url).host;
  const add = (name: string, text: string) => {
    if (writeIfMissing(path.join(dir, name), text)) created.push(name);
  };

  add(
    CONFIG_FILE,
    JSON.stringify(
      {
        baseUrl: url,
        requirements: { path: 'requirements' },
        output: { dir: 'e2e' },
        browsers: ['chromium'],
        safety: { allowedHosts: [host], blockedActions: ['Delete account', 'Sign out'], maxPagesPerSession: 40, maxMinutesPerSession: 15 },
        analyze: { maxPages: 30, skipLinks: ['sign out', 'log out', 'logout', 'delete'] },
      },
      null,
      2,
    ) + '\n',
  );
  add(
    '.env.example',
    `# Copy to .env and fill in. Use a test account, never a real customer's.\nBASE_URL=${url}\nTEST_USER_EMAIL=\nTEST_USER_PASSWORD=\n\n` +
      `# Only for TraceQA's own AI agent (AI commands and dashboard AI buttons). Set the one for ai.provider.\n# ANTHROPIC_API_KEY=\n# OPENROUTER_API_KEY=\n`,
  );
  add(
    'requirements/README.md',
    `# Requirements

Put one or more Markdown files here. TraceQA reads every \`.md\` file except this README.

\`\`\`markdown
# Checkout

## REQ-142 Valid coupon applies a discount at checkout
- AC1: A valid code reduces the total by the coupon value
- AC2: Codes are not case-sensitive
\`\`\`

- A requirement is a heading that starts with an ID like \`REQ-142\`.
- Bullets under it are acceptance criteria. \`AC1:\` prefixes are optional.
- A top-level \`# Heading\` sets the feature name for the requirements below it.
`,
  );

  for (const l of dashboardLaunchers(opts.npx)) {
    if (writeIfMissing(path.join(dir, l.name), l.text)) {
      created.push(l.name);
      if (l.executable) fs.chmodSync(path.join(dir, l.name), 0o755);
    }
  }

  const gitignore = path.join(dir, '.gitignore');
  const wanted = [
    '.env', '.traceqa/sessions/', '.traceqa/runs/', '.traceqa/evidence/', '.traceqa/report/', '.traceqa/jobs/', '.traceqa/trash/', '.traceqa/doc-cache/',
    'e2e/node_modules/', 'e2e/results/',
  ];
  const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  const missing = wanted.filter((w) => !existing.split(/\r?\n/).includes(w));
  if (missing.length) {
    writeText(gitignore, `${existing.trimEnd()}${existing ? '\n\n' : ''}# TraceQA\n${missing.join('\n')}\n`);
    (existing ? updated : created).push('.gitignore');
  }

  const cmd = serverCommand(dir, opts.npx);
  const antigravity = JSON.stringify({ mcpServers: { traceqa: { command: cmd.command, args: cmd.args } } }, null, 2);

  if (opts.agents) {
    for (const name of ['.mcp.json', '.cursor/mcp.json']) {
      const existed = fs.existsSync(path.join(dir, name));
      mergeMcpJson(path.join(dir, name), cmd);
      (existed ? updated : created).push(name);
    }
    const codex = path.join(dir, '.codex', 'config.toml');
    const codexText = fs.existsSync(codex) ? fs.readFileSync(codex, 'utf8') : '';
    if (!codexText.includes('[mcp_servers.traceqa]')) {
      const toml = `[mcp_servers.traceqa]\ncommand = '${cmd.command}'\nargs = [${cmd.args.map((a) => `'${a}'`).join(', ')}]\n`;
      writeText(codex, `${codexText.trimEnd()}${codexText ? '\n\n' : ''}${toml}`);
      (codexText ? updated : created).push('.codex/config.toml');
    }
    const agentsExisted = fs.existsSync(path.join(dir, 'AGENTS.md'));
    upsertSection(path.join(dir, 'AGENTS.md'), 'Testing with TraceQA', AGENT_GUIDE);
    (agentsExisted ? updated : created).push('AGENTS.md');

    writeText(
      path.join(dir, '.claude', 'skills', 'traceqa', 'SKILL.md'),
      `---\nname: traceqa\ndescription: Test this web app against its requirements with the TraceQA MCP server. Use when asked to test, explore, write or run end-to-end tests, check requirement coverage, or triage test failures.\n---\n\n# Testing with TraceQA\n\n${AGENT_GUIDE}`,
    );
    created.push('.claude/skills/traceqa/SKILL.md');
    writeText(
      path.join(dir, '.cursor', 'rules', 'traceqa.mdc'),
      `---\ndescription: Test this web app against its requirements with the TraceQA MCP server\nalwaysApply: false\n---\n\n# Testing with TraceQA\n\n${AGENT_GUIDE}`,
    );
    created.push('.cursor/rules/traceqa.mdc');
  }
  return { created, updated, antigravity };
}
