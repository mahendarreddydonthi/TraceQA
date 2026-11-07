import path from 'node:path';
import { computeCoverage, coverageSummary } from './coverage.js';
import { loadRequirements, openIssues } from './requirements.js';
import { loadTraceability } from './mapper.js';
import { loadAppMap } from './appMap.js';
import { latestRun } from './runner.js';
import { listBugs } from './bugs.js';
import { loadTests } from './testgen.js';
import { now, rel, writeText } from './store.js';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STATUS = {
    covered: { label: 'Covered', color: '#0CA30C' },
    failing: { label: 'Failing', color: '#D03B3B' },
    partial: { label: 'Partial', color: '#FAB219' },
    ambiguous: { label: 'Ambiguous', color: '#2A78D6' },
    'not-run': { label: 'Not run yet', color: '#8A92A3' },
    'not-covered': { label: 'Not covered', color: '#C3C2B7' },
};
export function buildReport(project) {
    const rows = computeCoverage(project);
    const sum = coverageSummary(rows);
    const reqs = loadRequirements(project);
    const trace = loadTraceability(project);
    const map = loadAppMap(project);
    const run = latestRun(project);
    const bugs = listBugs(project).filter((b) => b.status !== 'discarded');
    const tests = loadTests(project);
    const file = path.join(project.paths.report, 'index.html');
    const dir = path.dirname(file);
    const passRate = run && run.totals.total ? Math.round(((run.totals.passed + run.totals.flaky) / run.totals.total) * 100) : undefined;
    const chip = (s) => `<span class="chip"><span class="dot" style="background:${STATUS[s].color}"></span>${STATUS[s].label}</span>`;
    const order = ['covered', 'failing', 'partial', 'ambiguous', 'not-run', 'not-covered'];
    const bar = order
        .filter((s) => sum[s] > 0)
        .map((s) => `<div title="${STATUS[s].label} · ${sum[s]}" style="flex:${sum[s]} 1 0;background:${STATUS[s].color}"></div>`)
        .join('');
    const legend = order
        .filter((s) => sum[s] > 0)
        .map((s) => `<span class="legend"><span class="sw" style="background:${STATUS[s].color}"></span>${STATUS[s].label} ${sum[s]}</span>`)
        .join('');
    const reqRows = rows
        .map((r) => {
        const tested = r.criteria.filter((c) => c.tests > 0).length;
        return `<tr><td class="mono">${esc(r.requirementId)}</td><td>${esc(r.title)}<span class="sub">${esc(r.feature)}</span></td>
<td>${r.criteria.length ? `${tested} of ${r.criteria.length}` : '—'}</td><td class="num">${r.tests}</td><td>${chip(r.status)}</td>
<td>${r.bugs.map((b) => `<a href="#${esc(b)}">${esc(b)}</a>`).join(', ') || ''}</td></tr>`;
    })
        .join('\n');
    const unclear = reqs
        .map((r) => ({ r, issues: openIssues(r) }))
        .filter((x) => x.issues.length)
        .map((x) => `<li><span class="mono">${esc(x.r.id)}</span> ${esc(x.r.title)}<ul>${x.issues.map((i) => `<li>${i.acId ? `${esc(i.acId)}: ` : ''}${esc(i.message)}</li>`).join('')}</ul></li>`)
        .join('');
    const pageName = (id) => map.pages.find((p) => p.id === id)?.templatePath ?? id;
    const gaps = trace.pagesWithoutRequirements.map((id) => `<span class="tag mono">${esc(pageName(id))}</span>`).join(' ');
    const failing = run
        ? run.results
            .filter((r) => r.status !== 'passed')
            .map((r) => `<li><strong>${esc(r.title)}</strong> <span class="sub-inline">${esc(r.project)} · ${esc(r.status)}${r.verdict ? ` · ${esc(r.verdict)}` : ''}</span>${r.error ? `<pre>${esc(r.error.split('\n').slice(0, 6).join('\n'))}</pre>` : ''}</li>`)
            .join('')
        : '';
    const bugCards = bugs
        .map((b) => `<article class="bug" id="${esc(b.id)}">
<div class="bug-head"><span class="mono">${esc(b.id)} · ${esc(b.status)}</span><span class="chip">${esc(b.severity)}</span></div>
<h3>${esc(b.title)}</h3>
<p class="sub">${b.requirementId ? `${esc(b.requirementId)}${b.acId ? ` ${esc(b.acId)}` : ''} · ` : ''}${esc(b.environment)}</p>
<ol>${b.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
<div class="ea"><div><strong>Expected</strong><p>${esc(b.expected).replace(/\n/g, '<br>')}</p></div><div class="actual"><strong>Actual</strong><p>${esc(b.actual).replace(/\n/g, '<br>')}</p></div></div>
<p class="evidence">${b.evidence.map((e) => `<a href="${esc(rel(dir, e.path))}">${esc(e.name)}</a>`).join(' · ')}</p>
</article>`)
        .join('\n');
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TraceQA report · ${esc(path.basename(project.dir))}</title>
<style>
:root{--bg:#F6F7F9;--card:#fff;--ink:#14171F;--muted:#5F6878;--line:#E3E6EB;--accent:#4338CA}
@media (prefers-color-scheme: dark){:root{--bg:#0F1117;--card:#171A22;--ink:#E8EAF0;--muted:#A0A7B5;--line:#2A2F3B;--accent:#A5B4FC}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 16px 48px;display:flex;flex-direction:column;gap:20px}
h1{margin:0;font-size:26px}h2{margin:0 0 12px;font-size:16px}h3{margin:4px 0;font-size:16px}
a{color:var(--accent)}
.sub{display:block;font-size:12px;color:var(--muted)}.sub-inline{font-size:12px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px}
.kpis{display:flex;flex-wrap:wrap;gap:16px}.kpi{flex:1 1 200px}.kpi b{display:block;font-size:30px;font-weight:600}
.bar{display:flex;gap:2px;height:14px;margin:8px 0}.bar div:first-child{border-radius:4px 0 0 4px}.bar div:last-child{border-radius:0 4px 4px 0}
.legend{display:inline-flex;align-items:center;gap:6px;margin-right:16px;font-size:13px}.sw{width:10px;height:10px;border-radius:3px}
.table{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:640px}th,td{text-align:left;padding:10px 12px;border-top:1px solid var(--line);vertical-align:top}
th{font-size:12px;font-weight:500;color:var(--muted);border-top:none}.num{text-align:right;font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:13px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;background:var(--bg);font-size:12px;font-weight:500;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:999px}.tag{display:inline-block;padding:2px 8px;border-radius:6px;background:var(--bg);margin:2px}
pre{white-space:pre-wrap;background:var(--bg);padding:8px 10px;border-radius:8px;font-size:12px}
.bug{border-top:1px solid var(--line);padding-top:14px;margin-top:14px}.bug-head{display:flex;justify-content:space-between;gap:8px}
.ea{display:flex;flex-wrap:wrap;gap:10px}.ea>div{flex:1 1 260px;background:var(--bg);border-radius:8px;padding:10px 12px}.ea p{margin:4px 0 0}
.grid2{display:flex;flex-wrap:wrap;gap:16px}.grid2>section{flex:1 1 420px;min-width:0}
</style>
</head>
<body>
<main>
<header><span class="sub">TraceQA report · generated ${esc(now().replace('T', ' ').slice(0, 16))} UTC</span><h1>${esc(path.basename(project.dir))}</h1><span class="sub">${esc(project.config.baseUrl)}</span></header>
<section class="kpis">
<div class="card kpi"><span class="sub">Requirements tested</span><b>${sum.percentTested}%</b><span class="sub">${sum.covered + sum.failing} of ${sum.total} requirements</span></div>
<div class="card kpi"><span class="sub">Tests</span><b>${tests.length}</b><span class="sub">across ${new Set(tests.map((t) => t.requirementId)).size} requirements</span></div>
<div class="card kpi"><span class="sub">Last run pass rate</span><b>${passRate === undefined ? '—' : `${passRate}%`}</b><span class="sub">${run ? `${esc(run.id)} · ${run.totals.passed} of ${run.totals.total} passed` : 'No run yet'}</span></div>
<div class="card kpi"><span class="sub">Open bugs</span><b>${bugs.length}</b><span class="sub">${bugs.filter((b) => b.status === 'draft').length} drafts waiting for review</span></div>
</section>
<section class="card"><h2>Requirement coverage</h2><div class="bar" role="img" aria-label="${order.map((s) => `${sum[s]} ${STATUS[s].label}`).join(', ')}">${bar}</div><div>${legend}</div>
<div class="table"><table><thead><tr><th>ID</th><th>Requirement</th><th>Criteria tested</th><th class="num">Tests</th><th>Status</th><th>Bugs</th></tr></thead><tbody>${reqRows}</tbody></table></div></section>
<div class="grid2">
<section class="card"><h2>Needs clarification</h2>${unclear ? `<ul>${unclear}</ul>` : '<p class="sub">Nothing unclear.</p>'}</section>
<section class="card"><h2>App pages with no requirements</h2>${gaps || '<p class="sub">Every analyzed page is linked to a requirement.</p>'}${trace.unmappedRequirements.length ? `<h2 style="margin-top:16px">Requirements with no matching page</h2>${trace.unmappedRequirements.map((r) => `<span class="tag mono">${esc(r)}</span>`).join(' ')}` : ''}</section>
</div>
<section class="card"><h2>Latest run${run ? ` · ${esc(run.id)}` : ''}</h2>${run ? `<p>${run.totals.passed} passed · ${run.totals.failed} failed · ${run.totals.flaky} flaky · ${run.totals.skipped} skipped</p>${failing ? `<ul>${failing}</ul>` : ''}` : '<p class="sub">No tests have run yet.</p>'}</section>
<section class="card"><h2>Bugs</h2>${bugCards || '<p class="sub">No open bugs.</p>'}</section>
</main>
</body>
</html>
`;
    writeText(file, html);
    const md = [
        `Requirements tested: ${sum.percentTested}% (${sum.covered} covered, ${sum.failing} failing, ${sum.partial} partial, ${sum.ambiguous} ambiguous, ${sum['not-covered']} not covered, ${sum['not-run']} not run)`,
        run ? `Latest run ${run.id}: ${run.totals.passed}/${run.totals.total} passed, ${run.totals.failed} failed, ${run.totals.flaky} flaky` : 'No test run yet.',
        `Open bugs: ${bugs.length} (${bugs.filter((b) => b.status === 'draft').length} drafts)`,
        '',
        ...rows.map((r) => `- ${r.requirementId} ${STATUS[r.status].label}: ${r.title}${r.bugs.length ? ` (bugs: ${r.bugs.join(', ')})` : ''}`),
        '',
        `HTML report: ${rel(project.dir, file)}`,
    ].join('\n');
    return { file, markdown: md };
}
//# sourceMappingURL=report.js.map