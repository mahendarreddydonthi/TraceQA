import { describeLocator } from '../core/locators.js';
import type { LocatorSpec } from '../core/types.js';
import type { AgentEvent } from './agent.js';

// Live progress for AI jobs: which phase the agent is in, what it is doing right now, running counts,
// and a readable timeline. Built only from the agent's tool calls, so it works with every model.

export type PhaseKey = 'prepare' | 'explore' | 'automate' | 'verify' | 'summary';
export type PhaseStatus = 'pending' | 'active' | 'done' | 'skipped';
export type ProgressKind = 'phase' | 'action' | 'finding' | 'flow' | 'test' | 'run' | 'note' | 'info' | 'error';
export type ProgressPlan = 'explore-app' | 'explore-app-automate' | 'explore' | 'generate' | 'heal' | 'agent';

export interface ProgressEvent {
  at: string;
  phase: PhaseKey;
  kind: ProgressKind;
  text: string;
  /** An id the dashboard can link to: BUG-…, E2E-…, a test id, RUN-…, S-… */
  ref?: string;
  ok?: boolean;
  detail?: string;
}

export interface ProgressCounts {
  turns: number;
  steps: number;
  failedSteps: number;
  pages: number;
  findings: number;
  flows: number;
  tests: number;
  testsPassed: number;
  testsFailed: number;
}

export interface JobProgress {
  plan: ProgressPlan;
  phases: { key: PhaseKey; label: string; status: PhaseStatus }[];
  phase?: PhaseKey;
  /** What the agent is doing right now, in plain words. */
  activity: string;
  /** The agent's latest own words about what it is doing. */
  note?: string;
  counts: ProgressCounts;
  /** Flows to automate: a number, null for "every flow found", undefined when not automating. */
  flowTarget?: number | null;
  sessionId?: string;
  events: ProgressEvent[];
  done: boolean;
  updatedAt: string;
}

/** The short form sent with job lists and the running pill. */
export type ProgressLine = Pick<JobProgress, 'phase' | 'activity' | 'counts' | 'done' | 'flowTarget'> & { phaseLabel?: string; step?: number; of?: number };

const PLANS: Record<ProgressPlan, [PhaseKey, string][]> = {
  'explore-app': [['prepare', 'Getting ready'], ['explore', 'Exploring the app'], ['summary', 'Summary']],
  'explore-app-automate': [['prepare', 'Getting ready'], ['explore', 'Exploring the app'], ['automate', 'Automating flows'], ['verify', 'Running the new tests'], ['summary', 'Summary']],
  explore: [['prepare', 'Reading the requirement'], ['explore', 'Exploring in the browser'], ['summary', 'Summary']],
  generate: [['prepare', 'Reading requirements'], ['explore', 'Learning the flows'], ['automate', 'Writing tests'], ['verify', 'Running the tests'], ['summary', 'Summary']],
  heal: [['prepare', 'Checking broken tests'], ['explore', 'Inspecting the pages'], ['automate', 'Fixing tests'], ['verify', 'Re-running tests'], ['summary', 'Summary']],
  agent: [['prepare', 'Getting ready'], ['explore', 'Exploring'], ['automate', 'Writing tests'], ['verify', 'Running tests'], ['summary', 'Summary']],
};

const TOOL_PHASE: Record<string, PhaseKey> = {
  analyze_app: 'prepare',
  import_requirements: 'prepare',
  import_requirement_document: 'prepare',
  map_requirements: 'prepare',
  explore_start: 'explore',
  explore_action: 'explore',
  explore_snapshot: 'explore',
  explore_record_finding: 'explore',
  explore_end: 'explore',
  save_discovered_flow: 'automate',
  scaffold_framework: 'automate',
  save_test: 'automate',
  run_tests: 'verify',
  heal_tests: 'verify',
};

const MAX_EVENTS = 400;
const oneLine = (s: string, max = 220) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const secret = (v: unknown) => typeof v === 'string' && /^\$\{?[A-Z][A-Z0-9_]*\}?$/.test(v);

export interface TrackerOptions {
  /** Flows to automate (explore-app with tests): a number, or null for every flow found. */
  flowTarget?: number | null;
  /** Turns a snapshot ref (e7) into a readable name, e.g. `button "Add to cart"`. */
  resolveRef?: (ref: string) => string | undefined;
  now?: () => string;
}

