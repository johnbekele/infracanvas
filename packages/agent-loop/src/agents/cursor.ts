/**
 * Lane C: Cursor, headless via `cursor-agent -p`.
 *
 * `--force` runs without the per-action confirmation that has no terminal to
 * answer it unattended. The CLI is installed separately (see docs/ORCHESTRATION.md);
 * if it is absent the adapter surfaces the spawn failure rather than hanging.
 */

import { run } from '../exec';
import { parseEnvelope, type AgentAdapter, type AgentRunResult } from './index';

export class CursorAdapter implements AgentAdapter {
  readonly id = 'cursor' as const;

  async run(prompt: string, options: { cwd: string; timeoutMs: number }): Promise<AgentRunResult> {
    const result = await run('cursor-agent', ['-p', prompt, '--force', '--output-format', 'text'], {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
    });
    return {
      envelope: parseEnvelope(result.output),
      output: result.output,
      code: result.code,
      timedOut: result.timedOut,
    };
  }
}
