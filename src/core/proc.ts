import { spawn, type ChildProcess } from 'node:child_process';

/** Thrown when someone presses Stop on a job (or the signal is aborted another way). */
export class StoppedError extends Error {
  constructor(message = 'Stopped.') {
    super(message);
    this.name = 'StoppedError';
  }
}

export function throwIfStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StoppedError();
}

/** Ends a child process and everything it started (Playwright starts browsers; npm starts node). */
export function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
  }
}

export interface ProcessResult {
  code: number;
  output: string;
}

/** Runs a command, streams its output line by line, and kills it when the signal aborts. */
export function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; shell?: boolean; signal?: AbortSignal; onLine?: (line: string) => void },
): Promise<ProcessResult> {
  throwIfStopped(opts.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, shell: opts.shell });
    let output = '';
    let partial = '';
    const onData = (d: Buffer) => {
      const text = d.toString();
      output += text;
      if (!opts.onLine) return;
      partial += text;
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) opts.onLine(l.replace(/\u001b\[[0-9;]*m/g, ''));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const abort = () => killTree(child);
    opts.signal?.addEventListener('abort', abort, { once: true });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', abort);
      if (partial.trim() && opts.onLine) opts.onLine(partial);
      if (opts.signal?.aborted) reject(new StoppedError());
      else resolve({ code: code ?? 1, output });
    });
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', abort);
      resolve({ code: 1, output: output + String(err) });
    });
  });
}
