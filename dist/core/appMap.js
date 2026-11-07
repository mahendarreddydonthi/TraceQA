import { isAllowedUrl } from './config.js';
import { guardedContext, launchBrowser, readPage, settle, signIn } from './browser.js';
import { now, pascal, readJson, slug, writeJson } from './store.js';
import { throwIfStopped } from './proc.js';
const SEGMENT_NAMES = { p: 'product', u: 'user', c: 'category', o: 'order' };
/** /p/12 → /p/:id, /orders/9f3c…/items → /orders/:id/items */
export function templatePath(pathname) {
    const parts = pathname.split('/').map((seg) => /^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) || /^[A-Za-z0-9_-]{20,}$/.test(seg) ? ':id' : seg);
    const out = parts.join('/');
    return out.length > 1 ? out.replace(/\/+$/, '') : '/';
}
export function pageIdFor(template) {
    if (template === '/')
        return 'home';
    const segs = template.split('/').filter(Boolean);
    const words = [];
    segs.forEach((seg, i) => {
        if (seg === ':id') {
            if (i === segs.length - 1)
                words.push('detail');
            return;
        }
        words.push(SEGMENT_NAMES[seg] ?? seg);
    });
    return slug(words.join('-')) || 'page';
}
export function loadAppMap(project) {
    return readJson(project.paths.appMap, { baseUrl: project.config.baseUrl, updatedAt: '', pages: [] });
}
export function saveAppMap(project, map) {
    map.updatedAt = now();
    writeJson(project.paths.appMap, map);
}
export function findPageByPath(map, pathOrUrl) {
    let pathname = pathOrUrl;
    try {
        pathname = new URL(pathOrUrl, map.baseUrl || 'http://localhost').pathname;
    }
    catch {
        /* keep as is */
    }
    const t = templatePath(pathname);
    return map.pages.find((p) => p.templatePath === t);
}
/** Adds or refreshes a page in the app map (matched by template path). */
export function upsertPage(map, facts, source) {
    const u = new URL(facts.url);
    const template = templatePath(u.pathname);
    const existing = map.pages.find((p) => p.templatePath === template);
    const id = existing?.id ?? uniqueId(map, pageIdFor(template));
    const page = {
        id,
        className: existing?.className ?? uniqueClass(map, pascal(id) + 'Page'),
        name: facts.headings[0] || facts.title || id,
        path: u.pathname,
        templatePath: template,
        title: facts.title,
        headings: facts.headings,
        elements: facts.elements,
        links: facts.links,
        forms: facts.forms,
        textSample: facts.textSample,
        source,
        updatedAt: now(),
    };
    if (existing)
        map.pages[map.pages.indexOf(existing)] = page;
    else
        map.pages.push(page);
    return page;
}
function uniqueId(map, base) {
    let id = base;
    for (let i = 2; map.pages.some((p) => p.id === id); i++)
        id = `${base}-${i}`;
    return id;
}
function uniqueClass(map, base) {
    let name = base;
    for (let i = 2; map.pages.some((p) => p.className === name); i++)
        name = base.replace(/Page$/, `${i}Page`);
    return name;
}
/** Crawls the app from baseUrl (staying on allowed hosts) and records each page type once. */
export async function analyzeApp(project, opts = {}) {
    throwIfStopped(opts.signal);
    const log = opts.log ?? (() => { });
    const maxPages = opts.maxPages ?? project.config.analyze.maxPages;
    const skipWords = project.config.analyze.skipLinks.map((s) => s.toLowerCase());
    const map = loadAppMap(project);
    map.baseUrl = project.config.baseUrl;
    const result = { map, visited: [], skipped: [], errors: [], signedIn: false };
    const browser = await launchBrowser(false);
    try {
        const context = await guardedContext(browser, project, (u) => result.skipped.push(u));
        const page = await context.newPage();
        const preSeen = [];
        if (project.config.auth) {
            // Record the sign-in page first: once signed in, most apps stop linking to it.
            try {
                await page.goto(project.config.auth.loginPath, { waitUntil: 'domcontentloaded', timeout: 20000 });
                await settle(page);
                const login = upsertPage(map, await readPage(page), 'analyze');
                preSeen.push(login.templatePath);
                result.visited.push(page.url());
                log(`  ${login.templatePath}  (${login.elements.length} elements)`);
            }
            catch (err) {
                result.errors.push(`Sign-in page: ${err.message.split('\n')[0]}`);
            }
            try {
                await signIn(page, project);
                result.signedIn = true;
                log('Signed in with the test account');
            }
            catch (err) {
                result.errors.push(`Sign-in skipped: ${err.message}`);
            }
        }
        const queue = [new URL('/', project.config.baseUrl).toString()];
        const queued = new Set(queue);
        const seenTemplates = new Set(preSeen);
        let captured = preSeen.length;
        while (queue.length && captured < maxPages) {
            throwIfStopped(opts.signal);
            const url = queue.shift();
            const requested = templatePath(new URL(url).pathname);
            if (seenTemplates.has(requested))
                continue;
            seenTemplates.add(requested);
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
                await settle(page);
            }
            catch (err) {
                result.errors.push(`${url}: ${err.message.split('\n')[0]}`);
                continue;
            }
            const finalTemplate = templatePath(new URL(page.url()).pathname);
            if (finalTemplate !== requested) {
                if (seenTemplates.has(finalTemplate))
                    continue; // redirected to a page we already have
                seenTemplates.add(finalTemplate);
            }
            const facts = await readPage(page);
            const recorded = upsertPage(map, facts, 'analyze');
            captured++;
            result.visited.push(page.url());
            log(`  ${recorded.templatePath}  (${recorded.elements.length} elements)`);
            for (const link of facts.links) {
                let target;
                try {
                    target = new URL(link.href);
                }
                catch {
                    continue;
                }
                target.hash = '';
                const href = target.toString();
                if (!/^https?:$/.test(target.protocol) || !isAllowedUrl(project, href))
                    continue;
                if (/\.(pdf|zip|png|jpe?g|gif|svg|csv|xlsx?)$/i.test(target.pathname))
                    continue;
                if (skipWords.some((w) => link.text.toLowerCase().includes(w) || target.pathname.toLowerCase().includes(w.replace(/\s+/g, '')))) {
                    result.skipped.push(href);
                    continue;
                }
                if (!queued.has(href) && !seenTemplates.has(templatePath(target.pathname))) {
                    queued.add(href);
                    queue.push(href);
                }
            }
        }
    }
    finally {
        await browser.close();
    }
    saveAppMap(project, map);
    return result;
}
//# sourceMappingURL=appMap.js.map