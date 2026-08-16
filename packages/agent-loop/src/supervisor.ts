/**
 * The state machine, one issue at a time, and the scheduler that runs three of
 * them at once. Every irreversible action — the claim, the commit, the push,
 * the merge — is taken here in orchestrator code, never by an agent. That is
 * the whole safety model: a model mistake can waste a worktree, but it cannot
 * merge itself.
 */

import { existsSync } from 'node:fs';

import type { AgentAdapter } from './agents';
import { isBlocked } from './prompt';
import { watchChecks } from './ci';
import { type ClaimStore } from './claim';
import type { LoopConfig } from './config';
import { LANE_PATHS } from './config';
import { declaredPaths } from './conflicts';
import { buildPullRequestBody, conventionalTitle } from './deliver';
import { hasAiTrailer, hasSecret, scopeRespected } from './facts';
import { Git } from './git';
import type { GitHub } from './gh';
import * as log from './log';
import { mergeDecision } from './merge';
import { buildRepairPrompt, buildTaskPrompt } from './prompt';
import { RunReporter } from './report';
import { evaluate, laneForIssue, selectEligible, type QueueContext } from './queue';
import type { FileMutex } from './mutex';
import type { AgentEnvelope, Issue, Lane, Tier } from './types';
import { runVerify } from './verify';
import type { Worktrees } from './worktree';

const EXPECTED_EMAIL = '164889902+johnbekele@users.noreply.github.com';

export interface SupervisorDeps {
  github: GitHub;
  worktrees: Worktrees;
  claims: ClaimStore;
  adapters: Record<Lane, AgentAdapter>;
  integrationMutex: FileMutex;
}

export interface RunOptions {
  /** Restrict to a single lane, for a controlled first run. */
  onlyLane?: Lane;
  /** Get to a green, mergeable PR but do not merge. For dry runs. */
  noMerge?: boolean;
  /** Take at most this many issues this pass. */
  max?: number;
}

export type IssueOutcome = 'merged' | 'delivered' | 'blocked' | 'failed';

export class Supervisor {
  /** Issues currently held, so a signal can release them before the process dies. */
  private readonly active = new Map<number, { slug: string }>();

  constructor(
    private readonly config: LoopConfig,
    private readonly deps: SupervisorDeps
  ) {}

  private stopRequested(): boolean {
    return existsSync(this.config.killSwitch);
  }

  /**
   * Release every held claim and remove its worktree. Called from the CLI's
   * signal handlers, because a SIGTERM or SIGINT skips the per-issue `finally`
   * blocks — Node does not run them on a signal — and a claim that outlives the
   * process would strand its issue behind a `status:in-progress` label nothing
   * is working.
   */
  async shutdown(): Promise<void> {
    const held = [...this.active.entries()];
    for (const [issue, { slug }] of held) {
      log.warn(`shutdown: releasing #${issue}`);
      await this.deps.claims
        .release(issue)
        .catch((e) => log.warn(`release failed: ${describe(e)}`));
      await this.deps.worktrees
        .remove(slug)
        .catch((e) => log.warn(`worktree remove failed: ${describe(e)}`));
      this.active.delete(issue);
    }
  }

  /** Build the live eligibility context from GitHub and the local claims. */
  private async queueContext(): Promise<QueueContext> {
    const [closedIssues, openPullRequests] = await Promise.all([
      this.deps.github.closedIssueNumbers(),
      this.deps.github.listOpenPullRequests(),
    ]);
    return {
      closedIssues,
      claimedIssues: this.deps.claims.claimedIssues(),
      openPullRequests,
      runningPaths: this.deps.claims.runningPaths(),
    };
  }

