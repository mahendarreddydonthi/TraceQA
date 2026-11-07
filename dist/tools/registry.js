import { z } from 'zod';
import { loadProject } from '../core/config.js';
import { analyzeApp, loadAppMap } from '../core/appMap.js';
import { clarify, importRequirements, loadRequirements, openIssues } from '../core/requirements.js';
import { loadTraceability, mapRequirements } from '../core/mapper.js';
import { ExploreSession } from '../core/explorer.js';
import { LocatorSchema } from '../core/locators.js';
import { hasInstalledDeps, scaffold } from '../core/scaffold.js';
import { loadTests, removeTest, saveTest, StepSchema } from '../core/testgen.js';
import { formatRun, runTests } from '../core/runner.js';
import { bugMarkdown, getBug, listBugs, setBugStatus } from '../core/bugs.js';
import { computeCoverage } from '../core/coverage.js';
import { buildReport } from '../core/report.js';
import { projectStatus } from '../core/status.js';
import { formatHeals, healTests, reviewHeal } from '../core/heal.js';
import { fileBugInJira } from '../core/jira.js';
import { rel } from '../core/store.js';
export function buildTools(projectDir, ctx = {}) {
    const load = () => loadProject(projectDir);
    const { signal, log } = ctx;
    const active = () => {
        const s = ExploreSession.active;
        if (!s)
            throw new Error('No open session. Call explore_start first.');
        return s;
    };
    return [
        {
            name: 'status',
            title: 'Project status',
            description: 'Shows what TraceQA knows about this project (app map, requirements, tests, runs, bugs) and the next step. Call this first.',
            inputSchema: {},
            readOnly: true,
            run: () => projectStatus(load()),
        },
        {
            name: 'analyze_app',
            title: 'Analyze the app',
            description: 'Crawls the app from its base URL (allowed hosts only, signed in if auth is configured) and records each page type with its elements and stable locators in the app map.',
            inputSchema: { maxPages: z.number().int().positive().max(200).optional().describe('Stop after this many page types (default from config)') },
            run: async ({ maxPages }) => {
                const res = await analyzeApp(load(), { maxPages, signal, log });
                const pages = res.map.pages.map((p) => `- ${p.id}: ${p.templatePath} · ${p.className} · ${p.elements.length} elements`);
                return [
                    `Analyzed ${res.visited.length} page types${res.signedIn ? ' (signed in)' : ''}. App map now has ${res.map.pages.length} pages.`,
                    ...pages,
                    res.errors.length ? `Problems:\n${res.errors.map((e) => `- ${e}`).join('\n')}` : '',
                    'Pages behind a form (like checkout) are added when an exploration session reaches them.',
                ].filter(Boolean).join('\n');
            },
        },
        {
            name: 'import_requirements',
            title: 'Import requirements',
            description: 'Reads the Markdown requirement files and flags criteria that cannot be tested as written.',
            inputSchema: {},
            run: () => {
                const { file, files, duplicates } = importRequirements(load());
                const lines = [`Imported ${file.requirements.length} requirements from ${files.length} files (${files.join(', ')}).`];
                for (const r of file.requirements) {
                    const issues = openIssues(r);
                    lines.push(`- ${r.id} ${r.title} [${r.feature}] · ${r.criteria.length} criteria${issues.length ? ` · ${issues.length} issue(s)` : ''}`);
                    for (const i of issues)
                        lines.push(`    ${i.acId ?? r.id}: ${i.message}`);
                }
                if (duplicates.length)
                    lines.push(`Duplicate IDs ignored: ${duplicates.join(', ')}`);
                return lines.join('\n');
            },
        },
        {
            name: 'clarify_requirement',
            title: 'Clarify a requirement',
            description: 'Saves a clearer, testable wording for one acceptance criterion, as agreed with the user. The source file is not changed; suggest the user updates it too.',
            inputSchema: { requirementId: z.string(), acId: z.string().describe('e.g. AC1'), text: z.string().describe('New testable wording') },
            humanOnly: true,
            run: ({ requirementId, acId, text }) => {
                const ac = clarify(load(), requirementId, acId, text);
                return `${requirementId.toUpperCase()} ${ac.id} is now: ${ac.text}${ac.issues.length ? `\nStill unclear: ${ac.issues.map((i) => i.message).join(' ')}` : ''}`;
            },
        },
        {
            name: 'map_requirements',
            title: 'Map requirements to pages',
            description: 'Links each requirement to the app pages it is about, and lists gaps both ways.',
            inputSchema: {},
            run: () => {
                const project = load();
                const t = mapRequirements(project);
                const map = loadAppMap(project);
                const name = (id) => map.pages.find((p) => p.id === id)?.templatePath ?? id;
                return [
                    ...t.links.map((l) => `- ${l.requirementId} → ${l.pages.map((p) => `${name(p.pageId)} (${p.terms.slice(0, 4).join(', ')})`).join('; ') || 'no matching page'}`),
                    `Requirements with no matching page: ${t.unmappedRequirements.join(', ') || 'none'}`,
                    `Pages with no requirement: ${t.pagesWithoutRequirements.map(name).join(', ') || 'none'}`,
                ].join('\n');
            },
        },
        {
            name: 'get_requirement',
            title: 'Get a requirement',
            description: 'Acceptance criteria, mapped pages, tests, status and bugs for one requirement.',
            inputSchema: { requirementId: z.string() },
            readOnly: true,
            run: ({ requirementId }) => {
                const project = load();
                const id = requirementId.toUpperCase();
                const req = loadRequirements(project).find((r) => r.id === id);
                if (!req)
                    throw new Error(`Unknown requirement ${requirementId}.`);
                const cov = computeCoverage(project).find((c) => c.requirementId === id);
                const map = loadAppMap(project);
                const link = loadTraceability(project).links.find((l) => l.requirementId === id);
                const tests = loadTests(project).filter((t) => t.requirementId === id);
                return [
                    `${req.id} · ${req.title} (${req.feature})`,
                    `Source: ${req.source.file}:${req.source.line}`,
                    req.description ? `Description: ${req.description}` : '',
                    `Status: ${cov.status} · ${cov.tests} tests`,
                    'Criteria:',
                    ...req.criteria.map((c) => {
                        const cc = cov.criteria.find((x) => x.acId === c.id);
                        return `  ${c.id}: ${c.text}${c.clarified ? ' (clarified)' : ''} — ${cc.tests} test(s), ${cc.passed} passed, ${cc.failed} failed${c.issues.length ? `\n      issue: ${c.issues.map((i) => i.message).join(' ')}` : ''}`;
                    }),
                    `Mapped pages: ${link?.pages.map((p) => { const pg = map.pages.find((x) => x.id === p.pageId); return `${p.pageId} (${pg?.templatePath}, ${pg?.className})`; }).join(', ') || 'none (run map_requirements)'}`,
                    tests.length ? `Tests:\n${tests.map((t) => `  ${t.id}${t.lastVerification ? ` — last ${t.lastVerification.status}` : ''}`).join('\n')}` : 'Tests: none',
                    `Bugs: ${cov.bugs.join(', ') || 'none'}`,
                ].filter(Boolean).join('\n');
            },
        },
        {
            name: 'get_page',
            title: 'Get an app map page',
            description: 'Lists app map pages, or shows one page with its elements and the exact locator objects to use in save_test.',
            inputSchema: { pageId: z.string().optional(), path: z.string().optional().describe('Alternative to pageId, e.g. /cart') },
            readOnly: true,
            run: ({ pageId, path: p }) => {
                const map = loadAppMap(load());
                if (!pageId && !p)
                    return map.pages.map((x) => `- ${x.id}: ${x.templatePath} · ${x.className} · ${x.name} · ${x.elements.length} elements (${x.source})`).join('\n') || 'The app map is empty. Run analyze_app.';
                const page = map.pages.find((x) => x.id === pageId) ?? map.pages.find((x) => x.templatePath === p || x.path === p);
                if (!page)
                    throw new Error(`No page ${pageId ?? p}. Known: ${map.pages.map((x) => x.id).join(', ')}`);
                return [
                    `${page.id}: ${page.name} · ${page.templatePath} (example ${page.path}) · class ${page.className} · from ${page.source}`,
                    `Headings: ${page.headings.join(' | ')}`,
                    'Elements (key · role "name" · locator for save_test · stability):',
                    ...page.elements.map((e) => `  ${e.key} · ${e.role} "${e.name}" · ${JSON.stringify(e.locator)} · ${e.stability}`),
                ].join('\n');
            },
        },
        {
            name: 'explore_start',
            title: 'Start exploring',
            description: 'Opens a browser on the app for a focused exploration session. Every step is screenshotted and checked against the safety rules. Returns a snapshot with element refs.',
            inputSchema: {
                charter: z.string().describe('What to explore, e.g. "Check REQ-142 coupon rules with valid, lowercase and expired codes"'),
                requirementId: z.string().optional(),
                startPath: z.string().optional().describe('Path to open first (default /)'),
                signIn: z.boolean().optional().describe('Sign in with the test account first'),
                headed: z.boolean().optional().describe('Show the browser window so the user can watch'),
            },
            run: async (a) => {
                const s = await ExploreSession.start(load(), a);
                return `Session ${s.id} started. ${s.steps.length} step(s) so far.\n\n${await s.snapshot()}`;
            },
        },
        {
            name: 'explore_action',
            title: 'Act in the exploration browser',
            description: 'Performs one action (goto, click, fill, select, check, uncheck, press, hover, back, wait, sign_in) on a ref from the latest snapshot or on a locator. Returns the result and a new snapshot.',
            inputSchema: {
                action: z.enum(['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover', 'back', 'wait', 'sign_in']),
                ref: z.string().optional().describe('Element ref from the latest snapshot, e.g. e7'),
                locator: LocatorSchema.optional().describe('Use instead of ref'),
                value: z.string().optional().describe('For fill/select. Use ${TEST_USER_EMAIL}-style placeholders for secrets'),
                path: z.string().optional().describe('For goto'),
                key: z.string().optional().describe('For press, e.g. Enter'),
                ms: z.number().int().optional().describe('For wait (max 5000)'),
            },
            run: (a) => active().act(a),
        },
        {
            name: 'explore_snapshot',
            title: 'Snapshot the exploration browser',
            description: 'Returns the current page snapshot without acting.',
            inputSchema: {},
            readOnly: true,
            run: () => active().snapshot(),
        },
        {
            name: 'explore_record_finding',
            title: 'Record a finding',
            description: 'Records a real problem seen in this session. Attaches a full-page screenshot and the steps, and drafts a bug for the user to review.',
            inputSchema: {
                title: z.string().describe('Short, specific, e.g. "Lowercase coupon codes are rejected"'),
                severity: z.enum(['high', 'medium', 'low']),
                expected: z.string(),
                actual: z.string(),
                requirementId: z.string().optional(),
                acId: z.string().optional(),
                category: z.enum(['functional', 'accessibility', 'console', 'network', 'visual', 'other']).optional(),
            },
            run: async (a) => {
                const s = active();
                const { finding, bug } = await s.recordFinding(a);
                return `Finding ${finding.n} recorded with screenshot ${rel(s.project.dir, finding.screenshot)}. Draft bug ${bug.id} created (not filed).`;
            },
        },
        {
            name: 'explore_end',
            title: 'End exploring',
            description: 'Closes the browser and writes the session report.',
            inputSchema: {},
            run: () => active().end(),
        },
        {
            name: 'scaffold_framework',
            title: 'Create the Playwright framework',
            description: 'Creates (or refreshes) the plain Playwright project: config, fixtures, page objects from the app map, and spec files from saved tests. Installs @playwright/test unless install is false.',
            inputSchema: { install: z.boolean().optional() },
            run: async ({ install }) => {
                const project = load();
                const r = await scaffold(project, { install, signal, log });
                return [
                    `Framework at ${rel(project.dir, project.paths.e2e)}/: ${r.pageObjects} page objects, ${r.specs} spec files.`,
                    r.created.length ? `Created: ${r.created.join(', ')}` : 'No new base files (existing ones kept).',
                    r.browsersUpdated ? 'Updated the browser list in playwright.config.ts.' : '',
                    r.installed ? 'Dependencies installed.' : `Dependencies NOT installed.${r.installOutput ? `\n${r.installOutput}` : ''}`,
                ].filter(Boolean).join('\n');
            },
        },
        {
            name: 'save_test',
            title: 'Save a test',
            description: 'Saves one test for an acceptance criterion as structured steps; TraceQA renders consistent Playwright code (page objects where the locator is in the app map) and, by default, runs it once. Saving the same requirement + criterion + title again replaces it.',
            inputSchema: {
                requirementId: z.string(),
                acId: z.string().optional().describe('Acceptance criterion this test proves, e.g. AC3'),
                title: z.string().describe('Short behaviour, e.g. "codes are not case-sensitive"'),
                signedIn: z.boolean().optional().describe('Sign in with the test account before the steps'),
                steps: z.array(StepSchema).min(1),
                verify: z.boolean().optional().describe('Run the test right after saving (default true)'),
            },
            run: async (a) => {
                const project = load();
                const { def, file, warnings } = saveTest(project, a);
                const lines = [`Saved ${def.id} in ${rel(project.dir, file)}.`, ...warnings.map((w) => `Warning: ${w}`)];
                if (a.verify === false)
                    return lines.join('\n');
                if (!hasInstalledDeps(project)) {
                    lines.push('Not run: the framework is not installed yet (scaffold_framework).');
                    return lines.join('\n');
                }
                const run = await runTests(project, { testId: def.id, retries: 0, draftBugs: false, record: false, signal });
                if (!run.results.length)
                    lines.push(`Check run found no matching test. Output:\n${run.output.split('\n').slice(-8).join('\n')}`);
                for (const r of run.results) {
                    if (r.status === 'passed')
                        lines.push(`Check run: PASSED (${r.project}).`);
                    else {
                        lines.push(`Check run: ${r.status.toUpperCase()} (${r.project}) · verdict ${r.verdict}`);
                        if (r.error)
                            lines.push(r.error.split('\n').slice(0, 8).join('\n'));
                        if (r.verdict === 'app-bug')
                            lines.push('The assertion failed. If the app is wrong (not the test), keep the test as it is: run_tests will draft a bug.');
                        if (r.verdict === 'test-broken')
                            lines.push('The test could not find or use an element. Check the locators with get_page or an exploration snapshot, then save_test again.');
                    }
                }
                return lines.join('\n');
            },
        },
        {
            name: 'list_tests',
            title: 'List tests',
            description: 'Lists saved tests, optionally for one requirement.',
            inputSchema: { requirementId: z.string().optional() },
            readOnly: true,
            run: ({ requirementId }) => {
                const tests = loadTests(load()).filter((t) => !requirementId || t.requirementId === requirementId.toUpperCase());
                return tests.map((t) => `- ${t.id}: ${t.steps.length} steps${t.lastVerification ? ` · last ${t.lastVerification.status}` : ''}`).join('\n') || 'No tests saved.';
            },
        },
        {
            name: 'remove_test',
            title: 'Remove a test',
            description: 'Deletes a saved test and re-renders the spec files.',
            inputSchema: { testId: z.string() },
            destructive: true,
            humanOnly: true,
            run: ({ testId }) => `Removed ${removeTest(load(), testId).id}.`,
        },
        {
            name: 'run_tests',
            title: 'Run tests',
            description: 'Runs the Playwright tests (all, one requirement, or a grep), sorts each failure (app-bug, test-broken, flaky, environment) and drafts bugs for app bugs.',
            inputSchema: {
                requirementId: z.string().optional(),
                testId: z.string().optional().describe('One saved test id from list_tests'),
                grep: z.string().optional(),
                browser: z.string().optional().describe('Playwright project name, e.g. chromium'),
            },
            run: async (a) => formatRun(await runTests(load(), { ...a, signal, log })),
        },
        {
            name: 'heal_tests',
            title: 'Heal broken tests',
            description: 'Repairs tests whose latest result is "test-broken" (an action could not find its element, usually after a UI change). Replays each test, swaps the broken locator for the closest match on the live page, re-runs it, and restores the original if that does not help. Assertions are never changed.',
            inputSchema: {
                testIds: z.array(z.string()).optional().describe('Only these tests (default: every test-broken failure in the latest results)'),
                dryRun: z.boolean().optional().describe('Only propose fixes, do not change tests'),
            },
            run: async ({ testIds, dryRun }) => formatHeals(await healTests(load(), { testIds, apply: !dryRun, signal, log })),
        },
        {
            name: 'review_heal',
            title: 'Apply or reject a proposed heal',
            description: 'Only when the user asks. Applies a heal proposed by a dry run (swaps the locators in, re-runs the test, restores the original if it still breaks), or rejects it.',
            inputSchema: { healId: z.string().describe('e.g. HEAL-004'), decision: z.enum(['apply', 'reject']) },
            humanOnly: true,
            run: async ({ healId, decision }) => formatHeals({ records: [await reviewHeal(load(), healId, decision, { signal })], candidates: 1 }),
        },
        {
            name: 'list_bugs',
            title: 'List bugs',
            description: 'Lists bugs drafted from explorations and test runs.',
            inputSchema: { status: z.enum(['draft', 'approved', 'filed', 'discarded']).optional() },
            readOnly: true,
            run: ({ status }) => listBugs(load(), status)
                .map((b) => `- ${b.id} [${b.status} · ${b.severity}] ${b.title}${b.requirementId ? ` (${b.requirementId}${b.acId ? ` ${b.acId}` : ''})` : ''}${b.ticket ? ` → ${b.ticket.key}` : ''}`)
                .join('\n') || 'No bugs.',
        },
        {
            name: 'get_bug',
            title: 'Get a bug',
            description: 'Shows one bug as a ticket-ready report.',
            inputSchema: { bugId: z.string() },
            readOnly: true,
            run: ({ bugId }) => {
                const project = load();
                return bugMarkdown(project, getBug(project, bugId));
            },
        },
        {
            name: 'update_bug',
            title: 'Approve or discard a bug',
            description: 'Only when the user asks. Approving writes a ticket-ready Markdown file next to the bug; discarding hides it.',
            inputSchema: { bugId: z.string(), status: z.enum(['approved', 'discarded']), note: z.string().optional() },
            humanOnly: true,
            run: ({ bugId, status, note }) => {
                const project = load();
                const r = setBugStatus(project, bugId, status, note);
                return `${r.bug.id} is now ${r.bug.status}.${r.exported ? ` Ticket text: ${rel(project.dir, r.exported)}` : ''}`;
            },
        },
        {
            name: 'file_bug',
            title: 'File a bug in Jira',
            description: 'Only when the user explicitly asks to file this bug. Creates a Jira issue with steps, expected/actual and evidence attached; if an open issue already exists for the same requirement criterion, comments on it instead of creating a duplicate.',
            inputSchema: { bugId: z.string() },
            humanOnly: true,
            run: async ({ bugId }) => {
                const r = await fileBugInJira(load(), bugId);
                const t = r.bug.ticket;
                return `${r.bug.id} ${r.created ? 'filed as' : 'linked to existing issue'} ${t.key} (${t.url}); ${r.attached} attachment(s).`;
            },
        },
        {
            name: 'report',
            title: 'Coverage report',
            description: 'Writes the HTML report and returns a coverage summary.',
            inputSchema: {},
            run: () => buildReport(load()).markdown,
        },
    ];
}
/** JSON Schema for a tool's input, for the Claude API. */
export function toJsonSchema(tool) {
    const schema = z.toJSONSchema(z.object(tool.inputSchema), { io: 'input' });
    delete schema.$schema;
    return schema;
}
//# sourceMappingURL=registry.js.map