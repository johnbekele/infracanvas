/**
 * Lane B: Codex, headless via `codex exec`.
 *
 * `--sandbox workspace-write` lets it edit the worktree and run tests, and the
 * network is enabled because the tasks it takes (the gates, CI tooling) must run
 * `pnpm`, which reaches the registry. `--skip-git-repo-check` keeps it from
 * refusing to run inside a linked worktree.
 */

import { run } from '../exec';
import { parseEnvelope, type AgentAdapter, type AgentRunResult } from './index';

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;

  async run(prompt: string, options: { cwd: string; timeoutMs: number }): Promise<AgentRunResult> {
    const result = await run(
      'codex',
      [
        'exec',
        '--cd',
        options.cwd,
        '--sandbox',
        'workspace-write',
        '-c',
        'sandbox_workspace_write={network_access=true}',
        '--skip-git-repo-check',
        prompt,
      ],
      { cwd: options.cwd, timeoutMs: options.timeoutMs }
    );
    return {
      envelope: parseEnvelope(result.output),
      output: result.output,
      code: result.code,
      timedOut: result.timedOut,
    };
  }
}
