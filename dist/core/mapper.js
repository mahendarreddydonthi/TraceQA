import { loadAppMap } from './appMap.js';
import { loadRequirements } from './requirements.js';
import { now, readJson, writeJson } from './store.js';
const STOP = new Set(('a an and are as at be by can for from has have in into is it its of on or so that the their then this to was were will with ' +
    'when after before also only not no all any each every should must shows show page user users customer customers able ' +
    'valid value values one two own its it\'s you your')
    .split(/\s+/));
export function tokens(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w))
        .map((w) => (w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}
/** Page vocabulary. Weight 3 = in the path or a heading (strong), 2 = title or element name, 1 = body text. */
function pageTerms(page, chrome) {
    const weights = new Map();
    const add = (text, w) => {
        for (const t of tokens(text))
            weights.set(t, Math.max(weights.get(t) ?? 0, w));
    };
    add(page.textSample, 1);
    add(page.elements.filter((e) => !chrome.has(`${e.role}|${e.name}`)).map((e) => e.name).join(' '), 2);
    add(page.title, 2);
    add(page.headings.join(' '), 3);
    add(page.templatePath.replace(/[/:-]/g, ' '), 3);
    return weights;
}
/** Requirement vocabulary. Feature words only count when they match a page path or heading. */
function requirementTerms(req) {
    const terms = new Map();
    const add = (text, w) => {
        for (const t of tokens(text))
            terms.set(t, Math.max(terms.get(t) ?? 0, w));
    };
    add(req.criteria.map((c) => c.text).join(' '), 1);
    add(req.description, 1);
    add(req.title, 2);
    const feature = new Set(tokens(req.feature).filter((t) => !terms.has(t)));
    for (const t of feature)
        terms.set(t, 1.5);
    return { terms, feature };
}
/** Links requirements to app pages by shared vocabulary, ignoring words that appear on almost every page (menus, footers). */
export function mapRequirements(project) {
    const map = loadAppMap(project);
    const reqs = loadRequirements(project);
    if (!map.pages.length)
        throw new Error('The app map is empty. Run analyze_app first.');
    if (!reqs.length)
        throw new Error('No requirements imported. Run import_requirements first.');
    // Elements on most pages (menus, footers) say nothing about what a page is for.
    const n = map.pages.length;
    const elementCount = new Map();
    for (const p of map.pages)
        for (const k of new Set(p.elements.map((e) => `${e.role}|${e.name}`)))
            elementCount.set(k, (elementCount.get(k) ?? 0) + 1);
    const chrome = new Set([...elementCount].filter(([, c]) => n >= 3 && c / n >= 0.6).map(([k]) => k));
    const pageWeights = map.pages.map((p) => ({ page: p, terms: pageTerms(p, chrome) }));
    const df = new Map();
    for (const { terms } of pageWeights)
        for (const t of terms.keys())
            df.set(t, (df.get(t) ?? 0) + 1);
    const idf = (t) => Math.log((n + 1) / (df.get(t) ?? n + 1));
    const links = [];
    const unmapped = [];
    const used = new Set();
    for (const req of reqs) {
        const { terms: rTerms, feature } = requirementTerms(req);
        const scored = pageWeights
            .map(({ page, terms }) => {
            let score = 0;
            let strong = false;
            const matched = [];
            for (const [t, rw] of rTerms) {
                const pw = terms.get(t);
                if (!pw || (feature.has(t) && pw < 3))
                    continue;
                // A word in the page path or a heading always counts, even if it is common.
                const s = rw * pw * (pw >= 3 ? Math.max(idf(t), 1) : idf(t));
                if (s > 0.05) {
                    score += s;
                    matched.push(t);
                    if (pw >= 3 && page.templatePath.includes(t))
                        strong = true;
                }
            }
            return { pageId: page.id, score: Math.round(score * 100) / 100, terms: matched, strong };
        })
            // One shared word is weak evidence unless it names the page's path.
            .filter((s) => s.score >= 1.5 && (s.terms.length >= 2 || s.strong))
            .map(({ strong: _strong, ...rest }) => rest)
            .sort((a, b) => b.score - a.score);
        const best = scored[0]?.score ?? 0;
        const chosen = scored.filter((s) => s.score >= best * 0.5).slice(0, 3);
        if (!chosen.length)
            unmapped.push(req.id);
        for (const c of chosen)
            used.add(c.pageId);
        links.push({ requirementId: req.id, pages: chosen });
    }
    const result = {
        mappedAt: now(),
        links,
        unmappedRequirements: unmapped,
        pagesWithoutRequirements: map.pages.filter((p) => !used.has(p.id)).map((p) => p.id),
    };
    writeJson(project.paths.traceability, result);
    return result;
}
export function loadTraceability(project) {
    return readJson(project.paths.traceability, { mappedAt: '', links: [], unmappedRequirements: [], pagesWithoutRequirements: [] });
}
//# sourceMappingURL=mapper.js.map