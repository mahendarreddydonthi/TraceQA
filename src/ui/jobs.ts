import fs from 'node:fs';
import path from 'node:path';
import { StoppedError } from '../core/proc.js';
import { listJson, nextId, now, writeJson } from '../core/store.js';
import type { Usage } from '../ai/pricing.js';
import { progressLine, type JobProgress, type ProgressLine } from '../ai/progress.js';

// Jobs started from the dashboard run one at a time (they share the browser, the test framework and the
// project files). Each keeps its full output, can be stopped, and is saved under .traceqa/jobs/.

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export interface JobRecord {
  id: string;
  kind: string;
  label: string;
  /** Uses Claude and is billed to the user's Anthropic account. */
  ai: boolean;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  log: string[];
  result?: string;
  error?: string;
  usage?: Usage;
  /** Exploration session the job is driving, for the live screenshots. */
  sessionId?: string;
  params?: Record<string, unknown>;
  /** Live progress of an AI job: phase, current activity, counts and timeline. */
  progress?: JobProgress;
}

export type JobSummary = Omit<JobRecord, 'log' | 'progress'> & { lines: number; lastLine?: string; progress?: ProgressLine };

export interface JobContext {
  signal: AbortSignal;
  log: (line: string) => void;
  setUsage: (usage: Usage) => void;
  setSession: (id: string) => void;
  setProgress: (progress: JobProgress) => void;
}

export type JobWork = (ctx: JobContext) => Promise<string>;

const MAX_LOG_LINES = 4000;

export function summarize(job: JobRecord): JobSummary {
  const { log, progress, ...rest } = job;
  return { ...rest, lines: log.length, lastLine: log[log.length - 1], progress: progressLine(progress) };
}

export class JobManager {
  private jobs: JobRecord[] = [];
  private queue: { job: JobRecord; work: JobWork }[] = [];
  private current?: { job: JobRecord; controller: AbortController };
  private loadedFrom?: string;
  private saveTimer?: NodeJS.Timeout;

  /** dir() is the jobs folder, or undefined while the project is not set up yet. */
  constructor(
    private dir: () => string | undefined,
    private emit: (event: 'job' | 'job-log' | 'job-progress', data: unknown) => void,
  ) {}

  /** Loads saved jobs once per project. Jobs left running by a dashboard that stopped are marked failed. */
  private ensureLoaded(): void {
    const dir = this.dir();
    if (!dir || this.loadedFrom === dir) return;
    this.loadedFrom = dir;
    const saved = listJson<JobRecord>(dir);
    for (const j of saved) {
      if (j.status === 'running' || j.status === 'queued') {
        j.status = 'failed';
        j.error = 'The dashboard stopped before this job finished.';
        j.finishedAt = j.finishedAt ?? now();
        this.persist(j);
      }
    }
    const live = new Set(this.jobs.map((j) => j.id));
    this.jobs = [...saved.filter((j) => !live.has(j.id)), ...this.jobs];
  }

  list(): JobSummary[] {
    this.ensureLoaded();
    return this.jobs.map(summarize).reverse();
  }

  get(id: string): JobRecord | undefined {
    this.ensureLoaded();
    return this.jobs.find((j) => j.id === id.toUpperCase());
  }

  busy(): boolean {
    return !!this.current || this.queue.length > 0;
  }

  enqueue(kind: string, label: string, opts: { ai?: boolean; params?: Record<string, unknown> }, work: JobWork): JobRecord {
    this.ensureLoaded();
    const job: JobRecord = {
      id: nextId('JOB', this.jobs.map((j) => j.id), 3),
      kind,
      label,
      ai: !!opts.ai,
      status: 'queued',
      createdAt: now(),
      log: [],
      params: opts.params,
    };
    this.jobs.push(job);
    this.queue.push({ job, work });
    this.persist(job);
    this.emit('job', summarize(job));
    void this.pump();
    return job;
  }

  /** Stops a running job (its browser or test process is closed) or removes a queued one. */
  stop(id: string): JobRecord {
    const job = this.get(id);
    if (!job) throw Object.assign(new Error(`No job ${id}.`), { status: 404 });
    if (this.current?.job === job) {
      job.log.push('Stopping …');
      this.emit('job-log', { id: job.id, line: 'Stopping …' });
      this.current.controller.abort();
      return job;
    }
    const i = this.queue.findIndex((q) => q.job === job);
    if (i >= 0) {
      this.queue.splice(i, 1);
      job.status = 'stopped';
      job.finishedAt = now();
      this.persist(job);
      this.emit('job', summarize(job));
      return job;
    }
    throw Object.assign(new Error(`${job.id} has already ${job.status === 'done' ? 'finished' : job.status}.`), { status: 409 });
  }

  private async pump(): Promise<void> {
    if (this.current) return;
    const next = this.queue.shift();
    if (!next) return;
    const { job, work } = next;
    const controller = new AbortController();
    this.current = { job, controller };
    job.status = 'running';
    job.startedAt = now();
    this.persist(job);
    this.emit('job', summarize(job));

    const ctx: JobContext = {
      signal: controller.signal,
      log: (line) => {
        for (const l of String(line).split('\n')) {
          if (job.log.length >= MAX_LOG_LINES) job.log.splice(0, 500, '… (earlier lines trimmed)');
          job.log.push(l);
          this.emit('job-log', { id: job.id, line: l });
        }
        this.persistSoon(job);
      },
      setUsage: (usage) => {
        job.usage = usage;
        this.emit('job', summarize(job));
      },
      setSession: (sessionId) => {
        job.sessionId = sessionId;
        this.emit('job', summarize(job));
      },
      setProgress: (progress) => {
        job.progress = progress;
        this.emit('job-progress', { id: job.id, progress });
        this.persistSoon(job);
      },
    };

    try {
      job.result = await work(ctx);
      job.status = controller.signal.aborted ? 'stopped' : 'done';
    } catch (err) {
      if (err instanceof StoppedError || controller.signal.aborted) {
        job.status = 'stopped';
        job.error = 'Stopped by a person.';
      } else {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      job.finishedAt = now();
      this.current = undefined;
      clearTimeout(this.saveTimer);
      this.persist(job);
      this.emit('job', summarize(job));
      void this.pump();
    }
  }

  private persistSoon(job: JobRecord): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.persist(job);
    }, 2000);
  }

  private persist(job: JobRecord): void {
    const dir = this.dir();
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeJson(path.join(dir, `${job.id}.json`), job);
    } catch {
      // History is a convenience; a failed write must not break the job.
    }
  }
}
