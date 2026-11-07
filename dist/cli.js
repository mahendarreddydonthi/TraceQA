#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { activeModel, loadProject } from './core/config.js';
import { analyzeApp } from './core/appMap.js';
import { clarify, importRequirements, openIssues } from './core/requirements.js';
import { mapRequirements } from './core/mapper.js';
import { scaffold } from './core/scaffold.js';
import { loadTests, renderAll } from './core/testgen.js';
import { formatRun, runTests } from './core/runner.js';
import { bugMarkdown, getBug, listBugs, setBugStatus } from './core/bugs.js';
import { buildReport } from './core/report.js';
import { projectStatus } from './core/status.js';
import { initProject } from './core/init.js';
import { rel } from './core/store.js';
import { latestResults } from './core/coverage.js';
import { loadRequirements } from './core/requirements.js';
import { formatHeals, healTests, reviewHeal } from './core/heal.js';
import { fileBugInJira } from './core/jira.js';
import { EXPLORE_TOOLS, generateTargets, runAgent, tasks } from './ai/agent.js';
import { formatUsage } from './ai/pricing.js';
import { startMcpServer } from './mcp/server.js';
import { startDashboard } from './ui/server.js';
async function agentRun(p, task, allowTools) {
    console.log(`AI agent (${activeModel(p.config.ai).label}, effort ${p.config.ai.effort}) working …`);
    // Ctrl+C stops the run cleanly (closes any exploration browser) instead of killing it mid-step.
    const controller = new AbortController();
    const onSigint = () => {
        console.log('\nStopping …');
        controller.abort();
    };
    process.once('SIGINT', onSigint);
    try {
        const r = await runAgent(p, { task, allowTools, log: (l) => console.log(l), signal: controller.signal });
        console.log(`\n${r.finalText}\n\n(${r.turns} turns, ${r.toolCalls} tool calls, stop: ${r.stopReason}; ${formatUsage(r.usage)})`);
        if (r.stopReason === 'refusal' || r.stopReason === 'max_turns')
            process.exitCode = 1;
    }
    finally {
        process.removeListener('SIGINT', onSigint);
    }
}
const program = new Command();
program
    .name('traceqa')
    .description('Requirement-driven testing agent: maps requirements to your app, explores it, and keeps a Playwright framework in sync.')
    .version('0.3.0')
    .option('--project <dir>', 'project folder (default: nearest folder with traceqa.config.json)');
const project = () => loadProject(program.opts().project);
function action(fn) {
    return async (...args) => {
        try {
            await fn(...args);
        }
        catch (err) {
            console.error(`traceqa: ${err instanceof Error ? err.message : String(err)}`);
            process.exitCode = 1;
        }
    };
}
program
    .command('init')
    .description('Set up TraceQA in a project folder')
    .option('--url <url>', 'base URL of the app under test (staging)')
    .option('--agents', 'also connect AI coding tools: .mcp.json, .cursor/, .codex/, AGENTS.md, Claude skill')
    .option('--npx', 'use "npx -y traceqa mcp" in AI tool configs (once TraceQA is published to npm)')
    .action(action((opts) => {
    const dir = path.resolve(program.opts().project ?? process.cwd());
    const r = initProject(dir, opts);
    console.log(`TraceQA set up in ${dir}`);
    for (const f of r.created)
        console.log(`  created  ${f}`);
    for (const f of r.updated)
        console.log(`  updated  ${f}`);
    console.log('\nNext: copy .env.example to .env, add requirements, then run "traceqa analyze".');
    if (opts.agents) {
        console.log('\nAntigravity: open MCP Servers → Manage MCP Servers → View raw config and add:');
        console.log(r.antigravity);
    }
}));
program
    .command('status')
    .description('Show what TraceQA knows and the next step')
    .action(action(() => console.log(projectStatus(project()))));
