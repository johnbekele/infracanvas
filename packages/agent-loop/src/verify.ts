/**
 * Running `pnpm verify` in the worktree and keeping the result. This is the
 * loop's authoritative verdict on a change: the agent may claim it is done, but
 * only the same command CI runs decides whether it is. Its tail is also the
 * evidence pasted into the pull request's Verification section.
 */

import { run } from './exec';
import { type FileMutex } from './mutex';

export interface VerifyResult {
  ok: boolean;
  /** Full captured output, for the run log and repair prompts. */
  output: string;
  /** The last lines, for the pull request body. */
  tail: string;
  timedOut: boolean;
}

const TAIL_LINES = 40;

function tailOf(output: string, lines = TAIL_LINES): string {
  return output.split('\n').slice(-lines).join('\n').trim();
}

export interface VerifyOptions {
  cwd: string;
  integration: boolean;
  timeoutMs: number;
  /** Serialises integration runs across lanes; omitted for static-only runs. */
  integrationMutex?: FileMutex;
}

/** Run `pnpm verify`, optionally with the integration suites behind the shared mutex. */
export async function runVerify(options: VerifyOptions): Promise<VerifyResult> {
  const args = ['verify'];
  if (options.integration) args.push('--integration');

  const exec = () => run('pnpm', args, { cwd: options.cwd, timeoutMs: options.timeoutMs });
  const result =
    options.integration && options.integrationMutex
      ? await options.integrationMutex.withLock(exec)
      : await exec();

  return {
    ok: result.code === 0,
    output: result.output,
    tail: tailOf(result.output),
    timedOut: result.timedOut,
  };
}
