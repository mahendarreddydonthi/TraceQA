import fs from 'node:fs';
import path from 'node:path';
export function readJson(file, fallback) {
    if (!fs.existsSync(file))
        return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
export function writeText(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}
/** Writes the file only when it does not exist yet. Returns true when it wrote. */
export function writeIfMissing(file, text) {
    if (fs.existsSync(file))
        return false;
    writeText(file, text);
    return true;
}
export const now = () => new Date().toISOString();
/** Next sequential id such as BUG-03 or RUN-012. */
export function nextId(prefix, existing, width = 2) {
    let max = 0;
    for (const id of existing) {
        const m = id.match(new RegExp(`^${prefix}-(\\d+)$`));
        if (m)
            max = Math.max(max, Number(m[1]));
    }
    return `${prefix}-${String(max + 1).padStart(width, '0')}`;
}
export function listJson(dir) {
    if (!fs.existsSync(dir))
        return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}
export function rel(from, to) {
    return path.relative(from, to).split(path.sep).join('/');
}
export function slug(text, max = 48) {
    return text
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, max)
        .replace(/-+$/g, '');
}
export function pascal(text) {
    return text
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
        .join('');
}
export function camel(text) {
    const p = pascal(text);
    return p ? p[0].toLowerCase() + p.slice(1) : '';
}
//# sourceMappingURL=store.js.map