export class ProgressTracker {
  readonly progress: JobProgress;
  private visited = new Set<PhaseKey>();
  private running = 0;
  /** Exact counts come from the live session; then tool results don't add to them. */
  private fed = false;
  /** The latest event is the agent's note for the tool calls about to start. */
  private freshNote = false;
  private now: () => string;

  constructor(
    plan: ProgressPlan,
    private emit: (p: JobProgress) => void,
    private opts: TrackerOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.progress = {
      plan,
      phases: PLANS[plan].map(([key, label]) => ({ key, label, status: 'pending' })),
      activity: 'Starting the AI agent…',
      counts: { turns: 0, steps: 0, failedSteps: 0, pages: 0, findings: 0, flows: 0, tests: 0, testsPassed: 0, testsFailed: 0 },
      flowTarget: opts.flowTarget,
      events: [],
      done: false,
      updatedAt: this.now(),
    };
  }

  /** Feed one agent event (pass this as runAgent's onEvent). */
  handle = (e: AgentEvent): void => {
    const p = this.progress;
    const wasFresh = this.freshNote;
    this.freshNote = false;
    switch (e.type) {
      case 'turn':
        p.counts.turns = e.n;
        if (!this.running) p.activity = e.n === 1 ? 'Reading the task and planning…' : 'Deciding what to do next…';
        break;
      case 'text':
        p.note = oneLine(e.text, 280);
        this.add('note', p.note);
        this.freshNote = true;
        break;
      case 'tool-start':
        this.running++;
        this.freshNote = wasFresh;
        this.enter(this.phaseFor(e.name));
        this.freshNote = false;
        p.activity = this.doing(e.name, e.input);
        break;
      case 'tool-done':
        this.running = Math.max(0, this.running - 1);
        this.done(e.name, e.input, e.output);
        p.activity = 'Deciding what to do next…';
        break;
      case 'tool-error':
        this.running = Math.max(0, this.running - 1);
        this.add('error', `${this.doing(e.name, e.input).replace(/…$/, '')} failed`, { detail: oneLine(e.error.split('\n')[0], 300), ok: false });
        p.activity = 'Deciding what to do next…';
        break;
    }
    this.publish();
  };

  /** Exact numbers from the live exploration session. */
  session(s: { id: string; steps: { ok: boolean }[]; pages: string[] | Set<string>; findings: unknown[] }): void {
    const p = this.progress;
    this.fed = true;
    p.sessionId = s.id;
    p.counts.steps = s.steps.length;
    p.counts.failedSteps = s.steps.filter((x) => !x.ok).length;
    p.counts.pages = Array.isArray(s.pages) ? s.pages.length : s.pages.size;
    p.counts.findings = s.findings.length;
    this.publish();
  }

  /** The job ended. */
  finish(status: 'done' | 'failed' | 'stopped', message?: string): void {
    const p = this.progress;
    if (status === 'done') this.enter('summary');
    for (const ph of p.phases) {
      if (ph.status === 'active') ph.status = status === 'done' ? 'done' : ph.status;
      if (ph.status === 'pending') ph.status = 'skipped';
    }
    p.activity = status === 'done' ? 'Finished' : status === 'stopped' ? 'Stopped' : `Failed${message ? `: ${oneLine(message.split('\n')[0], 160)}` : ''}`;
    this.add(status === 'failed' ? 'error' : 'info', status === 'done' ? 'Finished. The summary is below.' : status === 'stopped' ? 'Stopped by a person.' : p.activity, { ok: status === 'done' });
    p.done = true;
    this.publish();
  }

  // ---------- internals ----------

  private phaseFor(tool: string): PhaseKey {
    const known = TOOL_PHASE[tool];
    const planHas = (k: PhaseKey) => this.progress.phases.some((ph) => ph.key === k);
    // Look-ups (status, get_page, get_requirement, list_tests …) stay in the current phase.
    if (!known) return this.progress.phase ?? 'prepare';
    if (known === 'prepare' && this.progress.phase) return this.progress.phase;
    if (planHas(known)) return known;
    return this.progress.phase ?? 'prepare';
  }