  /** One scheduling pass: pick eligible issues, assign lanes, run them concurrently. */
  async runOnce(options: RunOptions = {}): Promise<Map<number, IssueOutcome>> {
    const outcomes = new Map<number, IssueOutcome>();
    if (this.stopRequested()) {
      log.warn('kill switch present; not starting new work');
      return outcomes;
    }

    const issues = await this.deps.github.listAgentReadyIssues();
    const ctx = await this.queueContext();
    const eligible = selectEligible(issues, ctx);

    // Bin by lane, respecting an onlyLane restriction, and take one per lane per
    // pass so the three tools progress together rather than one draining first.
    const perLane = new Map<Lane, Issue>();
    for (const issue of eligible) {
      const lane = laneForIssue(issue);
      if (!lane) continue;
      if (options.onlyLane && lane !== options.onlyLane) continue;
      if (!perLane.has(lane)) perLane.set(lane, issue);
    }

    let picked = [...perLane.entries()];
    if (options.max !== undefined) picked = picked.slice(0, options.max);
    picked = picked.slice(0, this.config.budgets.concurrency);

    if (picked.length === 0) {
      log.info('no eligible issues this pass');
      return outcomes;
    }

    const runs = picked.map(async ([lane, issue]) => {
      const outcome = await this.processIssue(issue, lane, options);
      outcomes.set(issue.number, outcome);
    });
    await Promise.all(runs);
    return outcomes;
  }

  /** Repeat scheduling passes until the queue empties or the kill switch appears. */
  async runForever(options: RunOptions = {}): Promise<void> {
    for (;;) {
      if (this.stopRequested()) {
        log.warn('kill switch present; stopping');
        return;
      }
      const outcomes = await this.runOnce(options);
      if (outcomes.size === 0) {
        log.info('queue idle; sleeping 60s');
        await sleep(60_000);
      }
    }
  }

