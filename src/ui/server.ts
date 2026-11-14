import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { activeModel, CONFIG_FILE, findProjectDir, loadProject, type Project } from '../core/config.js';
import { listOpenRouterModels } from '../ai/openrouter.js';
import { listLmStudioModels, listOllamaModels } from '../ai/local.js';
import { readDocumentWithAI } from '../ai/read.js';
import { importDocument, MAX_DOCUMENT_BYTES } from '../core/documents.js';
import { loadAppMap } from '../core/appMap.js';
import {
  clarify, deleteReading, EDITABLE_EXTS, fileOrigin, importRequirements, listRequirementFiles, loadRequirements, openIssues, previewRequirements,
  readRequirementFile, resolveRequirementFile, trashRequirementFile, writeRequirementFile,
} from '../core/requirements.js';
import { loadTraceability, mapRequirements } from '../core/mapper.js';
import { describeStep, loadTests, removeTest, renderAll, specFileFor } from '../core/testgen.js';
import { listAllTests, testRanges } from '../core/testlist.js';
import { listRuns } from '../core/runner.js';
import { bugMarkdown, getBug, listBugs, setBugStatus, updateBug, type BugEdit } from '../core/bugs.js';
import { computeCoverage, coverageSummary, latestResults } from '../core/coverage.js';
import { projectStatus } from '../core/status.js';
import { formatHeals, healTests, listHeals, reviewHeal } from '../core/heal.js';
import { fileBugInJira } from '../core/jira.js';
import { hasInstalledDeps } from '../core/scaffold.js';
import { initProject } from '../core/init.js';
import { aiKeyStatus, getSettings, saveSettings } from '../core/settings.js';
import { ExploreSession } from '../core/explorer.js';
import { rel } from '../core/store.js';
import { buildTools } from '../tools/registry.js';
import { AUTOMATE_TOOLS, EXPLORE_TOOLS, generateTargets, parseMaxFlows, runAgent, tasks } from '../ai/agent.js';
import { ProgressTracker, type ProgressPlan } from '../ai/progress.js';
import { StoppedError } from '../core/proc.js';
import { formatUsage } from '../ai/pricing.js';
import { JobManager, summarize, type JobContext, type JobRecord } from './jobs.js';

// Local dashboard: a JSON API over the project's files plus one HTML page. Everything the CLI can do
// (except starting the MCP server) can be done here. Binds to 127.0.0.1 only; requests must carry a
// local Host header, and changes need the X-TraceQA header and a same-origin Origin.

const VERSION = '0.5.0';

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webm': 'video/webm', '.zip': 'application/zip',
  '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.ts': 'text/plain; charset=utf-8', '.xml': 'text/plain; charset=utf-8',
};

const AI_KINDS = new Set(['explore', 'explore-app', 'generate', 'agent', 'heal-ai', 'read-doc']);

function uiFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'ui', 'index.html');
}

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

