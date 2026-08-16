/**
 * Process execution, in two shapes the loop needs:
 *
 *   - `run` streams a long-lived command's output through to the terminal and
 *     resolves with its exit code. Used for agents and `pnpm verify`, where the
 *     operator wants to watch progress.
 *   - `capture` collects stdout for a short command whose output is data, not
 *     progress. Used for `gh` and `git` reads.
 *
 * Neither ever runs through a shell, so an issue title or a branch name cannot
 * be interpreted as a command.
 */

import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process after this many milliseconds. Resolves with a non-zero code. */
  timeoutMs?: number;
  /** Called with each chunk, in addition to it being written through to stdio. */
  onChunk?: (chunk: string) => void;
}

export interface RunResult {
  code: number;
  /** The combined stdout+stderr, retained so it can be logged or fed back to an agent. */
  output: string;
  timedOut: boolean;
}

/** Run a command, streaming its output, and resolve with the exit code and captured text. */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000).unref();
          }, options.timeoutMs)
        : null;

    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      options.onChunk?.(text);
      process.stdout.write(text);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      output += `\n[spawn error] ${err.message}\n`;
      resolve({ code: 127, output, timedOut });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), output, timedOut });
    });
  });
}

export interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command silently and capture its stdout and stderr. */
export function capture(
  command: string,
  args: readonly string[],
  options: RunOptions = {}
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));

    child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr + err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
