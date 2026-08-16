/**
 * Local git, scoped to one worktree. The agent is forbidden from running git;
 * the orchestrator does it here, so the branch, the commit identity and the push
 * are all under the loop's control rather than the model's.
 */

import { capture } from './exec';

export class Git {
  constructor(readonly cwd: string) {}

  private async run(args: readonly string[]): Promise<string> {
    const { code, stdout, stderr } = await capture('git', args, { cwd: this.cwd });
    if (code !== 0) {
      throw new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`);
    }
    return stdout;
  }

  /** True when the agent produced changes worth committing. */
  async hasChanges(): Promise<boolean> {
    const status = await this.run(['status', '--porcelain']);
    return status.trim().length > 0;
  }

  async currentBranch(): Promise<string> {
    return (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  }

  /** Stage everything and commit. Commit identity comes from the worktree config. */
  async commitAll(message: string): Promise<void> {
    await this.run(['add', '-A']);
    await this.run(['commit', '-m', message]);
  }

  async push(): Promise<void> {
    const branch = await this.currentBranch();
    await this.run(['push', '-u', 'origin', branch]);
  }

  /** The commit author on HEAD, so the identity guard can verify it before pushing. */
  async headAuthorEmail(): Promise<string> {
    return (await this.run(['log', '-1', '--format=%ae'])).trim();
  }

  /** Every commit message on this branch since it diverged from origin/main. */
  async branchCommitMessages(): Promise<string[]> {
    const log = await this.run(['log', 'origin/main..HEAD', '--format=%B%x00']);
    return log
      .split('\0')
      .map((m) => m.trim())
      .filter(Boolean);
  }

  /** The unified diff of this branch against origin/main, for the secret scan. */
  async diffAgainstBase(): Promise<string> {
    try {
      const base = (await this.run(['merge-base', 'HEAD', 'origin/main'])).trim();
      return await this.run(['diff', `${base}...HEAD`]);
    } catch {
      return this.run(['diff', 'HEAD']);
    }
  }

  /** The paths this branch actually changed, to compare against what the issue declared. */
  async changedPaths(): Promise<string[]> {
    try {
      const base = (await this.run(['merge-base', 'HEAD', 'origin/main'])).trim();
      const out = await this.run(['diff', '--name-only', `${base}...HEAD`]);
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
