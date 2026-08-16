/**
 * Lane A: Claude Code, headless.
 *
 * `--permission-mode bypassPermissions` is required for an unattended run: the
 * default prompts for each tool use and would block forever with no terminal to
 * answer it. The worktree is the only writable surface, and the orchestrator —
 * not the agent — performs every git and GitHub action, so the blast radius of
 * bypassing prompts is confined to files the loop is about to review anyway.
 */

import { run } from '../exec';
import { parseEnvelope, type AgentAdapter, type AgentRunResult } from './index';

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const;

  async run(prompt: string, options: { cwd: string; timeoutMs: number }): Promise<AgentRunResult> {
    const result = await run(
      'claude',
      ['-p', prompt, '--permission-mode', 'bypassPermissions', '--add-dir', options.cwd],
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