  /** The per-issue state machine. Always releases the claim and removes the tree, on every path. */
  private async processIssue(issue: Issue, lane: Lane, options: RunOptions): Promise<IssueOutcome> {
    const agent = this.deps.adapters[lane];
    const slug = slugify(issue);
    const branch = `agent/${issue.number}-${slug}`;
    const tier = tierFromLabels(issue.labels);
    const paths = declaredPaths(issue.body);

    log.banner(`#${issue.number} [lane ${lane} / ${agent.id}] ${issue.title}`);

    const reporter = new RunReporter(`${this.config.stateDir}/runs`, {
      issue: issue.number,
      agent: agent.id,
      lane,
      branch,
      worktreePath: this.deps.worktrees.pathFor(slug),
    });

    let claimed = false;
    let treeCreated = false;

    try {
      await this.deps.claims.acquire({
        issue: issue.number,
        lane,
        agent: agent.id,
        branch,
        slug,
        worktree: this.deps.worktrees.pathFor(slug),
        paths,
        startedAt: new Date().toISOString(),
      });
      claimed = true;
      this.active.set(issue.number, { slug });
      reporter.event('info', 'claim', `claimed #${issue.number}`);

      if (this.stopRequested()) return await this.abandon(issue, reporter, 'kill switch');

      reporter.event('info', 'worktree', `creating worktree ${slug}`);
      const tree = await this.deps.worktrees.create(slug, branch);
      treeCreated = true;
      const git = new Git(tree.path);

      // --- Implement, then verify, repairing locally within budget ----------
      let verifyTail = '';
      let green = false;
      let envelope: AgentEnvelope = {
        type: 'chore',
        scope: scopeForLane(lane),
        subject: issue.title,
        blocked: null,
      };
      const ownedPaths = LANE_PATHS[lane];

      for (let attempt = 0; attempt <= this.config.budgets.localRepairs; attempt += 1) {
        if (this.stopRequested()) return await this.abandon(issue, reporter, 'kill switch');

        const prompt =
          attempt === 0
            ? buildTaskPrompt({ issue, lane, ownedPaths })
            : buildRepairPrompt({ issue, kind: 'verify', failureOutput: verifyTail });

        reporter.event('info', attempt === 0 ? 'implement' : 'repair', `agent pass ${attempt + 1}`);
        const runResult = await agent.run(prompt, {
          cwd: tree.path,
          timeoutMs: this.config.budgets.agentMs,
        });

        // Keep the latest envelope the agent reported; it names the commit.
        if (runResult.envelope) envelope = runResult.envelope;

        if (runResult.envelope && isBlocked(runResult.envelope)) {
          return await this.block(
            issue,
            reporter,
            `agent reported blocked: ${runResult.envelope.blocked}`
          );
        }
        if (runResult.timedOut) {
          reporter.event('warn', 'implement', 'agent pass timed out');
        }
        if (!(await git.hasChanges())) {
          return await this.block(issue, reporter, 'agent produced no changes');
        }

        reporter.event('info', 'verify', 'running pnpm verify');
        const verify = await runVerify({
          cwd: tree.path,
          integration: this.config.integration,
          timeoutMs: this.config.budgets.verifyMs,
          integrationMutex: this.deps.integrationMutex,
        });
        verifyTail = verify.tail;
        if (verify.ok) {
          green = true;
          break;
        }
        reporter.event('warn', 'verify', `verify failed on attempt ${attempt + 1}`);
      }

      if (!green) {
        return await this.block(
          issue,
          reporter,
          'pnpm verify never passed within the repair budget'
        );
      }

      // --- Prove the checklist from the diff, not the model's word ----------
      const [changedPaths, diff, messages] = await Promise.all([
        git.changedPaths(),
        git.diffAgainstBase(),
        git.branchCommitMessages(),
      ]);

      const facts = {
        scopeRespected: scopeRespected(changedPaths, paths),
        noSecrets: !hasSecret(diff),
        noAiTrailers: !hasAiTrailer(messages),
      };
      if (!facts.noSecrets) {
        return await this.block(issue, reporter, 'diff contains something resembling a secret');
      }

      // --- Commit under the loop's identity, then push ----------------------
      const title = conventionalTitle(envelope);
      reporter.event('info', 'deliver', `committing as: ${title}`);
      await git.commitAll(title);

      const author = await git.headAuthorEmail();
      if (author !== EXPECTED_EMAIL) {
        return await this.block(
          issue,
          reporter,
          `commit identity is ${author}, not the personal account`
        );
      }

      await git.push();
      reporter.event('info', 'deliver', 'pushed branch');

      const body = buildPullRequestBody({
        issue,
        envelope,
        tier,
        verificationOutput: verifyTail,
        facts,
      });
      const prNumber = await this.deps.github.createPullRequest({
        head: branch,
        title,
        body,
        tier,
      });
      reporter.setPr(prNumber);
      reporter.event('info', 'deliver', `opened PR #${prNumber}`);

      // --- Watch CI, repairing within budget --------------------------------
      const ciGreen = await this.driveCi(issue, reporter, git, prNumber);

      if (!ciGreen) {
        return await this.block(issue, reporter, 'CI never went green within the repair budget');
      }

      if (options.noMerge || !this.config.mergeAllTiers) {
        reporter.event('info', 'merge', 'merge skipped by configuration; PR left green');
        reporter.finish('succeeded');
        return 'delivered';
      }

      // --- Merge, only when the predicate says so ---------------------------
      const merged = await this.tryMerge(reporter, prNumber);
      reporter.finish(merged ? 'succeeded' : 'failed');
      return merged ? 'merged' : 'delivered';
    } catch (err) {
      log.error(`#${issue.number} errored: ${describe(err)}`);
      reporter.event('error', 'blocked', describe(err));
      reporter.finish('failed');
      return 'failed';
    } finally {
      if (claimed) {
        await this.deps.claims
          .release(issue.number)
          .catch((e) => log.warn(`release failed: ${describe(e)}`));
      }
      if (treeCreated) {
        await this.deps.worktrees
          .remove(slug)
          .catch((e) => log.warn(`worktree remove failed: ${describe(e)}`));
      }
      this.active.delete(issue.number);
    }
  }

