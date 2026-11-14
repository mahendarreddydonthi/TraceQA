import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { activeModel, type Project } from '../core/config.js';
import { loadAppMap } from '../core/appMap.js';
import { mapRequirements } from '../core/mapper.js';
import { documentText, importRequirements, requirementsFromFile, resolveRequirementFile, saveReading } from '../core/requirements.js';
import { throwIfStopped } from '../core/proc.js';
import { createModel, type ModelClient } from './agent.js';
import { addUsage, emptyUsage, type Usage } from './pricing.js';

// Optional: reads a requirement document of any format with the configured AI provider and saves what it
// understood as a "reading" for this version of the document. The document itself is never changed; when it
// is edited, TraceQA falls back to its automatic reader until someone reads it with AI again.

const MAX_CHARS = 150_000;

const ReadingSchema = z.object({
  requirements: z
    .array(
      z.object({
        id: z.string().optional().nullable(),
        feature: z.string().optional().nullable(),
        title: z.string().min(1),
        description: z.string().optional().nullable(),
        criteria: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});

export function readingPrompt(): string {
  return `You read requirement documents written in any format (specifications, user stories, briefs, meeting notes, tables, emails) and list the requirements a tester should check in the web app.

Reply with JSON only, no commentary and no code fences:
{"requirements": [{"id": "", "feature": "", "title": "", "description": "", "criteria": [""]}]}

- id: only when the document itself gives the requirement an ID (for example FR-12, US-7, SHOP-142). Otherwise leave it empty; never invent IDs.
- feature: the area of the product it belongs to (for example Checkout).
- title: a short name for the requirement.
- description: one sentence of context, if the document gives any.
- criteria: acceptance criteria, each one observable outcome a browser test can check: what the user does and exactly what they see (text, numbers, pages). Use the document's own words; keep vague wording such as "quickly" as written (TraceQA flags it) instead of inventing numbers.
Cover everything the document asks of the product. Leave out background, goals, glossary and project details. Do not invent behaviour the document does not state.`;
}

function parseReading(text: string) {
  const body = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI answer was not JSON. Try again, or a stronger model.');
  const parsed = ReadingSchema.safeParse(JSON.parse(body.slice(start, end + 1)));
  if (!parsed.success) throw new Error('The AI answer did not list any requirements. Try again, or a stronger model.');
  return parsed.data.requirements.map((r) => ({ id: r.id || undefined, feature: r.feature || undefined, title: r.title, description: r.description || undefined, criteria: r.criteria }));
}

export async function readDocumentWithAI(
  project: Project,
  file: string,
  opts: { signal?: AbortSignal; log?: (line: string) => void; model?: ModelClient } = {},
): Promise<{ file: string; requirements: number; criteria: number; ids: string[]; usage: Usage; truncated: boolean }> {
  const log = opts.log ?? (() => {});
  const abs = resolveRequirementFile(project, file, true);
  const { text } = await documentText(project, abs);
  if (!text.trim()) throw new Error('The document has no text to read. Scanned PDFs need text recognition (OCR) first.');
  const truncated = text.length > MAX_CHARS;
  if (truncated) log(`The document is long; only the first ${MAX_CHARS.toLocaleString()} characters are read.`);
  const model = opts.model ?? createModel(project);
  const label = activeModel(project.config.ai).label;
  log(`Reading ${file} with ${label} …`);
  throwIfStopped(opts.signal);
  const msg = await model.next({ system: readingPrompt(), tools: [], messages: [{ role: 'user', content: `Document "${path.basename(file)}":\n\n${text.slice(0, MAX_CHARS)}` }], signal: opts.signal });
  const usage = addUsage(emptyUsage(), msg.model ?? activeModel(project.config.ai).model, msg.usage);
  if (msg.stop_reason === 'refusal') throw new Error('The model declined to read this document.');
  if (msg.stop_reason === 'max_tokens') log('The answer hit the output limit; the last requirements may be missing.');
  const items = parseReading(msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n'));
  const reading = await saveReading(project, file, items, `AI (${label})`);
  await importRequirements(project);
  if (loadAppMap(project).pages.length) mapRequirements(project);
  const reqs = requirementsFromFile(project, reading.file).filter((r) => r.source.mode === 'ai');
  log(`Found ${reqs.length} requirement(s) with ${reqs.reduce((n, r) => n + r.criteria.length, 0)} acceptance criteria.`);
  return { file: reading.file, requirements: reqs.length, criteria: reqs.reduce((n, r) => n + r.criteria.length, 0), ids: reqs.map((r) => r.id), usage, truncated };
}
