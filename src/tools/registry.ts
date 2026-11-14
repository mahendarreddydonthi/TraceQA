import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadProject, type Project } from '../core/config.js';
import { importDocument } from '../core/documents.js';
import { importJiraRequirements } from '../core/jira-import.js';
import { analyzeApp, loadAppMap } from '../core/appMap.js';
import { addDiscoveredFlow, clarify, documentText, importRequirements, loadRequirements, openIssues, requirementsFromFile, resolveRequirementFile, saveReading } from '../core/requirements.js';
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

/**
 * Every TraceQA tool, defined once. The MCP server exposes them to AI coding tools;
 * the standalone CLI agent offers the same tools to Claude directly.
 */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  readOnly?: boolean;
  destructive?: boolean;
  /** Needs a person's decision (approve, discard, file a bug). Never offered to the unattended CLI agent. */
  humanOnly?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (args: any) => Promise<string> | string;
}

/** Optional context: the dashboard passes a Stop signal and a live log; the MCP server passes nothing. */
export interface ToolContext {
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export function buildTools(projectDir?: string, ctx: ToolContext = {}): ToolDef[] {
  const load = (): Project => loadProject(projectDir);
  const { signal, log } = ctx;
  const active = (): ExploreSession => {
    const s = ExploreSession.active;
    if (!s) throw new Error('No open session. Call explore_start first.');
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
      run: async ({ maxPages }: { maxPages?: number }) => {
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
      description:
        'Reads every requirement document in the requirements folder, whatever its format (Markdown, text, Word, PDF; headings, user stories, lists, tables or plain sentences), and flags criteria that cannot be tested as written. Requirements without an ID in the document get a stable REQ-### ID.',
      inputSchema: {},
      run: async () => {
        const { file, files, duplicates, documents } = await importRequirements(load());
        const lines = [`Imported ${file.requirements.length} requirements from ${files.length} documents.`];
        for (const d of documents) lines.push(`  ${d.file} (${d.type}, read ${d.mode === 'ai' ? 'by AI' : d.mode === 'ids' ? 'by its IDs' : 'free-form'}): ${d.requirements} requirement(s), ${d.criteria} criteria${d.reading?.stale ? ' · changed since its AI reading' : ''}`);
        for (const r of file.requirements) {
          const issues = openIssues(r);
          lines.push(`- ${r.id} ${r.title} [${r.feature}] · ${r.criteria.length} criteria${issues.length ? ` · ${issues.length} issue(s)` : ''}`);
          for (const i of issues) lines.push(`    ${i.acId ?? r.id}: ${i.message}`);
        }
        if (duplicates.length) lines.push(`Duplicate IDs ignored: ${duplicates.join(', ')}`);
        return lines.join('\n');
      },
    },
    {
      name: 'import_requirement_document',
      title: 'Add a requirement document',
      description:
        'Adds a Word (.docx), PDF, text or Markdown document from the project to the requirements folder as it is (any format, no conversion) and imports it. If few requirements are found, read it with read_requirement_document and save what you understand with save_document_reading.',
      inputSchema: { path: z.string().describe('Path of the document, relative to the project folder') },
      run: async ({ path: p }: { path: string }) => {
        const project = load();
        const full = path.resolve(project.dir, p);
        if (!full.startsWith(path.resolve(project.dir) + path.sep) || !fs.existsSync(full)) throw new Error(`No file ${p} inside the project folder.`);
        const inside = full.startsWith(path.resolve(project.paths.requirementsDir) + path.sep);
        if (inside) {
          const r = await importRequirements(project);
          const d = r.documents.find((x) => path.resolve(project.paths.requirementsDir, x.file) === full);
          return `${p} is already in the requirements folder: ${d?.requirements ?? 0} requirement(s), ${d?.criteria ?? 0} criteria.`;
        }
        const r = await importDocument(project, path.basename(full), fs.readFileSync(full));
        return [
          `Added ${p} (${r.kind}) as requirements/${r.file}: ${r.requirements} requirement(s), ${r.criteria} acceptance criteria.`,
          ...r.warnings.map((w) => `Warning: ${w}`),
          r.suggestAi ? 'Few requirements were found automatically. Call read_requirement_document, then save_document_reading with the requirements you find.' : 'Call map_requirements next.',
        ].join('\n');
      },
    },
    {
      name: 'read_requirement_document',
      title: 'Read a requirement document',
      description: 'Returns the text of a requirement document (Word and PDF included) and what TraceQA understood from it, so you can check it or read it yourself.',
      inputSchema: { file: z.string().describe('File inside the requirements folder, e.g. specs/checkout.docx') },
      readOnly: true,
      run: async ({ file }: { file: string }) => {
        const project = load();
        const { text } = await documentText(project, resolveRequirementFile(project, file, true));
        const reqs = requirementsFromFile(project, file);
        return [
          `TraceQA currently reads ${reqs.length} requirement(s) from ${file}: ${reqs.map((r) => `${r.id} (${r.criteria.length} criteria)`).join(', ') || 'none'}.`,
          '--- document text ---',
          text.length > 100_000 ? `${text.slice(0, 100_000)}\n… (cut at 100,000 characters)` : text,
        ].join('\n');
      },
    },
    {
      name: 'save_document_reading',
      title: 'Save how a document reads',
      description:
        "Saves the requirements you read from a requirement document (any format) when TraceQA's automatic reading missed things. Use the document's own words; give an id only if the document has one. Kept until the document changes.",
      inputSchema: {
        file: z.string().describe('File inside the requirements folder'),
        requirements: z
          .array(
            z.object({
              id: z.string().optional().describe('Only if the document gives one, e.g. FR-12'),
              feature: z.string().optional(),
              title: z.string(),
              description: z.string().optional(),
              criteria: z.array(z.string()).describe('Observable outcomes a browser test can check'),
            }),
          )
          .min(1),
      },
      run: async ({ file, requirements }: { file: string; requirements: { id?: string; feature?: string; title: string; description?: string; criteria: string[] }[] }) => {
        const project = load();
        await saveReading(project, file, requirements, 'AI coding tool');
        await importRequirements(project);
        const reqs = requirementsFromFile(project, file);
        return `Saved. ${file} now reads as ${reqs.length} requirement(s): ${reqs.map((r) => `${r.id} ${r.title}`).join('; ')}. Call map_requirements next.`;
      },
    },
    {
      name: 'import_jira_requirements',
      title: 'Import requirements from Jira',
      description: 'Reads Jira issues (default: open stories of the configured project) into requirements/jira/<project>.md, with the Jira key as the requirement ID and acceptance criteria from the description or a custom field, then imports them.',
      inputSchema: {
        jql: z.string().optional().describe('Jira query; default from the config, e.g. project = SHOP AND issuetype = Story'),
        max: z.number().int().positive().max(1000).optional().describe('At most this many issues (default 200)'),
      },
      run: async ({ jql, max }: { jql?: string; max?: number }) => {
        const r = await importJiraRequirements(load(), { jql, max, log });
        return `Imported ${r.issues} Jira issue(s) into requirements/${r.file} (${r.withCriteria} with acceptance criteria): ${r.keys.slice(0, 30).join(', ')}${r.keys.length > 30 ? ' …' : ''}\nJQL: ${r.jql}\nCall map_requirements next. Issues without criteria show as unclear until someone adds them in Jira.`;
      },
    },
    {
      name: 'clarify_requirement',
      title: 'Clarify a requirement',
      description: 'Saves a clearer, testable wording for one acceptance criterion, as agreed with the user. The source file is not changed; suggest the user updates it too.',
      inputSchema: { requirementId: z.string(), acId: z.string().describe('e.g. AC1'), text: z.string().describe('New testable wording') },
      humanOnly: true,
      run: ({ requirementId, acId, text }: { requirementId: string; acId: string; text: string }) => {
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
        const name = (id: string) => map.pages.find((p) => p.id === id)?.templatePath ?? id;
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
      run: ({ requirementId }: { requirementId: string }) => {
        const project = load();
        const id = requirementId.toUpperCase();
        const req = loadRequirements(project).find((r) => r.id === id);
        if (!req) throw new Error(`Unknown requirement ${requirementId}.`);
        const cov = computeCoverage(project).find((c) => c.requirementId === id)!;
        const map = loadAppMap(project);
        const link = loadTraceability(project).links.find((l) => l.requirementId === id);
        const tests = loadTests(project).filter((t) => t.requirementId === id);
        return [
          `${req.id} · ${req.title} (${req.feature})`,
          `Source: ${req.source.file}${req.source.line ? `:${req.source.line}` : ''}${req.source.section ? ` (${req.source.section})` : ''}${req.autoId ? ' · ID assigned by TraceQA' : ''}`,
          req.description ? `Description: ${req.description}` : '',
          `Status: ${cov.status} · ${cov.tests} tests`,
          'Criteria:',
          ...req.criteria.map((c) => {
            const cc = cov.criteria.find((x) => x.acId === c.id)!;
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
      run: ({ pageId, path: p }: { pageId?: string; path?: string }) => {
        const map = loadAppMap(load());
        if (!pageId && !p) return map.pages.map((x) => `- ${x.id}: ${x.templatePath} · ${x.className} · ${x.name} · ${x.elements.length} elements (${x.source})`).join('\n') || 'The app map is empty. Run analyze_app.';
        const page = map.pages.find((x) => x.id === pageId) ?? map.pages.find((x) => x.templatePath === p || x.path === p);
        if (!page) throw new Error(`No page ${pageId ?? p}. Known: ${map.pages.map((x) => x.id).join(', ')}`);
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
      run: async (a: { charter: string; requirementId?: string; startPath?: string; signIn?: boolean; headed?: boolean }) => {
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
      run: (a: Parameters<ExploreSession['act']>[0]) => active().act(a),
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
      run: async (a: Parameters<ExploreSession['recordFinding']>[0]) => {
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
      name: 'save_discovered_flow',
      title: 'Save a discovered flow',
      description:
        'While exploring without a requirement: records a user flow that works today as an E2E requirement (E2E-001 …) in requirements/discovered-flows.md, so you can save_test for it. Criteria describe exactly what the user sees. A person should confirm it is the intended behaviour.',
      inputSchema: {
        title: z.string().describe('The flow, e.g. "Search finds a product by part of its name"'),
        description: z.string().optional().describe('One sentence: who does what'),
        criteria: z.array(z.string()).min(1).max(10).describe('Observable outcomes, e.g. "Searching for \\"head\\" lists Wireless Headphones"'),
      },
      run: async (a: { title: string; description?: string; criteria: string[] }) => {
        const req = await addDiscoveredFlow(load(), a);
        return `Saved ${req.id} "${req.title}" with ${req.criteria.length} criteria (${req.criteria.map((c) => c.id).join(', ')}). Now save_test once per criterion with requirementId ${req.id}.`;
      },
    },
    {
      name: 'scaffold_framework',
      title: 'Create the Playwright framework',
      description: 'Creates (or refreshes) the plain Playwright project: config, fixtures, page objects from the app map, and spec files from saved tests. Installs @playwright/test unless install is false.',
      inputSchema: { install: z.boolean().optional() },
      run: async ({ install }: { install?: boolean }) => {
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
      description:
        'Saves one test for an acceptance criterion as structured steps; TraceQA renders consistent Playwright code (page objects where the locator is in the app map) and, by default, runs it once. Saving the same requirement + criterion + title again replaces it.',
      inputSchema: {
        requirementId: z.string(),
        acId: z.string().optional().describe('Acceptance criterion this test proves, e.g. AC3'),
        title: z.string().describe('Short behaviour, e.g. "codes are not case-sensitive"'),
        signedIn: z.boolean().optional().describe('Sign in with the test account before the steps'),
        steps: z.array(StepSchema).min(1),
        verify: z.boolean().optional().describe('Run the test right after saving (default true)'),
      },
      run: async (a: { requirementId: string; acId?: string; title: string; signedIn?: boolean; steps: z.infer<typeof StepSchema>[]; verify?: boolean }) => {
        const project = load();
        const { def, file, warnings } = saveTest(project, a);
        const lines = [`Saved ${def.id} in ${rel(project.dir, file)}.`, ...warnings.map((w) => `Warning: ${w}`)];
        if (a.verify === false) return lines.join('\n');
        if (!hasInstalledDeps(project)) {
          lines.push('Not run: the framework is not installed yet (scaffold_framework).');
          return lines.join('\n');
        }
        const run = await runTests(project, { testId: def.id, retries: 0, draftBugs: false, record: false, signal });
        if (!run.results.length) lines.push(`Check run found no matching test. Output:\n${run.output.split('\n').slice(-8).join('\n')}`);
        for (const r of run.results) {
          if (r.status === 'passed') lines.push(`Check run: PASSED (${r.project}).`);
          else {
            lines.push(`Check run: ${r.status.toUpperCase()} (${r.project}) · verdict ${r.verdict}`);
            if (r.error) lines.push(r.error.split('\n').slice(0, 8).join('\n'));
            if (r.verdict === 'app-bug') lines.push('The assertion failed. If the app is wrong (not the test), keep the test as it is: run_tests will draft a bug.');
            if (r.verdict === 'test-broken') lines.push('The test could not find or use an element. Check the locators with get_page or an exploration snapshot, then save_test again.');
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
      run: ({ requirementId }: { requirementId?: string }) => {
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
      run: ({ testId }: { testId: string }) => `Removed ${removeTest(load(), testId).id}.`,
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
      run: async (a: { requirementId?: string; testId?: string; grep?: string; browser?: string }) => formatRun(await runTests(load(), { ...a, signal, log })),
    },
    {
      name: 'heal_tests',
      title: 'Heal broken tests',
      description:
        'Repairs tests whose latest result is "test-broken" (an action could not find its element, usually after a UI change). Replays each test, swaps the broken locator for the closest match on the live page, re-runs it, and restores the original if that does not help. Assertions are never changed.',
      inputSchema: {
        testIds: z.array(z.string()).optional().describe('Only these tests (default: every test-broken failure in the latest results)'),
        dryRun: z.boolean().optional().describe('Only propose fixes, do not change tests'),
      },
      run: async ({ testIds, dryRun }: { testIds?: string[]; dryRun?: boolean }) => formatHeals(await healTests(load(), { testIds, apply: !dryRun, signal, log })),
    },
    {
      name: 'review_heal',
      title: 'Apply or reject a proposed heal',
      description: 'Only when the user asks. Applies a heal proposed by a dry run (swaps the locators in, re-runs the test, restores the original if it still breaks), or rejects it.',
      inputSchema: { healId: z.string().describe('e.g. HEAL-004'), decision: z.enum(['apply', 'reject']) },
      humanOnly: true,
      run: async ({ healId, decision }: { healId: string; decision: 'apply' | 'reject' }) => formatHeals({ records: [await reviewHeal(load(), healId, decision, { signal })], candidates: 1 }),
    },
    {
      name: 'list_bugs',
      title: 'List bugs',
      description: 'Lists bugs drafted from explorations and test runs.',
      inputSchema: { status: z.enum(['draft', 'approved', 'filed', 'discarded']).optional() },
      readOnly: true,
      run: ({ status }: { status?: 'draft' | 'approved' | 'filed' | 'discarded' }) =>
        listBugs(load(), status)
          .map((b) => `- ${b.id} [${b.status} · ${b.severity}] ${b.title}${b.requirementId ? ` (${b.requirementId}${b.acId ? ` ${b.acId}` : ''})` : ''}${b.ticket ? ` → ${b.ticket.key}` : ''}`)
          .join('\n') || 'No bugs.',
    },
    {
      name: 'get_bug',
      title: 'Get a bug',
      description: 'Shows one bug as a ticket-ready report.',
      inputSchema: { bugId: z.string() },
      readOnly: true,
      run: ({ bugId }: { bugId: string }) => {
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
      run: ({ bugId, status, note }: { bugId: string; status: 'approved' | 'discarded'; note?: string }) => {
        const project = load();
        const r = setBugStatus(project, bugId, status, note);
        return `${r.bug.id} is now ${r.bug.status}.${r.exported ? ` Ticket text: ${rel(project.dir, r.exported)}` : ''}`;
      },
    },
    {
      name: 'file_bug',
      title: 'File a bug in Jira',
      description:
        'Only when the user explicitly asks to file this bug. Creates a Jira issue with steps, expected/actual and evidence attached; if an open issue already exists for the same requirement criterion, comments on it instead of creating a duplicate.',
      inputSchema: { bugId: z.string() },
      humanOnly: true,
      run: async ({ bugId }: { bugId: string }) => {
        const r = await fileBugInJira(load(), bugId);
        const t = r.bug.ticket!;
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
export function toJsonSchema(tool: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(tool.inputSchema), { io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