  private async driveCi(
    issue: Issue,
    reporter: RunReporter,
    git: Git,
    prNumber: number
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= this.config.budgets.ciRepairs; attempt += 1) {
      if (this.stopRequested()) return false;
      reporter.event('info', 'watch-ci', `watching checks (attempt ${attempt + 1})`);
      const watch = await watchChecks(this.deps.github, prNumber, {
        timeoutMs: this.config.budgets.ciMs,
        pollMs: 15_000,
      });
      const failing = watch.checks.filter((c) => c.state === 'fail');
      if (watch.settled && failing.length === 0) return true;
      if (!watch.settled) {
        reporter.event('warn', 'watch-ci', 'checks did not settle before the deadline');
        return false;
      }
      if (attempt === this.config.budgets.ciRepairs) break;

      const failLog = await this.deps.github.failingCheckLog(prNumber);
      reporter.event('warn', 'repair', `CI red: ${failing.map((c) => c.name).join(', ')}`);
      const lane = laneForIssue(issue);
      const agent = lane ? this.deps.adapters[lane] : null;
      if (!agent) return false;
      await agent.run(buildRepairPrompt({ issue, kind: 'ci', failureOutput: failLog }), {
        cwd: git.cwd,
        timeoutMs: this.config.budgets.agentMs,
      });
      if (await git.hasChanges()) {
        await git.commitAll(`fix: address failing CI on #${issue.number}`);
        await git.push();
      }
    }
    return false;
  }

  private async tryMerge(reporter: RunReporter, prNumber: number): Promise<boolean> {
    const [state, checks, unresolved] = await Promise.all([
      this.deps.github.pullRequestState(prNumber),
      this.deps.github.pullRequestChecks(prNumber),
      this.deps.github.unresolvedThreadCount(prNumber),
    ]);
    const decision = mergeDecision({
      mergeable: state.mergeable,
      checks,
      unresolvedThreads: unresolved,
      isAgentLoop: true,
      isDraft: state.isDraft,
    });
    if (!decision.merge) {
      reporter.event('warn', 'merge', `not merging: ${decision.reason}`);
      return false;
    }
    if (state.labels.includes('tier:1')) {
      reporter.event('warn', 'merge', 'merging a tier:1 PR unreviewed, per configuration');
    }
    await this.deps.github.squashMerge(prNumber);
    reporter.event('info', 'merge', `merged PR #${prNumber}`);
    return true;
  }

  private async block(issue: Issue, reporter: RunReporter, reason: string): Promise<IssueOutcome> {
    log.warn(`#${issue.number} blocked: ${reason}`);
    reporter.event('error', 'blocked', reason);
    await this.deps.github
      .comment(
        issue.number,
        `The agent loop could not complete this issue automatically.\n\nReason: ${reason}\n\nReleasing the claim and marking it \`status:blocked\` for a human to look at.`
      )
      .catch(() => undefined);
    await this.deps.github.addLabels(issue.number, ['status:blocked']).catch(() => undefined);
    reporter.finish('failed');
    return 'blocked';
  }

  private async abandon(
    issue: Issue,
    reporter: RunReporter,
    reason: string
  ): Promise<IssueOutcome> {
    log.warn(`#${issue.number} abandoned: ${reason}`);
    reporter.event('warn', 'blocked', `abandoned: ${reason}`);
    reporter.finish('abandoned');
    return 'failed';
  }

  /** Expose the single-issue eligibility verdict, for the CLI's explain mode. */
  async explain(issueNumber: number): Promise<string> {
    const issues = await this.deps.github.listAgentReadyIssues();
    const issue = issues.find((i) => i.number === issueNumber);
    if (!issue) return `#${issueNumber} is not open and agent-ready`;
    const ctx = await this.queueContext();
    const verdict = evaluate(issue, ctx);
    return verdict.eligible
      ? `#${issueNumber} is eligible (lane ${laneForIssue(issue)})`
      : `#${issueNumber} is not eligible: ${verdict.reason}`;
  }
}

function tierFromLabels(labels: readonly string[]): Tier {
  if (labels.includes('tier:1')) return 1;
  if (labels.includes('tier:3')) return 3;
  return 2;
}

function scopeForLane(lane: Lane): string {
  return { A: 'db', B: 'ci', C: 'web' }[lane];
}

function slugify(issue: Issue): string {
  const base = issue.title
    .toLowerCase()
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base || `issue-${issue.number}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