program
    .command('analyze')
    .description('Crawl the app and build the app map')
    .option('--max-pages <n>', 'stop after this many page types', (v) => Number(v))
    .action(action(async (opts) => {
    const p = project();
    console.log(`Analyzing ${p.config.baseUrl} …`);
    const r = await analyzeApp(p, { maxPages: opts.maxPages, log: (l) => console.log(l) });
    console.log(`Done: ${r.map.pages.length} pages in the app map${r.signedIn ? ' (signed in)' : ''} → ${rel(p.dir, p.paths.appMap)}`);
    for (const e of r.errors)
        console.log(`  ! ${e}`);
}));
const reqCmd = program.command('requirements').description('Import and clarify requirements');
reqCmd
    .command('import')
    .description('Read the Markdown requirement files')
    .action(action(() => {
    const { file, files } = importRequirements(project());
    console.log(`Imported ${file.requirements.length} requirements from ${files.length} files.`);
    for (const r of file.requirements) {
        const issues = openIssues(r);
        console.log(`  ${r.id.padEnd(9)} ${r.title}${issues.length ? `  ⚠ ${issues.length} issue(s)` : ''}`);
        for (const i of issues)
            console.log(`      ${i.acId ?? ''} ${i.message}`);
    }
}));
reqCmd
    .command('clarify <requirementId> <acId> <text...>')
    .description('Save a clearer wording for one acceptance criterion')
    .action(action((requirementId, acId, text) => {
    const ac = clarify(project(), requirementId, acId, text.join(' '));
    console.log(`${requirementId.toUpperCase()} ${ac.id}: ${ac.text}`);
}));
program
    .command('map')
    .description('Link requirements to app pages and show gaps')
    .action(action(() => {
    const t = mapRequirements(project());
    for (const l of t.links)
        console.log(`  ${l.requirementId.padEnd(9)} → ${l.pages.map((p) => p.pageId).join(', ') || '(no page)'}`);
    console.log(`Pages with no requirement: ${t.pagesWithoutRequirements.join(', ') || 'none'}`);
}));
program
    .command('scaffold')
    .description('Create or refresh the Playwright framework')
    .option('--no-install', 'do not run npm install in the framework folder')
    .action(action(async (opts) => {
    const p = project();
    const r = await scaffold(p, { install: opts.install });
    console.log(`Framework at ${rel(p.dir, p.paths.e2e)}/: ${r.pageObjects} page objects, ${r.specs} spec files.`);
    for (const f of r.created)
        console.log(`  created  ${f}`);
    console.log(r.installed ? 'Dependencies installed.' : 'Dependencies not installed; run npm install in the framework folder.');
}));
program
    .command('render')
    .description('Re-render page objects and spec files from the app map and saved tests (no AI)')
    .action(action(() => {
    const p = project();
    const r = renderAll(p);
    console.log(`Rendered ${r.pageObjects.length} page objects and ${r.specs.length} spec files.${r.removed.length ? ` Removed ${r.removed.length} stale files.` : ''}`);
}));
program
    .command('generate')
    .description('AI: write tests for requirements (one per acceptance criterion), verify and run them. Needs an Anthropic API key.')
    .option('--req <ids...>', 'requirement IDs, e.g. REQ-142 REQ-150')
    .option('--gaps', 'every requirement that is not covered or only partly covered')
    .option('--all', 'every requirement')
    .action(action(async (opts) => {
    const p = project();
    if (!opts.req?.length && !opts.gaps && !opts.all)
        throw new Error('Name requirements with --req REQ-1 REQ-2, or use --gaps or --all.');
    const ids = generateTargets(p, { ids: opts.req, gaps: opts.gaps, all: opts.all });
    await agentRun(p, tasks.generate(ids));
}));
program
    .command('tests')
    .description('List saved tests')
    .action(action(() => {
    for (const t of loadTests(project()))
        console.log(`  ${t.id}${t.lastVerification ? `  (last ${t.lastVerification.status})` : ''}`);
}));
program
    .command('run')
    .description('Run the tests, sort failures and draft bugs')
    .option('--req <id>', 'only one requirement')
    .option('--grep <pattern>', 'Playwright --grep pattern')
    .option('--browser <name>', 'Playwright project name')
    .action(action(async (opts) => {
    const run = await runTests(project(), { requirementId: opts.req, grep: opts.grep, browser: opts.browser });
    console.log(formatRun(run));
    if (run.totals.failed)
        process.exitCode = 1;
}));
const bugs = program.command('bugs').description('Review drafted bugs');
bugs
    .command('list')
    .option('--status <status>', 'draft, approved or discarded')
    .action(action((opts) => {
    const list = listBugs(project(), opts.status);
    if (!list.length)
        console.log('No bugs.');
    for (const b of list)
        console.log(`  ${b.id} [${b.status} · ${b.severity}] ${b.title}`);
}));
bugs.command('show <id>').action(action((id) => {
    const p = project();
    console.log(bugMarkdown(p, getBug(p, id)));
}));
bugs
    .command('approve <id>')
    .option('--note <text>')
    .action(action((id, opts) => {
    const p = project();
    const r = setBugStatus(p, id, 'approved', opts.note);
    console.log(`${r.bug.id} approved. Ticket text: ${r.exported ? rel(p.dir, r.exported) : ''}`);
}));
bugs
    .command('file <id>')
    .description('File the bug in Jira (or comment on the open issue for the same requirement criterion)')
    .action(action(async (id) => {
    const r = await fileBugInJira(project(), id);
    const t = r.bug.ticket;
    console.log(`${r.bug.id} ${r.created ? 'filed as' : 'linked to existing issue'} ${t.key}: ${t.url} (${r.attached} attachment(s))`);
}));
bugs
    .command('discard <id>')
    .option('--note <text>')
    .action(action((id, opts) => console.log(`${setBugStatus(project(), id, 'discarded', opts.note).bug.id} discarded.`)));
