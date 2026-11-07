import { loadRequirements, openIssues } from './requirements.js';
import { loadTests } from './testgen.js';
import { classify, listRuns } from './runner.js';
import { listBugs } from './bugs.js';
/** The most recent result of every test (per browser), across all runs, so a partial run does not hide older results. */
export function latestResults(project) {
    const byTest = new Map();
    const defs = new Map(loadTests(project).map((t) => [t.id, t]));
    for (const run of listRuns(project)) {
        for (const r of run.results) {
            if (r.testDefId && !defs.has(r.testDefId))
                continue; // test was removed since
            byTest.set(`${r.title}|${r.project}`, { result: r, at: run.finishedAt });
        }
    }
    return [...byTest.values()].map(({ result, at }) => {
        // A test changed after the run (healed or re-saved) and checked again since: use that newer check.
        const def = result.testDefId ? defs.get(result.testDefId) : undefined;
        const v = def?.lastVerification;
        if (def && v && def.updatedAt > at && v.at > at) {
            return { ...result, status: v.status, error: v.error, verdict: v.status === 'failed' ? classify(v.error ?? '') : undefined };
        }
        return result;
    });
}
/** Combines requirements, test definitions, the latest run and open bugs into one status per requirement. */
export function computeCoverage(project) {
    const reqs = loadRequirements(project);
    const tests = loadTests(project);
    const latest = latestResults(project);
    const bugs = listBugs(project).filter((b) => b.status !== 'discarded');
    return reqs.map((req) => {
        const results = latest.filter((r) => r.requirementId === req.id);
        const defs = tests.filter((t) => t.requirementId === req.id);
        const criteria = req.criteria.map((c) => {
            const acResults = results.filter((r) => r.acId === c.id);
            const acDefs = defs.filter((d) => d.acId === c.id);
            const testCount = Math.max(acDefs.length, new Set(acResults.map((r) => r.title)).size);
            return {
                acId: c.id,
                text: c.text,
                tests: testCount,
                passed: acResults.filter((r) => r.status === 'passed' || r.status === 'flaky').length,
                failed: acResults.filter((r) => r.status === 'failed').length,
            };
        });
        const testCount = Math.max(defs.length, new Set(results.map((r) => r.title)).size);
        const issues = openIssues(req);
        let status;
        if (testCount === 0)
            status = issues.some((i) => i.kind === 'vague') ? 'ambiguous' : 'not-covered';
        else if (results.some((r) => r.status === 'failed'))
            status = 'failing';
        else if (criteria.some((c) => c.tests === 0))
            status = 'partial';
        else if (!results.length)
            status = 'not-run';
        else
            status = 'covered';
        return {
            requirementId: req.id,
            title: req.title,
            feature: req.feature,
            status,
            criteria,
            tests: testCount,
            openIssues: issues.length,
            bugs: bugs.filter((b) => b.requirementId === req.id).map((b) => b.id),
        };
    });
}
export function coverageSummary(rows) {
    const out = { total: rows.length, covered: 0, failing: 0, partial: 0, 'not-covered': 0, ambiguous: 0, 'not-run': 0, percentTested: 0 };
    for (const r of rows)
        out[r.status]++;
    out.percentTested = rows.length ? Math.round(((out.covered + out.failing) / rows.length) * 100) : 0;
    return out;
}
//# sourceMappingURL=coverage.js.map