export async function startDashboard(
  projectDir: string | undefined,
  opts: { port?: number } = {},
): Promise<{ url: string; port: number; dir: string; close: () => void }> {
  // Without a traceqa.config.json the dashboard starts in setup mode for this folder.
  const rootDir = findProjectDir(projectDir) ?? path.resolve(projectDir ?? process.cwd());
  const isReady = () => fs.existsSync(path.join(rootDir, CONFIG_FILE));
  const load = (): Project => {
    if (!isReady()) throw httpError(409, 'This folder is not set up for TraceQA yet.');
    return loadProject(rootDir);
  };

  let port = opts.port ?? 4400;
  let localHosts = new Set<string>();
  let localOrigins = new Set<string>();

  const clients = new Set<http.ServerResponse>();
  const broadcast = (event: string, data: unknown) => {
    for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const jobs = new JobManager(() => (isReady() ? path.join(rootDir, '.traceqa', 'jobs') : undefined), broadcast);

  // Tell open pages when project files change (runs, bugs, sessions, requirements …). Job logs stream separately.
  let watcher: fs.FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  const ensureWatcher = () => {
    if (watcher || !isReady()) return;
    const state = path.join(rootDir, '.traceqa');
    fs.mkdirSync(state, { recursive: true });
    watcher = fs.watch(state, { recursive: true }, (_e, name) => {
      if (name && /^(jobs|trash)[\\/]/.test(String(name))) return;
      clearTimeout(timer);
      timer = setTimeout(() => broadcast('change', {}), 400);
    });
  };
  ensureWatcher();

  // Live exploration: the AI job that is exploring gets the session id, and pages get each new step.
  let liveJob: JobContext | undefined;
  let liveTracker: ProgressTracker | undefined;
  const previousHook = ExploreSession.onEvent;
  ExploreSession.onEvent = (type, s) => {
    if (type === 'start') liveJob?.setSession(s.id);
    liveTracker?.session(s);
    broadcast('session', { type, id: s.id, steps: s.steps.length });
  };

  let orModels: { base: string; at: number; models: Awaited<ReturnType<typeof listOpenRouterModels>> } | undefined;

  const fileUrl = (project: Project, abs: string) => `/files/${rel(project.dir, abs).split('/').map(encodeURIComponent).join('/')}`;

  // ---------- jobs ----------

  async function runTool(name: string, args: Record<string, unknown>, ctx: JobContext): Promise<string> {
    const tool = buildTools(rootDir, { signal: ctx.signal, log: ctx.log }).find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    return String(await tool.run(z.object(tool.inputSchema).parse(args)));
  }

  /** Runs the AI agent for a job, with live progress (phase, current action, counts, timeline). */
  async function aiWork(ctx: JobContext, task: string, allowTools: string[] | undefined, plan: ProgressPlan, flowTarget?: number | null): Promise<string> {
    const project = load();
    const tracker = new ProgressTracker(plan, ctx.setProgress, { flowTarget, resolveRef: (ref) => ExploreSession.active?.refLabel(ref) });
    liveJob = ctx;
    liveTracker = tracker;
    try {
      const am = activeModel(project.config.ai);
      ctx.log(`AI agent (${am.label}${am.local ? ", on this computer" : `, effort ${project.config.ai.effort}`}, up to ${project.config.ai.maxTurns} turns) working …`);
      const r = await runAgent(project, { task, allowTools, log: ctx.log, signal: ctx.signal, onUsage: ctx.setUsage, onEvent: tracker.handle });
      ctx.setUsage(r.usage);
      const tail = `${r.turns} turns · ${r.toolCalls} tool calls · ${formatUsage(r.usage)}`;
      if (r.stopReason === 'refusal') throw new Error(`The model declined this request.\n${r.finalText}\n${tail}`);
      if (r.stopReason === 'max_turns') throw new Error(`${r.finalText}\n${tail}`);
      tracker.finish('done');
      return `${r.finalText}\n\n${tail}`;
    } catch (err) {
      tracker.finish(err instanceof StoppedError || ctx.signal.aborted ? 'stopped' : 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      liveJob = undefined;
      liveTracker = undefined;
    }
  }

  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

  /** True while an "apply heal" job for this heal is queued or running. */
  const healInProgress = (healId: string) =>
    jobs.list().some((j) => j.kind === 'review-heal' && (j.status === 'queued' || j.status === 'running') && String(j.params?.healId ?? '').toUpperCase() === healId.toUpperCase());

  function startJob(body: Record<string, unknown>): JobRecord {
    const kind = String(body.kind ?? '');
    const project = load();
    // AI jobs on a paid provider need an explicit confirm; local models (Ollama, LM Studio) cost nothing.
    if ((AI_KINDS.has(kind) || (kind === 'heal' && body.ai === true)) && !activeModel(project.config.ai).local && body.confirmed !== true) {
      throw httpError(400, `AI jobs are billed to your ${activeModel(project.config.ai).providerLabel} account; confirm them first.`);
    }
    const params = { ...body };
    delete params.confirmed;
    switch (kind) {
      case 'run': {
        const args = { requirementId: str(body.requirementId), testId: str(body.testId), grep: str(body.grep), browser: str(body.browser) };
        if (args.browser && !project.config.browsers.includes(args.browser as never)) throw httpError(400, `${args.browser} is not one of the configured browsers.`);
        const label = args.testId ? `Run test ${args.testId}` : args.requirementId ? `Run ${args.requirementId} tests` : args.grep ? (str(body.title) ? `Run "${str(body.title)}"` : `Run tests matching "${args.grep}"`) : 'Run all tests';
        return jobs.enqueue('run', `${label}${args.browser ? ` (${args.browser})` : ''}`, { params }, (ctx) => runTool('run_tests', args, ctx));
      }
      case 'heal': {
        const dryRun = body.dryRun === true;
        const ai = body.ai === true && !dryRun;
        return jobs.enqueue('heal', dryRun ? 'Preview heals for broken tests' : ai ? 'Heal broken tests (AI for the rest)' : 'Heal broken tests', { ai, params }, async (ctx) => {
          const p = load();
          if (!latestResults(p).length) {
            ctx.log('No test results yet; running the tests first …');
            ctx.log(await runTool('run_tests', {}, ctx));
          }
          const result = await healTests(p, { apply: !dryRun, log: ctx.log, signal: ctx.signal });
          const out = formatHeals(result);
          const left = result.records.filter((r) => r.status === 'failed').map((r) => r.testId);
          if (!ai || !left.length) return out + (left.length ? `\n${left.length} test(s) need a person or the AI agent.` : '');
          ctx.log(out);
          return aiWork(ctx, tasks.heal(left), undefined, 'heal');
        });
      }
      case 'review-heal': {
        const healId = str(body.healId);
        if (!healId) throw httpError(400, 'healId is required.');
        if (healInProgress(healId)) throw httpError(409, `${healId.toUpperCase()} is already being applied.`);
        return jobs.enqueue('review-heal', `Apply ${healId.toUpperCase()}`, { params }, (ctx) => runTool('review_heal', { healId, decision: 'apply' }, ctx));
      }
      case 'analyze': {
        const maxPages = typeof body.maxPages === 'number' ? body.maxPages : undefined;
        return jobs.enqueue('analyze', 'Analyze the app', { params }, (ctx) => runTool('analyze_app', maxPages ? { maxPages } : {}, ctx));
      }
      case 'scaffold':
        return jobs.enqueue('scaffold', hasInstalledDeps(project) ? 'Refresh the Playwright framework' : 'Create the Playwright framework', { params }, (ctx) =>
          runTool('scaffold_framework', { install: body.install !== false }, ctx),
        );
      case 'report':
        return jobs.enqueue('report', 'Build the coverage report', { params }, (ctx) => runTool('report', {}, ctx));
      case 'explore': {
        const id = str(body.requirementId)?.toUpperCase();
        if (!id || !loadRequirements(project).some((r) => r.id === id)) throw httpError(400, `Unknown requirement ${id ?? ''}.`);
        const task = tasks.explore(id, str(body.charter)) + (body.headed === true ? ' Call explore_start with headed: true so the user can watch.' : '');
        return jobs.enqueue('explore', `Explore ${id} with AI`, { ai: true, params }, (ctx) => aiWork(ctx, task, EXPLORE_TOOLS, 'explore'));
      }
      case 'generate': {
        const ids = generateTargets(project, {
          ids: Array.isArray(body.requirementIds) ? body.requirementIds.map(String) : undefined,
          gaps: body.gaps === true,
          all: body.all === true,
        });
        const label = body.all === true ? 'Write tests for every requirement' : body.gaps === true ? `Write tests for ${ids.length} gap(s)` : `Write tests for ${ids.join(', ')}`;
        return jobs.enqueue('generate', label, { ai: true, params: { ...params, resolved: ids } }, (ctx) => aiWork(ctx, tasks.generate(ids), undefined, 'generate'));
      }
      case 'agent': {
        const task = str(body.task);
        if (!task) throw httpError(400, 'Describe the task for the agent.');
        if (task.length > 4000) throw httpError(400, 'Keep the task under 4000 characters.');
        return jobs.enqueue('agent', `AI task: ${task.length > 60 ? `${task.slice(0, 59)}…` : task}`, { ai: true, params }, (ctx) => aiWork(ctx, task, undefined, 'agent'));
      }
      case 'explore-app': {
        const area = str(body.area);
        if (area && !area.startsWith('/')) throw httpError(400, 'The area is a path in the app, such as /cart.');
        const writeTests = body.writeTests === true;
        // Empty means no limit: every working flow the exploration finds.
        const maxFlows = writeTests ? parseMaxFlows(body.maxFlows) : undefined;
        const task = tasks.exploreApp({ area, charter: str(body.charter), signIn: body.signIn === true, headed: body.headed === true, writeTests, maxFlows });
        const where = area && area !== '/' ? ` from ${area}` : '';
        const label = writeTests ? `Explore the app${where} and automate ${maxFlows ? `up to ${maxFlows} flow${maxFlows === 1 ? '' : 's'}` : 'every flow found'}` : `Explore the app${where}`;
        return jobs.enqueue('explore-app', label, { ai: true, params }, (ctx) =>
          aiWork(ctx, task, writeTests ? AUTOMATE_TOOLS : EXPLORE_TOOLS, writeTests ? 'explore-app-automate' : 'explore-app', writeTests ? (maxFlows ?? null) : undefined),
        );
      }
      case 'read-doc': {
        const file = str(body.file);
        if (!file) throw httpError(400, 'file is required.');
        if (!fs.existsSync(resolveRequirementFile(project, file, true))) throw httpError(404, `No requirement document ${file}.`);
        return jobs.enqueue('read-doc', `Read ${file} with AI`, { ai: true, params }, async (ctx) => {
          const p = load();
          liveJob = ctx;
          try {
            const r = await readDocumentWithAI(p, file, { signal: ctx.signal, log: ctx.log });
            ctx.setUsage(r.usage);
            return `Read ${r.file}: ${r.requirements} requirement(s) with ${r.criteria} acceptance criteria (${r.ids.join(', ')}).${r.truncated ? ' Only the first part of a long document was read.' : ''} The document itself is unchanged. · ${formatUsage(r.usage)}`;
          } finally {
            liveJob = undefined;
          }
        });
      }
      case 'jira-import': {
        if (!project.config.jira) throw httpError(400, 'Set up Jira under Settings → Jira first.');
        const jql = str(body.jql);
        const max = typeof body.max === 'number' ? body.max : undefined;
        return jobs.enqueue('jira-import', 'Import requirements from Jira', { params }, async (ctx) => {
          const out = await runTool('import_jira_requirements', { ...(jql ? { jql } : {}), ...(max ? { max } : {}) }, ctx);
          const p = load();
          if (loadAppMap(p).pages.length) mapRequirements(p);
          return out;
        });
      }
      default:
        throw httpError(400, `Unknown job kind "${kind}".`);
    }
  }

  // ---------- read models ----------

  function state() {
    if (!isReady()) return { ready: false, dir: rootDir, version: VERSION };
    const project = load();
    const all = jobs.list();
    const aiJobs = all.filter((j) => j.ai && j.usage && j.status !== 'queued').slice(0, 5);
    return {
      // Small numbers for the navigation badges.
      counts: {
        draftBugs: listBugs(project, 'draft').length,
        proposedHeals: listHeals(project).filter((h) => h.status === 'proposed').length,
        unclearRequirements: loadRequirements(project).filter((r) => openIssues(r).some((i) => i.kind === 'vague' || i.kind === 'no-criteria')).length,
        activeJobs: all.filter((j) => j.status === 'running' || j.status === 'queued').length,
      },
      ready: true,
      dir: rootDir,
      version: VERSION,
      project: path.basename(project.dir),
      baseUrl: project.config.baseUrl,
      browsers: project.config.browsers,
      jiraConfigured: !!project.config.jira,
      authConfigured: !!project.config.auth,
      ai: {
        ...aiKeyStatus(project),
        provider: project.config.ai.provider,
        providerLabel: activeModel(project.config.ai).providerLabel,
        model: activeModel(project.config.ai).model,
        effort: project.config.ai.effort,
        maxTurns: project.config.ai.maxTurns,
        recent: aiJobs.map((j) => ({ id: j.id, label: j.label, status: j.status, usage: j.usage })),
      },
      busy: jobs.busy(),
    };
  }

  function overview(project: Project) {
    const rows = computeCoverage(project);
    const reqs = loadRequirements(project);
    const map = loadAppMap(project);
    const trace = loadTraceability(project);
    const runs = listRuns(project);
    const run = runs[runs.length - 1];
    const bugs = listBugs(project);
    const tests = loadTests(project);
    const heals = listHeals(project);
    const unclear = reqs.filter((r) => openIssues(r).some((i) => i.kind === 'vague' || i.kind === 'no-criteria'));
    const broken = latestResults(project).filter((r) => r.status === 'failed' && r.verdict === 'test-broken');
    const proposed = heals.filter((h) => h.status === 'proposed');
    const features = new Map<string, { feature: string; total: number; counts: Record<string, number> }>();
    for (const r of rows) {
      const f = features.get(r.feature) ?? { feature: r.feature, total: 0, counts: {} };
      f.total++;
      f.counts[r.status] = (f.counts[r.status] ?? 0) + 1;
      features.set(r.feature, f);
    }
    const attention: { text: string; detail: string; link: string }[] = [];
    const drafts = bugs.filter((b) => b.status === 'draft');
    if (drafts.length) attention.push({ text: `${drafts.length} draft bug(s) need review`, detail: drafts.map((b) => b.id).join(', '), link: '#/bugs' });
    if (unclear.length) attention.push({ text: `${unclear.length} requirement(s) are unclear`, detail: unclear.map((r) => r.id).join(', '), link: '#/requirements' });
    if (broken.length) attention.push({ text: `${broken.length} test(s) broke after a UI change`, detail: 'Use "Heal…" on Runs & heals', link: '#/runs' });
    if (proposed.length) attention.push({ text: `${proposed.length} proposed heal(s) to review`, detail: proposed.map((h) => h.id).join(', '), link: '#/runs' });
    if (trace.pagesWithoutRequirements.length) attention.push({ text: `${trace.pagesWithoutRequirements.length} page(s) have no requirement`, detail: trace.pagesWithoutRequirements.join(', '), link: '#/appmap' });
    const flaky = run?.results.filter((r) => r.status === 'flaky') ?? [];
    if (flaky.length) attention.push({ text: `${flaky.length} flaky test(s)`, detail: 'Passed only on retry', link: '#/runs' });
    const installed = hasInstalledDeps(project);
    return {
      project: path.basename(project.dir),
      baseUrl: project.config.baseUrl,
      status: projectStatus(project),
      summary: coverageSummary(rows),
      features: [...features.values()],
      kpis: {
        tests: tests.length,
        requirementsWithTests: new Set(tests.map((t) => t.requirementId)).size,
        lastRun: run ? { id: run.id, ...run.totals, startedAt: run.startedAt } : null,
        openBugs: bugs.filter((b) => b.status !== 'discarded').length,
        drafts: drafts.length,
        filed: bugs.filter((b) => b.status === 'filed').length,
      },
      pipeline: [
        { key: 'analyze', step: 'Analyze app', done: map.pages.length > 0, detail: `${map.pages.length} pages` },
        { key: 'requirements', step: 'Requirements', done: reqs.length > 0, detail: `${reqs.length} imported · ${unclear.length} unclear` },
        { key: 'map', step: 'Map', done: !!trace.mappedAt, detail: trace.mappedAt ? `${trace.links.filter((l) => l.pages.length).length} mapped` : 'not done' },
        { key: 'framework', step: 'Framework', done: installed, detail: installed ? 'installed' : 'not created' },
        { key: 'tests', step: 'Tests', done: tests.length > 0, detail: `${tests.length} tests` },
        { key: 'run', step: 'Run & heal', done: !!run, detail: run ? `${run.id} · ${heals.filter((h) => h.status === 'applied').length} healed` : 'no run yet' },
        { key: 'bugs', step: 'Bugs', done: drafts.length === 0 && bugs.length > 0, detail: `${drafts.length} drafts · ${bugs.filter((b) => b.status === 'filed').length} filed` },
      ],
      attention,
      jobs: jobs.list().slice(0, 5),
    };
  }

  function requirementDetail(project: Project, id: string) {
    const req = loadRequirements(project).find((r) => r.id === id.toUpperCase());
    if (!req) throw httpError(404, `Unknown requirement ${id}`);
    const cov = computeCoverage(project).find((c) => c.requirementId === req.id)!;
    const map = loadAppMap(project);
    const link = loadTraceability(project).links.find((l) => l.requirementId === req.id);
    const spec = specFileFor(project, req);
    const reqRoot = rel(project.dir, project.paths.requirementsDir);
    const sourceFile = req.source.file.startsWith(`${reqRoot}/`) ? req.source.file.slice(reqRoot.length + 1) : req.source.file;
    const fromJira = sourceFile.startsWith('jira/') && project.config.jira;
    return {
      requirement: req,
      sourceFile,
      origin: EDITABLE_EXTS.includes(path.extname(sourceFile).toLowerCase()) && fs.existsSync(path.join(project.paths.requirementsDir, sourceFile)) ? fileOrigin(sourceFile, fs.readFileSync(path.join(project.paths.requirementsDir, sourceFile), 'utf8').slice(0, 300)).origin : 'written',
      jiraUrl: fromJira ? `${project.config.jira!.baseUrl.replace(/\/+$/, '')}/browse/${req.id}` : null,
      coverage: cov,
      pages: (link?.pages ?? []).map((p) => ({ ...p, page: map.pages.find((x) => x.id === p.pageId)?.templatePath })),
      tests: loadTests(project)
        .filter((t) => t.requirementId === req.id)
        .map((t) => ({ id: t.id, acId: t.acId, title: t.title, signedIn: t.signedIn, last: t.lastVerification, steps: t.steps.map(describeStep) })),
      bugs: listBugs(project).filter((b) => b.requirementId === req.id),
      specFile: fs.existsSync(spec) ? rel(project.dir, spec) : null,
    };
  }

  function sessions(project: Project) {
    const shot = (p?: string) => (p && fs.existsSync(p) ? fileUrl(project, p) : null);
    const withUrls = <S extends { id: string; steps: { screenshot?: string }[]; findings: { screenshot?: string }[] }>(s: S) => ({
      ...s,
      steps: s.steps.map((st) => ({ ...st, screenshot: shot(st.screenshot) })),
      findings: s.findings.map((fd) => ({ ...fd, screenshot: shot(fd.screenshot) })),
    });
    const saved = fs.existsSync(project.paths.sessions)
      ? fs
          .readdirSync(project.paths.sessions)
          .map((id) => path.join(project.paths.sessions, id, 'session.json'))
          .filter((f) => fs.existsSync(f))
          .map((f) => withUrls(JSON.parse(fs.readFileSync(f, 'utf8'))))
          .reverse()
      : [];
    const active = ExploreSession.active;
    if (active && active.project.dir === project.dir) return [{ ...withUrls(active.summary()), live: true }, ...saved.filter((s) => s.id !== active.id)];
    return saved;
  }

  /**
   * Tests two ways: grouped by requirement (every test linked to one, whoever wrote it), and one flat list of
   * every test in the framework, including hand-written tests that are not linked to any requirement.
   */
  function testsView(project: Project) {
    const reqs = loadRequirements(project);
    const defs = new Map(loadTests(project).map((t) => [t.id, t]));
    const all = listAllTests(project);
    return {
      framework: rel(project.dir, project.paths.e2e),
      installed: hasInstalledDeps(project),
      exists: fs.existsSync(path.join(project.paths.e2e, 'playwright.config.ts')),
      all,
      unlinked: all.filter((t) => !t.linked).length,
      handWritten: all.filter((t) => t.source === 'hand-written').length,
      groups: reqs
        .map((r) => ({
          requirementId: r.id,
          title: r.title,
          feature: r.feature,
          tests: all
            .filter((t) => t.linked && t.requirementId === r.id)
            .map((t) => {
              const def = t.id ? defs.get(t.id) : undefined;
              return {
                ...t,
                // The title without the criterion prefix; the criterion is shown as a tag.
                title: def ? def.title : t.title,
                last: def?.lastVerification,
                updatedAt: def?.updatedAt,
                latest: t.latest ?? null,
              };
            }),
        }))
        .filter((g) => g.tests.length),
    };
  }

  async function reimport(project: Project) {
    const r = await importRequirements(project);
    let mapped = false;
    if (loadAppMap(project).pages.length) {
      mapRequirements(project);
      mapped = true;
    }
    return { imported: r.file.requirements.length, files: r.files.length, duplicates: r.duplicates, mapped, documents: r.documents };
  }

  // ---------- HTTP ----------

  const baseHeaders = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' };
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw httpError(413, `Files are limited to ${Math.round(limit / 1024 / 1024)} MB.`);
      chunks.push(chunk);
    }
    if (!size) throw httpError(400, 'The file is empty.');
    return Buffer.concat(chunks);
  }

  async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 700_000) throw httpError(413, 'Request body too large');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      throw httpError(400, 'Body must be JSON.');
    }
  }

  async function handleGet(parts: string[], url: URL, res: http.ServerResponse, req: http.IncomingMessage) {
    if (parts[1] === 'state') return send(res, 200, state());
    const project = load();
    switch (parts[1]) {
      case 'overview':
        return send(res, 200, overview(project));
      case 'requirements':
        if (parts[2]) return send(res, 200, requirementDetail(project, parts[2]));
        return send(res, 200, {
          rows: computeCoverage(project).map((c) => {
            const r = loadRequirements(project).find((x) => x.id === c.requirementId)!;
            return { ...c, issues: openIssues(r), source: r.source };
          }),
        });
      case 'requirement-files':
        if (parts[2] === 'content') {
          const file = url.searchParams.get('file') ?? '';
          const abs = resolveRequirementFile(project, file, true);
          if (!fs.existsSync(abs)) throw httpError(404, `No requirement document ${file}.`);
          const doc = listRequirementFiles(project).find((d) => d.file === file);
          const reqs = loadRequirements(project).filter((r) => path.resolve(project.dir, r.source.file) === abs);
          if (!EDITABLE_EXTS.includes(path.extname(file).toLowerCase())) return send(res, 200, { file, binary: true, document: doc, requirements: reqs });
          const content = fs.readFileSync(abs, 'utf8');
          return send(res, 200, { file, content, ...fileOrigin(file, content), document: doc, requirements: reqs });
        }
        return send(res, 200, { dir: rel(project.dir, project.paths.requirementsDir), files: listRequirementFiles(project) });
      case 'appmap': {
        const map = loadAppMap(project);
        const t = loadTraceability(project);
        return send(res, 200, {
          updatedAt: map.updatedAt,
          pages: map.pages.map(({ textSample: _t, links: _l, ...p }) => ({ ...p, requirements: t.links.filter((l) => l.pages.some((x) => x.pageId === p.id)).map((l) => l.requirementId) })),
          pagesWithoutRequirements: t.pagesWithoutRequirements,
          unmappedRequirements: t.unmappedRequirements,
        });
      }
      case 'tests':
        return send(res, 200, testsView(project));
      case 'spec': {
        const r = loadRequirements(project).find((x) => x.id === (url.searchParams.get('req') ?? '').toUpperCase());
        if (!r) return send(res, 404, { error: 'Unknown requirement' });
        const file = specFileFor(project, r);
        const code = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        return send(res, 200, { file: rel(project.dir, file), code, tests: code ? testRanges(code, loadTests(project).filter((t) => t.requirementId === r.id)) : [] });
      }
      case 'runs': {
        const runs = listRuns(project);
        if (parts[2]) {
          const run = runs.find((r) => r.id === parts[2]);
          if (!run) return send(res, 404, { error: 'Unknown run' });
          return send(res, 200, { ...run, results: run.results.map((r) => ({ ...r, attachments: r.attachments.filter((a) => fs.existsSync(a.path)).map((a) => ({ name: a.name, url: fileUrl(project, a.path) })) })) });
        }
        const tests = loadTests(project);
        return send(res, 200, {
          runs: runs.map(({ results: _r, ...rest }) => rest).reverse(),
          heals: listHeals(project).reverse().map((h) => {
            const def = tests.find((t) => t.id === h.testId);
            return {
              ...h,
              steps: h.fixes.map((f) => {
                const step = def?.steps[f.stepIndex];
                return { stepIndex: f.stepIndex, now: step ? describeStep(step) : null };
              }),
            };
          }),
          browsers: project.config.browsers,
        });
      }
      case 'bugs': {
        if (parts[2]) {
          const bug = getBug(project, parts[2]);
          return send(res, 200, {
            bug: { ...bug, evidence: bug.evidence.map((e) => ({ name: e.name, url: fs.existsSync(e.path) ? fileUrl(project, e.path) : null, file: path.basename(e.path) })) },
            markdown: bugMarkdown(project, bug),
            jiraConfigured: !!project.config.jira,
          });
        }
        return send(res, 200, { bugs: listBugs(project).reverse() });
      }
      case 'sessions': {
        if (parts[2]) {
          const one = sessions(project).find((s) => s.id === parts[2].toUpperCase());
          return one ? send(res, 200, { session: one }) : send(res, 404, { error: `No session ${parts[2]}` });
        }
        return send(res, 200, { sessions: sessions(project) });
      }
      case 'jobs': {
        if (parts[2]) {
          const job = jobs.get(parts[2]);
          if (!job) return send(res, 404, { error: `No job ${parts[2]}` });
          return send(res, 200, { job: { ...summarize(job), log: job.log, progress: job.progress } });
        }
        return send(res, 200, { jobs: jobs.list() });
      }
      case 'settings':
        return send(res, 200, getSettings(project));
      case 'openrouter-models':
      case 'ai-models': {
        // This makes the server contact another address, so only the dashboard page itself may ask (custom header = no cross-site use).
        if (req.headers['x-traceqa'] !== '1') return send(res, 403, { error: 'Forbidden' });
        // Model pickers. OpenRouter: its public list (no key needed), cached for an hour.
        // Ollama and LM Studio: what is installed on this computer right now (also a connection check).
        const provider = parts[1] === 'openrouter-models' ? 'openrouter' : url.searchParams.get('provider') ?? project.config.ai.provider;
        const ai = project.config.ai;
        const base = url.searchParams.get('baseUrl') || (provider === 'ollama' ? ai.ollama.baseUrl : provider === 'lmstudio' ? ai.lmstudio.baseUrl : ai.openrouter.baseUrl);
        if (!/^https?:\/\//.test(base)) throw httpError(400, 'The address must start with http:// or https://');
        if (provider === 'ollama') return send(res, 200, { provider, models: await listOllamaModels(base) });
        if (provider === 'lmstudio') return send(res, 200, { provider, models: await listLmStudioModels(base, project.env.LMSTUDIO_API_KEY ?? '') });
        if (provider !== 'openrouter') return send(res, 200, { provider, models: [] });
        if (!orModels || orModels.base !== base || Date.now() - orModels.at > 3_600_000) {
          orModels = { base, at: Date.now(), models: await listOpenRouterModels(base) };
        }
        return send(res, 200, { provider, models: orModels.models });
      }
      case 'report': {
        const file = path.join(project.paths.report, 'index.html');
        return send(res, 200, { exists: fs.existsSync(file), url: fs.existsSync(file) ? fileUrl(project, file) : null, updatedAt: fs.existsSync(file) ? fs.statSync(file).mtime.toISOString() : null });
      }
      default:
        return send(res, 404, { error: 'Not found' });
    }
  }

  async function handlePost(parts: string[], body: Record<string, unknown>, res: http.ServerResponse) {
    // Setup works before the project exists.
    if (parts[1] === 'setup') {
      if (isReady()) throw httpError(409, 'This folder is already set up.');
      const baseUrl = str(body.baseUrl);
      let parsed: URL;
      try {
        parsed = new URL(baseUrl ?? '');
      } catch {
        throw httpError(400, 'Enter the full address of the app, e.g. https://staging.example.com');
      }
      if (!/^https?:$/.test(parsed.protocol)) throw httpError(400, 'The app address must start with http:// or https://');
      const r = initProject(rootDir, { url: parsed.toString().replace(/\/$/, ''), agents: body.agents === true });
      let notes: string[] = [];
      const auth = body.auth && typeof body.auth === 'object' ? body.auth : undefined;
      const env = body.env && typeof body.env === 'object' ? (body.env as Record<string, string | null>) : undefined;
      try {
        if (auth || env) notes = saveSettings(rootDir, { config: auth ? { auth } : {}, env }).notes;
      } catch (err) {
        notes.push(`Sign-in details were not saved: ${(err as Error).message}. Add them in Settings.`);
      }
      ensureWatcher();
      broadcast('change', {});
      return send(res, 200, { created: r.created, updated: r.updated, antigravity: body.agents === true ? r.antigravity : undefined, notes });
    }

    const project = load();
    const [, a, b, c] = parts;
    if (a === 'settings') {
      const result = saveSettings(rootDir, {
        config: body.config && typeof body.config === 'object' ? (body.config as Record<string, unknown>) : undefined,
        env: body.env && typeof body.env === 'object' ? (body.env as Record<string, string | null>) : undefined,
      });
      broadcast('change', {});
      return send(res, 200, result);
    }
    if (a === 'connect-ai-tools') {
      const r = initProject(rootDir, { url: project.config.baseUrl, agents: true });
      return send(res, 200, { created: r.created, updated: r.updated, antigravity: r.antigravity });
    }
    if (a === 'jobs' && !b) return send(res, 202, { job: summarize(startJob(body)) });
    if (a === 'jobs' && b && c === 'stop') return send(res, 200, { job: summarize(jobs.stop(b)) });

    if (a === 'requirement-files' && !b) {
      const file = str(body.file) ?? '';
      const previous = str(body.previousFile);
      if (typeof body.content !== 'string') throw httpError(400, 'content is required.');
      // Saving under a new name must not overwrite another file by accident.
      if (previous !== file && fs.existsSync(resolveRequirementFile(project, file))) throw httpError(409, `${file} already exists. Pick another name, or open that file to edit it.`);
      const w = writeRequirementFile(project, file, body.content);
      if (previous && previous !== file) {
        const old = resolveRequirementFile(project, previous);
        if (fs.existsSync(old)) fs.rmSync(old); // renamed: the content now lives in the new file
      }
      return send(res, 200, { ...w, ...(await reimport(project)) });
    }
    if (a === 'requirement-files' && b === 'delete') {
      const trashed = trashRequirementFile(project, str(body.file) ?? '');
      return send(res, 200, { trashed, ...(await reimport(project)) });
    }
    if (a === 'requirement-files' && b === 'forget-reading') {
      // Back to TraceQA's own reading of the document (the AI reading is discarded).
      const file = str(body.file) ?? '';
      resolveRequirementFile(project, file, true);
      deleteReading(project, file);
      return send(res, 200, await reimport(project));
    }
    if (a === 'requirements' && b === 'preview') {
      if (typeof body.content !== 'string') throw httpError(400, 'content is required.');
      return send(res, 200, await previewRequirements(project, body.content, str(body.file) ?? 'new.md'));
    }
    if (a === 'requirements' && b === 'import') return send(res, 200, await reimport(project));
    if (a === 'requirements' && b && c === 'clarify') {
      if (typeof body.acId !== 'string' || typeof body.text !== 'string' || !body.text.trim()) throw httpError(400, 'acId and text are required');
      return send(res, 200, { criterion: clarify(project, b, body.acId, body.text.trim()) });
    }
    if (a === 'map') {
      const t = mapRequirements(project);
      return send(res, 200, { mapped: t.links.filter((l) => l.pages.length).length, unmapped: t.unmappedRequirements, pagesWithoutRequirements: t.pagesWithoutRequirements });
    }
    if (a === 'render') {
      const r = renderAll(project);
      return send(res, 200, { pageObjects: r.pageObjects.length, specs: r.specs.length, removed: r.removed.length });
    }
    if (a === 'tests' && b && c === 'remove') {
      if (jobs.busy()) throw httpError(409, 'Wait for the running job to finish before removing tests.');
      return send(res, 200, { removed: removeTest(project, b).id });
    }
    if (a === 'heals' && b && c === 'reject') {
      if (healInProgress(b)) throw httpError(409, `${b.toUpperCase()} is being applied right now; wait for that job to finish.`);
      return send(res, 200, { heal: await reviewHeal(project, b, 'reject') });
    }

    if (a === 'bugs' && b && !c) {
      const edit: BugEdit = {};
      if (typeof body.title === 'string') edit.title = body.title;
      if (typeof body.severity === 'string') edit.severity = body.severity as BugEdit['severity'];
      if (Array.isArray(body.steps)) edit.steps = body.steps.map(String);
      if (typeof body.expected === 'string') edit.expected = body.expected;
      if (typeof body.actual === 'string') edit.actual = body.actual;
      if (typeof body.note === 'string') edit.note = body.note;
      return send(res, 200, { bug: updateBug(project, b, edit) });
    }
    if (a === 'bugs' && b && c === 'status') {
      const status = body.status === 'approved' || body.status === 'discarded' || body.status === 'draft' ? body.status : undefined;
      if (!status) throw httpError(400, 'status must be approved, discarded or draft');
      const r = setBugStatus(project, b, status, typeof body.note === 'string' ? body.note : undefined);
      return send(res, 200, { bug: r.bug, exported: r.exported ? rel(project.dir, r.exported) : null });
    }
    if (a === 'bugs' && b && c === 'file') {
      const r = await fileBugInJira(project, b);
      return send(res, 200, { bug: r.bug, created: r.created, attached: r.attached });
    }
    return send(res, 404, { error: 'Not found' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    try {
      // A local Host header only: blocks DNS-rebinding pages from reading the API.
      if (!localHosts.has(String(req.headers.host ?? '').toLowerCase())) return send(res, 403, { error: 'Forbidden host' });
      let parts: string[];
      try {
        parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      } catch {
        return send(res, 400, { error: 'Bad path' });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(uiFile()));
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      if (req.method === 'GET' && parts[0] === 'files') {
        // Evidence only: screenshots, videos, traces and reports under .traceqa/ and e2e/results/.
        const project = load();
        const target = path.resolve(project.dir, parts.slice(1).join(path.sep));
        const roots = [project.paths.state, path.join(project.paths.e2e, 'results')].map((r) => path.resolve(r) + path.sep);
        if (!roots.some((r) => target.startsWith(r)) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return send(res, 404, { error: 'Not found' });
        const type = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': type,
          'X-Content-Type-Options': 'nosniff',
          // Reports open in their own sandbox, so they cannot call this API as the dashboard.
          'Content-Security-Policy': type.startsWith('text/html') ? 'sandbox allow-scripts allow-popups' : "default-src 'none'; img-src 'self'; media-src 'self'",
        });
        return fs.createReadStream(target).pipe(res);
      }
      if (parts[0] !== 'api') return send(res, 404, { error: 'Not found' });
      if (req.method === 'GET') return await handleGet(parts, url, res, req);
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (req.headers['x-traceqa'] !== '1' || (origin && !localOrigins.has(origin))) return send(res, 403, { error: 'Forbidden' });
        if (parts[1] === 'requirement-docs') {
          // A document upload: the raw file is the body, its name is in ?name=.
          const project = load();
          const name = url.searchParams.get('name') ?? '';
          const r = await importDocument(project, name, await readRaw(req, MAX_DOCUMENT_BYTES));
          if (loadAppMap(project).pages.length) mapRequirements(project);
          return send(res, 200, r);
        }
        return await handlePost(parts, await readBody(req), res);
      }
      return send(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      const status = (err as { status?: number }).status ?? (err instanceof z.ZodError ? 400 : 500);
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : err instanceof Error ? err.message : String(err);
      if (!res.headersSent) return send(res, status, { error: message });
      res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
  localHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  localOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    dir: rootDir,
    close: () => {
      watcher?.close();
      ExploreSession.onEvent = previousHook;
      for (const c of clients) c.end();
      server.close();
    },
  };
}