bugs
    .command('reopen <id>')
    .description('Turn a discarded bug back into a draft')
    .action(action((id) => console.log(`${setBugStatus(project(), id, 'draft').bug.id} is a draft again.`)));
program
    .command('report')
    .description('Write the HTML coverage report')
    .option('--open', 'open it in the default browser')
    .action(action((opts) => {
    const { file, markdown } = buildReport(project());
    console.log(markdown);
    if (opts.open) {
        const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    }
}));
program
    .command('explore')
    .description('AI: explore one requirement in a real browser and record findings as draft bugs. Needs an Anthropic API key.')
    .requiredOption('--req <id>', 'requirement to explore, e.g. REQ-142')
    .option('--charter <text>', 'what to focus on')
    .option('--headed', 'show the browser window so you can watch')
    .action(action(async (opts) => {
    const p = project();
    const id = opts.req.toUpperCase();
    if (!loadRequirements(p).some((r) => r.id === id))
        throw new Error(`Unknown requirement ${id}. Run "traceqa requirements import" first.`);
    const task = tasks.explore(id, opts.charter) + (opts.headed ? ' Call explore_start with headed: true so the user can watch.' : '');
    await agentRun(p, task, EXPLORE_TOOLS);
}));
program
    .command('heal')
    .description('Repair tests that broke after a UI change (locator no longer found). Assertions are never changed.')
    .option('--run', 'run all tests first to find broken ones')
    .option('--dry-run', 'only propose fixes (review them with --apply or --reject, or in the dashboard)')
    .option('--apply <healId>', 'apply a proposed heal, e.g. HEAL-004')
    .option('--reject <healId>', 'reject a proposed heal')
    .option('--ai', 'hand tests that cannot be healed automatically to the AI agent (needs an Anthropic API key)')
    .action(action(async (opts) => {
    const p = project();
    if (opts.apply || opts.reject) {
        const record = await reviewHeal(p, (opts.apply ?? opts.reject), opts.apply ? 'apply' : 'reject');
        console.log(formatHeals({ records: [record], candidates: 1 }));
        return;
    }
    if (opts.run || !latestResults(p).length) {
        console.log('Running tests to find broken ones …');
        console.log(formatRun(await runTests(p, {})));
    }
    const result = await healTests(p, { apply: !opts.dryRun, log: (l) => console.log(l) });
    console.log(formatHeals(result));
    const left = result.records.filter((r) => r.status === 'failed').map((r) => r.testId);
    if (left.length && opts.ai && !opts.dryRun)
        await agentRun(p, tasks.heal(left));
    else if (left.length)
        console.log(`\n${left.length} test(s) need a person or the AI: traceqa heal --ai`);
}));
program
    .command('agent <task...>')
    .description('AI: give TraceQA a task in plain words, e.g. traceqa agent "test REQ-131 and REQ-150"')
    .action(action(async (task) => agentRun(project(), task.join(' '))));
program
    .command('ui')
    .description('Open the dashboard, where every step can be done with buttons (localhost only). In a new folder it starts with setup.')
    .option('--port <n>', 'port', (v) => Number(v), 4400)
    .option('--open', 'open it in the default browser')
    .action(action(async (opts, cmd) => {
    // With the default port, step to the next free one so several projects can be open at once.
    const explicit = cmd.getOptionValueSource('port') === 'cli';
    let started;
    for (let port = opts.port; !started; port++) {
        try {
            started = await startDashboard(program.opts().project, { port });
        }
        catch (err) {
            if (err.code !== 'EADDRINUSE' || explicit || port >= opts.port + 9)
                throw err;
        }
    }
    const { url, dir } = started;
    console.log(`TraceQA dashboard for ${dir}: ${url}  (Ctrl+C to stop)`);
    if (opts.open) {
        const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    }
}));
program
    .command('mcp')
    .description('Start the MCP server on stdio (AI coding tools run this for you)')
    .option('--project <dir>', 'project folder')
    .action(async (opts) => {
    await startMcpServer(opts.project ?? program.opts().project);
});
program.parseAsync(process.argv);
//# sourceMappingURL=cli.js.map