/**
 * Every GitHub read and write the loop performs. Concentrated here so that the
 * decision modules stay pure and testable, and so there is exactly one place
 * that talks to `gh`. The agents never reach this file: the orchestrator owns
 * all GitHub state.
 *
 * `gh` reads its token from the OS keyring, which a sandboxed process cannot
 * reach, so the loop must run outside any sandbox (see AGENTS.md).
 */

import { capture } from './exec';
import type { CheckRun, Issue, OpenPullRequest, Tier } from './types';

const AGENT_LOOP_LABEL = 'agent-loop';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GhError extends Error {
  constructor(
    message: string,
    readonly stderr: string
  ) {
    super(message);
    this.name = 'GhError';
  }
}

export class GitHub {
  constructor(private readonly repo: string) {}

  private async json<T>(args: readonly string[]): Promise<T> {
    const { code, stdout, stderr } = await capture('gh', args);
    if (code !== 0) {
      throw new GhError(`gh ${args.slice(0, 3).join(' ')} failed (exit ${code})`, stderr);
    }
    return JSON.parse(stdout) as T;
  }

  private async plain(args: readonly string[]): Promise<string> {
    const { code, stdout, stderr } = await capture('gh', args);
    if (code !== 0) {
      throw new GhError(`gh ${args.slice(0, 3).join(' ')} failed (exit ${code})`, stderr);
    }
    return stdout;
  }

  /** Open issues labelled agent-ready, with the body the eligibility check needs. */
  async listAgentReadyIssues(): Promise<Issue[]> {
    type Raw = {
      number: number;
      title: string;
      body: string;
      state: string;
      labels: { name: string }[];
    };
    const raw = await this.json<Raw[]>([
      'issue',
      'list',
      '--repo',
      this.repo,
      '--state',
      'open',
      '--label',
      'agent-ready',
      '--limit',
      '200',
      '--json',
      'number,title,body,state,labels',
    ]);
    return raw.map((r) => ({
      number: r.number,
      title: r.title,
      body: r.body ?? '',
      state: r.state.toLowerCase() === 'closed' ? 'closed' : 'open',
      labels: r.labels.map((l) => l.name),
    }));
  }

  /** The set of closed issue numbers, for the dependency check. */
  async closedIssueNumbers(): Promise<Set<number>> {
    type Raw = { number: number };
    const raw = await this.json<Raw[]>([
      'issue',
      'list',
      '--repo',
      this.repo,
      '--state',
      'closed',
      '--limit',
      '800',
      '--json',
      'number',
    ]);
    return new Set(raw.map((r) => r.number));
  }

  /** Open pull requests, tagged with whether the loop opened them. */
  async listOpenPullRequests(): Promise<OpenPullRequest[]> {
    type Raw = { number: number; body: string; headRefName: string; labels: { name: string }[] };
    const raw = await this.json<Raw[]>([
      'pr',
      'list',
      '--repo',
      this.repo,
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number,body,headRefName,labels',
    ]);
    return raw.map((r) => ({
      number: r.number,
      body: r.body ?? '',
      headRefName: r.headRefName,
      isAgentLoop: r.labels.some((l) => l.name === AGENT_LOOP_LABEL),
    }));
  }

  /**
   * Open pull requests with the fields the merge train selects on: base branch,
   * draft flag, and labels. Separate from {@link listOpenPullRequests}, which the
   * issue loop uses and which carries the body for its dependency parsing.
   */
  async listOpenPullRequestsDetailed(): Promise<
    {
      number: number;
      title: string;
      headRefName: string;
      baseRefName: string;
      isDraft: boolean;
      labels: string[];
    }[]
  > {
    type Raw = {
      number: number;
      title: string;
      headRefName: string;
      baseRefName: string;
      isDraft: boolean;
      labels: { name: string }[];
    };
    const raw = await this.json<Raw[]>([
      'pr',
      'list',
      '--repo',
      this.repo,
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number,title,headRefName,baseRefName,isDraft,labels',
    ]);
    return raw.map((r) => ({
      number: r.number,
      title: r.title,
      headRefName: r.headRefName,
      baseRefName: r.baseRefName,
      isDraft: r.isDraft,
      labels: r.labels.map((l) => l.name),
    }));
  }

  async issueBody(issue: number): Promise<string> {
    const raw = await this.json<{ body: string }>([
      'issue',
      'view',
      String(issue),
      '--repo',
      this.repo,
      '--json',
      'body',
    ]);
    return raw.body ?? '';
  }

  async addLabels(issue: number, labels: readonly string[]): Promise<void> {
    const args = ['issue', 'edit', String(issue), '--repo', this.repo];
    for (const label of labels) args.push('--add-label', label);
    await this.plain(args);
  }

  async removeLabels(issue: number, labels: readonly string[]): Promise<void> {
    const args = ['issue', 'edit', String(issue), '--repo', this.repo];
    for (const label of labels) args.push('--remove-label', label);
    // A label that is not applied makes gh exit non-zero; that is not an error worth failing on.
    await capture('gh', args);
  }

  async assign(issue: number, user: string): Promise<void> {
    await capture('gh', [
      'issue',
      'edit',
      String(issue),
      '--repo',
      this.repo,
      '--add-assignee',
      user,
    ]);
  }

  async comment(issue: number, body: string): Promise<void> {
    await this.plain(['issue', 'comment', String(issue), '--repo', this.repo, '--body', body]);
  }

