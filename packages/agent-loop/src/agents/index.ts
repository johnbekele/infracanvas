/**
 * The three coding agents behind one interface. A lane binds to an adapter, and
 * the supervisor drives all three identically: prompt in, envelope out, working
 * directory is the worktree. Adding a fourth agent is one more file here.
 */

import type { AgentEnvelope, AgentId } from '../types';

export interface AgentRunResult {
  /** The parsed final envelope, or null if the agent printed none. */
  envelope: AgentEnvelope | null;
  /** The full captured output, retained for the run log and repair prompts. */
  output: string;
  code: number;
  timedOut: boolean;
}

export interface AgentAdapter {
  readonly id: AgentId;
  run(prompt: string, options: { cwd: string; timeoutMs: number }): Promise<AgentRunResult>;
}

const VALID_TYPES = new Set([
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
]);

/**
 * Pull the agent's final JSON envelope out of its output. The prompt asks for a
 * single fenced `json` block as the last message; the last such block wins, so
 * a `json` example quoted earlier in the transcript does not shadow the real
 * one. A malformed or absent block yields null, which the caller treats as "the
 * agent did not report structured completion".
 */
export function parseEnvelope(output: string): AgentEnvelope | null {
  const blocks = [...output.matchAll(/```json\s*\n([\s\S]*?)\n```/gi)];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(blocks[i][1]) as Partial<AgentEnvelope>;
      if (typeof parsed.type !== 'string' || typeof parsed.subject !== 'string') continue;
      return {
        type: (VALID_TYPES.has(parsed.type) ? parsed.type : 'chore') as AgentEnvelope['type'],
        scope: typeof parsed.scope === 'string' ? parsed.scope : '',
        subject: parsed.subject,
        notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
        blocked: typeof parsed.blocked === 'string' ? parsed.blocked : null,
      };
    } catch {
      continue;
    }
  }
  return null;
}
