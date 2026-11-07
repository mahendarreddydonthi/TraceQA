import fs from 'node:fs';
import path from 'node:path';
import type { Project } from './config.js';
import { loadAppMap } from './appMap.js';
import { loadRequirements, openIssues } from './requirements.js';
import { loadTraceability } from './mapper.js';
import { loadTests } from './testgen.js';
import { hasInstalledDeps } from './scaffold.js';
import { latestRun } from './runner.js';
import { listBugs } from './bugs.js';
import { computeCoverage, coverageSummary, latestResults } from './coverage.js';
import { ExploreSession } from './explorer.js';
import { rel } from './store.js';

export function projectStatus(project: Project): string {
  const map = loadAppMap(project);
  const reqs = loadRequirements(project);
  const trace = loadTraceability(project);
  const tests = loadTests(project);
  const run = latestRun(project);
  const drafts = listBugs(project, 'draft');
  const scaffolded = fs.existsSync(path.join(project.paths.e2e, 'playwright.config.ts'));
  const rows = computeCoverage(project);
  const sum = coverageSummary(rows);
  const unclear = reqs.filter((r) => openIssues(r).some((i) => i.kind === 'vague' || i.kind === 'no-criteria'));

  const lines = [
    `Project: ${project.dir}`,
    `App: ${project.config.baseUrl} (allowed hosts: ${project.config.safety.allowedHosts.join(', ')})`,
    `App map: ${map.pages.length ? `${map.pages.length} pages, updated ${map.updatedAt}` : 'empty'}`,
    `Requirements: ${reqs.length ? `${reqs.length} imported from ${rel(project.dir, project.paths.requirementsDir)}/, ${unclear.length} unclear` : 'none imported'}`,
    `Mapping: ${trace.mappedAt ? `${trace.links.filter((l) => l.pages.length).length} mapped, ${trace.pagesWithoutRequirements.length} pages without requirements` : 'not done'}`,
    `Framework: ${scaffolded ? `${rel(project.dir, project.paths.e2e)}/ (${hasInstalledDeps(project) ? 'installed' : 'run npm install'})` : 'not created'} · ${tests.length} tests`,
    `Coverage: ${sum.percentTested}% tested · ${sum.covered} covered, ${sum.failing} failing, ${sum.partial} partial, ${sum.ambiguous} ambiguous, ${sum['not-covered']} not covered, ${sum['not-run']} not run`,
    `Latest run: ${run ? `${run.id} · ${run.totals.passed}/${run.totals.total} passed, ${run.totals.failed} failed` : 'none'}`,
    `Draft bugs: ${drafts.length ? drafts.map((b) => b.id).join(', ') : 'none'}`,
    `Exploration: ${ExploreSession.active ? `session ${ExploreSession.active.id} is open` : 'no open session'}`,
  ];

  let next: string;
  if (!map.pages.length) next = 'Call analyze_app to build the app map.';
  else if (!reqs.length) next = `Add Markdown requirements to ${rel(project.dir, project.paths.requirementsDir)}/ and call import_requirements.`;
  else if (!trace.mappedAt) next = 'Call map_requirements.';
  else if (unclear.length && !tests.length) next = `Ask the user to clarify ${unclear.map((r) => r.id).join(', ')} (clarify_requirement), then continue.`;
  else if (!scaffolded) next = 'Call scaffold_framework.';
  else {
    const todo = rows.filter((r) => r.status === 'not-covered' || r.status === 'partial').filter((r) => !unclear.some((u) => u.id === r.requirementId));
    const broken = latestResults(project).filter((r) => r.status === 'failed' && r.verdict === 'test-broken');
    if (broken.length) next = `${broken.length} test(s) broke after a UI change. Call heal_tests.`;
    else if (todo.length) next = `Explore and write tests (save_test) for: ${todo.map((r) => r.requirementId).join(', ')}.`;
    else if (!run || rows.some((r) => r.status === 'not-run')) next = 'Call run_tests.';
    else if (drafts.length) next = `Review the draft bugs with the user: ${drafts.map((b) => b.id).join(', ')}.`;
    else next = 'Call report for a summary.';
  }
  lines.push(`Next step: ${next}`);
  return lines.join('\n');
}