  /**
   * Ensure the label every loop-opened PR carries exists, so `pr create --label`
   * does not fail on a fresh repository. `--force` makes it idempotent: it
   * creates the label or updates it in place, and never errors on a re-run.
   */
  async ensureAgentLoopLabel(): Promise<void> {
    await this.plain([
      'label',
      'create',
      AGENT_LOOP_LABEL,
      '--repo',
      this.repo,
      '--color',
      '5319E7',
      '--description',
      'Opened by the autonomous agent loop',
      '--force',
    ]);
  }

  /** Create a pull request and return its number. */
  async createPullRequest(input: {
    head: string;
    title: string;
    body: string;
    tier: Tier;
  }): Promise<number> {
    await this.ensureAgentLoopLabel();
    await this.plain([
      'pr',
      'create',
      '--repo',
      this.repo,
      '--head',
      input.head,
      '--base',
      'main',
      '--title',
      input.title,
      '--body',
      input.body,
      '--label',
      AGENT_LOOP_LABEL,
    ]);
    const view = await this.json<{ number: number }>([
      'pr',
      'view',
      input.head,
      '--repo',
      this.repo,
      '--json',
      'number',
    ]);
    return view.number;
  }

  async pullRequestChecks(pr: number): Promise<CheckRun[]> {
    type Raw = { name: string; bucket: string };
    // `gh pr checks` exits non-zero when any check is failing or pending, which
    // is data rather than an error here, so its output is read regardless.
    const { stdout } = await capture('gh', [
      'pr',
      'checks',
      String(pr),
      '--repo',
      this.repo,
      '--json',
      'name,bucket',
    ]);
    if (!stdout.trim()) return [];
    const raw = JSON.parse(stdout) as Raw[];
    return raw.map((r) => ({ name: r.name, state: bucketToState(r.bucket) }));
  }

  async pullRequestState(pr: number): Promise<{
    mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
    /** GitHub's composite state: BEHIND means the branch must be updated before merge. */
    mergeStateStatus: string;
    isDraft: boolean;
    labels: string[];
  }> {
    const raw = await this.json<{
      mergeable: string;
      mergeStateStatus: string;
      isDraft: boolean;
      labels: { name: string }[];
    }>([
      'pr',
      'view',
      String(pr),
      '--repo',
      this.repo,
      '--json',
      'mergeable,mergeStateStatus,isDraft,labels',
    ]);
    const mergeable =
      raw.mergeable === 'MERGEABLE' || raw.mergeable === 'CONFLICTING' ? raw.mergeable : 'UNKNOWN';
    return {
      mergeable,
      mergeStateStatus: raw.mergeStateStatus ?? 'UNKNOWN',
      isDraft: raw.isDraft,
      labels: raw.labels.map((l) => l.name),
    };
  }

  /**
   * Update a PR branch with its base, for the strict-status-checks case where a
   * sibling merge left it behind. Best-effort: a 422 ("already up to date" or a
   * transient race) is not fatal, the caller re-reads the merge state either way.
   */
  async updateBranch(pr: number): Promise<void> {
    await capture('gh', ['api', '-X', 'PUT', `repos/${this.repo}/pulls/${pr}/update-branch`]);
  }

  /**
   * Like {@link pullRequestState}, but waits out GitHub's asynchronous
   * mergeability computation. Right after a push or a branch update, `mergeable`
   * is reported UNKNOWN for a few seconds until the background job finishes;
   * merging on UNKNOWN wrongly gives up on a PR that is about to be mergeable.
   */
  async settledPullRequestState(
    pr: number,
    opts: { timeoutMs?: number; pollMs?: number } = {}
  ): ReturnType<GitHub['pullRequestState']> {
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const pollMs = opts.pollMs ?? 6_000;
    const deadline = Date.now() + timeoutMs;
    let state = await this.pullRequestState(pr);
    while (state.mergeable === 'UNKNOWN' && Date.now() < deadline) {
      await delay(pollMs);
      state = await this.pullRequestState(pr);
    }
    return state;
  }

  /** Count of unresolved review threads, via GraphQL since REST does not expose it. */
  async unresolvedThreadCount(pr: number): Promise<number> {
    const [owner, name] = this.repo.split('/');
    const query = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){nodes{isResolved}}}}}`;
    const raw = await this.json<{
      data: {
        repository: { pullRequest: { reviewThreads: { nodes: { isResolved: boolean }[] } } };
      };
    }>([
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `pr=${pr}`,
    ]);
    return raw.data.repository.pullRequest.reviewThreads.nodes.filter((n) => !n.isResolved).length;
  }

  /** The failing check's job log, so a repair prompt has the actual error. */
  async failingCheckLog(pr: number): Promise<string> {
    const checks = await this.pullRequestChecks(pr);
    const failing = checks.find((c) => c.state === 'fail');
    if (!failing) return '';
    // `gh run` needs a run id; the simplest portable path is the PR's failed
    // check annotations, which `gh pr checks` links. Fall back to the names.
    const { stdout } = await capture('gh', [
      'pr',
      'checks',
      String(pr),
      '--repo',
      this.repo,
      '--json',
      'name,bucket,link,description',
    ]);
    return `Failing check: ${failing.name}\n\n${stdout}`;
  }

  async squashMerge(pr: number): Promise<void> {
    await this.plain([
      'pr',
      'merge',
      String(pr),
      '--repo',
      this.repo,
      '--squash',
      '--delete-branch',
    ]);
  }
}

function bucketToState(bucket: string): CheckRun['state'] {
  switch (bucket) {
    case 'pass':
      return 'pass';
    case 'fail':
    case 'cancel':
      return 'fail';
    case 'skipping':
      return 'skipping';
    default:
      return 'pending';
  }
}
