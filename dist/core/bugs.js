import path from 'node:path';
import { listJson, nextId, now, readJson, rel, writeJson, writeText } from './store.js';
export function listBugs(project, status) {
    const bugs = listJson(project.paths.bugs);
    return status ? bugs.filter((b) => b.status === status) : bugs;
}
export function getBug(project, id) {
    const file = path.join(project.paths.bugs, `${id.toUpperCase()}.json`);
    const bug = readJson(file, null);
    if (!bug)
        throw new Error(`No bug ${id}. Known bugs: ${listBugs(project).map((b) => b.id).join(', ') || 'none'}.`);
    return bug;
}
function saveBug(project, bug) {
    writeJson(path.join(project.paths.bugs, `${bug.id}.json`), bug);
}
export const saveBugRecord = saveBug;
/**
 * Creates a draft bug. If an open bug already exists from the same source, it is refreshed.
 * If an open bug already covers the same requirement criterion (say, found while exploring and
 * then again by a test), the new evidence is added to it instead of creating a duplicate.
 */
export function draftBug(project, data) {
    const open = listBugs(project).filter((b) => b.status !== 'discarded');
    const sameSource = open.find((b) => b.source.kind === data.source.kind && b.source.ref === data.source.ref && b.title === data.title);
    if (sameSource) {
        const bug = { ...sameSource, ...data, id: sameSource.id, status: sameSource.status, alsoSeenIn: sameSource.alsoSeenIn, createdAt: sameSource.createdAt, updatedAt: now() };
        saveBug(project, bug);
        return { bug, created: false };
    }
    const sameCriterion = data.requirementId && data.acId
        ? open.find((b) => b.requirementId === data.requirementId && b.acId === data.acId)
        : undefined;
    if (sameCriterion) {
        const seen = `${data.source.kind === 'run' ? 'test' : 'exploration'} ${data.source.ref}`;
        // Keep the bug's own evidence plus only the newest test-run evidence, so repeated runs do not pile up files.
        const runEvidence = `${path.sep}evidence${path.sep}`;
        const evidence = sameCriterion.evidence.filter((e) => !(data.source.kind === 'run' && e.path.includes(runEvidence)));
        for (const e of data.evidence)
            if (!evidence.some((x) => x.path === e.path))
                evidence.push(e);
        const bug = {
            ...sameCriterion,
            evidence,
            alsoSeenIn: [...new Set([...(sameCriterion.alsoSeenIn ?? []), seen])],
            actual: sameCriterion.actual.includes(data.actual) ? sameCriterion.actual : `${sameCriterion.actual}\nAlso seen in ${seen}: ${data.actual}`,
            updatedAt: now(),
        };
        saveBug(project, bug);
        return { bug, created: false };
    }
    const bug = {
        ...data,
        id: nextId('BUG', listBugs(project).map((b) => b.id)),
        status: 'draft',
        createdAt: now(),
        updatedAt: now(),
    };
    saveBug(project, bug);
    return { bug, created: true };
}
export function bugMarkdown(project, bug) {
    const lines = [
        `# ${bug.id}: ${bug.title}`,
        '',
        `- **Severity:** ${bug.severity}`,
        `- **Status:** ${bug.status}`,
        bug.ticket ? `- **Ticket:** [${bug.ticket.key}](${bug.ticket.url})${bug.ticket.duplicate ? ' (existing issue, commented)' : ''}` : null,
        bug.requirementId ? `- **Requirement:** ${bug.requirementId}${bug.acId ? ` ${bug.acId}` : ''}` : null,
        `- **Environment:** ${bug.environment}`,
        `- **Found by:** ${bug.source.kind === 'explore' ? 'exploration session' : 'test'} ${bug.source.ref}`,
        bug.alsoSeenIn?.length ? `- **Also seen in:** ${bug.alsoSeenIn.join(', ')}` : null,
        '',
        '## Steps to reproduce',
        ...bug.steps.map((s, i) => `${i + 1}. ${s}`),
        '',
        '## Expected',
        bug.expected,
        '',
        '## Actual',
        bug.actual,
        '',
        '## Evidence',
        ...(bug.evidence.length ? bug.evidence.map((e) => `- ${e.name}: ${rel(project.dir, e.path)}`) : ['- none']),
    ];
    if (bug.note)
        lines.push('', '## Note', bug.note);
    return lines.filter((l) => l !== null).join('\n') + '\n';
}
/**
 * Approve (export a ticket-ready Markdown file), discard, or reopen a bug as a draft.
 * Filed bugs keep their status: the Jira issue is the source of truth from then on.
 */
export function setBugStatus(project, id, status, note) {
    const bug = getBug(project, id);
    if (bug.status === 'filed')
        throw new Error(`${bug.id} is already filed as ${bug.ticket?.key ?? 'a ticket'}; change it in the tracker.`);
    if (status === 'draft' && bug.status !== 'discarded')
        throw new Error(`Only discarded bugs can be reopened; ${bug.id} is ${bug.status}.`);
    bug.status = status;
    bug.updatedAt = now();
    if (note)
        bug.note = note;
    saveBug(project, bug);
    if (status === 'approved') {
        const file = path.join(project.paths.bugs, `${bug.id}.md`);
        writeText(file, bugMarkdown(project, bug));
        return { bug, exported: file };
    }
    return { bug };
}
/** Lets a person correct a draft or approved bug before it is filed. */
export function updateBug(project, id, edit) {
    const bug = getBug(project, id);
    if (bug.status === 'filed')
        throw new Error(`${bug.id} is already filed as ${bug.ticket?.key ?? 'a ticket'}; edit it in the tracker.`);
    if (edit.title !== undefined) {
        if (!edit.title.trim())
            throw new Error('A bug needs a title.');
        bug.title = edit.title.trim().slice(0, 250);
    }
    if (edit.severity !== undefined) {
        if (!['high', 'medium', 'low'].includes(edit.severity))
            throw new Error('Severity must be high, medium or low.');
        bug.severity = edit.severity;
    }
    if (edit.steps !== undefined)
        bug.steps = edit.steps.map((s) => s.trim()).filter(Boolean);
    if (edit.expected !== undefined)
        bug.expected = edit.expected.trim();
    if (edit.actual !== undefined)
        bug.actual = edit.actual.trim();
    if (edit.note !== undefined)
        bug.note = edit.note.trim() || undefined;
    bug.updatedAt = now();
    saveBug(project, bug);
    if (bug.status === 'approved')
        writeText(path.join(project.paths.bugs, `${bug.id}.md`), bugMarkdown(project, bug));
    return bug;
}
//# sourceMappingURL=bugs.js.map