  private enter(key: PhaseKey): void {
    const p = this.progress;
    if (p.phase === key) return;
    if (!p.phases.some((ph) => ph.key === key)) return;
    p.phase = key;
    this.visited.add(key);
    for (const ph of p.phases) ph.status = ph.key === key ? 'active' : this.visited.has(ph.key) ? 'done' : 'pending';
    const label = p.phases.find((ph) => ph.key === key)!.label;
    // The agent usually says what it will do just before it starts: keep that note under the new phase.
    const last = p.events[p.events.length - 1];
    if (this.freshNote && last && last.kind === 'note') {
      last.phase = key;
      p.events.splice(p.events.length - 1, 0, { at: last.at, phase: key, kind: 'phase', text: label });
    } else this.add('phase', label);
  }

  private add(kind: ProgressKind, text: string, extra: Partial<ProgressEvent> = {}): void {
    const p = this.progress;
    p.events.push({ at: this.now(), phase: p.phase ?? 'prepare', kind, text, ...extra });
    if (p.events.length > MAX_EVENTS) {
      // Drop the oldest notes first; findings, flows, tests and runs are what people look for.
      const i = p.events.findIndex((x) => x.kind === 'note' || x.kind === 'action');
      p.events.splice(i >= 0 ? i : 0, 1);
    }
  }

  private publish(): void {
    this.progress.updatedAt = this.now();
    this.emit(this.progress);
  }

  private target(input: Record<string, unknown>): string {
    const ref = typeof input.ref === 'string' ? input.ref : undefined;
    const named = ref ? this.opts.resolveRef?.(ref) : input.locator ? describeLocator(input.locator as LocatorSpec) : undefined;
    return named ? `the ${named}` : 'an element';
  }

  private doing(tool: string, input: Record<string, unknown>): string {
    const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
    switch (tool) {
      case 'status':
        return 'Checking the project…';
      case 'get_page':
        return s('pageId') || s('path') ? `Looking up the page ${s('pageId') || s('path')} in the app map…` : 'Reading the app map…';
      case 'get_requirement':
        return `Reading requirement ${s('requirementId').toUpperCase()}…`;
      case 'list_tests':
        return 'Checking the saved tests…';
      case 'analyze_app':
        return 'Analyzing the app’s pages…';
      case 'map_requirements':
        return 'Linking requirements to pages…';
      case 'explore_start':
        return `Opening the browser at ${s('startPath') || '/'}${input.signIn ? ' and signing in' : ''}…`;
      case 'explore_action':
        return `${this.action(input)}…`;
      case 'explore_snapshot':
        return 'Reading the page…';
      case 'explore_record_finding':
        return `Recording a problem: ${s('title')}…`;
      case 'explore_end':
        return 'Closing the browser and writing the session report…';
      case 'save_discovered_flow':
        return `Recording the flow “${s('title')}”…`;
      case 'scaffold_framework':
        return 'Setting up the Playwright framework…';
      case 'save_test':
        return `Writing a test for ${s('requirementId').toUpperCase()}${s('acId') ? ` ${s('acId').toUpperCase()}` : ''}: ${s('title')}…`;
      case 'run_tests':
        return `Running the tests${s('requirementId') ? ` for ${s('requirementId').toUpperCase()}` : s('testId') ? ` ${s('testId')}` : ''}…`;
      case 'heal_tests':
        return 'Healing broken tests…';
      default:
        return `Using ${tool.replace(/_/g, ' ')}…`;
    }
  }

  private action(input: Record<string, unknown>): string {
    const v = typeof input.value === 'string' ? input.value : '';
    const shown = secret(v) ? 'the test value' : `“${oneLine(v, 60)}”`;
    switch (input.action) {
      case 'goto':
        return `Going to ${typeof input.path === 'string' ? input.path : '/'}`;
      case 'click':
        return `Clicking ${this.target(input)}`;
      case 'fill':
        return `Typing ${shown} into ${this.target(input)}`;
      case 'select':
        return `Choosing ${shown} in ${this.target(input)}`;
      case 'check':
        return `Ticking ${this.target(input)}`;
      case 'uncheck':
        return `Unticking ${this.target(input)}`;
      case 'press':
        return `Pressing ${String(input.key ?? 'a key')}${input.ref || input.locator ? ` in ${this.target(input)}` : ''}`;
      case 'hover':
        return `Hovering over ${this.target(input)}`;
      case 'back':
        return 'Going back';
      case 'wait':
        return 'Waiting for the page';
      case 'sign_in':
        return 'Signing in with the test account';
      default:
        return `Doing ${String(input.action)}`;
    }
  }

  private done(tool: string, input: Record<string, unknown>, output: string): void {
    const p = this.progress;
    const first = output.split('\n')[0];
    const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
    switch (tool) {
      case 'explore_start': {
        const id = /Session (\S+) started/.exec(first)?.[1];
        if (id) p.sessionId = id;
        this.add('info', `Browser opened at ${s('startPath') || '/'}${id ? ' · session' : ''}`, { ref: id });
        break;
      }
      case 'explore_action': {
        const failed = /^Step \d+ FAILED/.test(first);
        const n = /^Step (\d+)/.exec(first)?.[1];
        const error = failed ? /^Error: (.*)$/m.exec(output)?.[1] : undefined;
        if (n) p.counts.steps = Math.max(p.counts.steps, Number(n));
        if (failed && !this.fed) p.counts.failedSteps++;
        this.add('action', `${n ? `${n}. ` : ''}${this.action(input)}`, { ok: !failed, detail: error ? oneLine(error, 240) : undefined });
        break;
      }
      case 'explore_record_finding': {
        const bug = /Draft bug (\S+) created/.exec(output)?.[1];
        if (!this.fed) p.counts.findings++;
        this.add('finding', s('title'), { ref: bug, ok: false, detail: `${s('severity') || 'medium'} severity · Expected: ${oneLine(s('expected'), 160)} · Actual: ${oneLine(s('actual'), 160)}` });
        break;
      }
      case 'explore_end':
        this.add('info', oneLine(first, 200), { ref: /Session (\S+) ended/.exec(first)?.[1] });
        break;
      case 'save_discovered_flow': {
        const id = /^Saved (\S+) "/.exec(first)?.[1];
        p.counts.flows++;
        const criteria = Array.isArray(input.criteria) ? input.criteria.length : 0;
        this.add('flow', s('title'), { ref: id, ok: true, detail: `${criteria} criteri${criteria === 1 ? 'on' : 'a'}${p.flowTarget ? ` · flow ${p.counts.flows} of ${p.flowTarget}` : ''}` });
        break;
      }
      case 'scaffold_framework':
        this.add('info', oneLine(first, 200), { ok: true });
        break;
      case 'save_test': {
        const id = /^Saved (\S+) in /.exec(first)?.[1];
        p.counts.tests++;
        const check = /Check run: (PASSED|FAILED|FLAKY|SKIPPED)[^\n]*/.exec(output);
        const verdict = /verdict (\S+)/.exec(check?.[0] ?? '')?.[1];
        const label = `${s('requirementId').toUpperCase()}${s('acId') ? ` ${s('acId').toUpperCase()}` : ''}: ${s('title')}`;
        if (!check) this.add('test', label, { ref: id, detail: /Not run/.test(output) ? 'Saved; not run yet (framework not installed)' : 'Saved' });
        else if (check[1] === 'PASSED') this.add('test', label, { ref: id, ok: true, detail: 'Saved; its check run passed' });
        else this.add('test', label, { ref: id, ok: false, detail: `Saved; its check run ${check[1].toLowerCase()}${verdict ? ` (${verdict})` : ''}` });
        break;
      }
      case 'run_tests': {
        const m = /^(RUN-\d+): (\d+) passed · (\d+) failed · (\d+) flaky/.exec(first);
        if (m) {
          p.counts.testsPassed += Number(m[2]);
          p.counts.testsFailed += Number(m[3]);
          const target = s('requirementId').toUpperCase() || s('testId') || 'all tests';
          this.add('run', `${target}: ${m[2]} passed, ${m[3]} failed${Number(m[4]) ? `, ${m[4]} flaky` : ''}`, { ref: m[1], ok: m[3] === '0' });
        } else this.add('run', oneLine(first, 200));
        break;
      }
      case 'heal_tests':
        this.add('info', oneLine(first, 200));
        break;
      default:
        break;
    }
  }
}

/** The short form of a job's progress, for lists. */
export function progressLine(p: JobProgress | undefined): ProgressLine | undefined {
  if (!p) return undefined;
  const i = p.phases.findIndex((ph) => ph.key === p.phase);
  return {
    phase: p.phase,
    phaseLabel: i >= 0 ? p.phases[i].label : undefined,
    step: i >= 0 ? i + 1 : undefined,
    of: p.phases.length,
    activity: p.activity,
    counts: p.counts,
    done: p.done,
    flowTarget: p.flowTarget,
  };
}
