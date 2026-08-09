#!/usr/bin/env node
/**
 * Create the thirteen epic tracking issues. Idempotent: an epic whose title
 * already exists is skipped.
 *
 * Epics are never assigned to an agent. They exist so that each agent task can
 * point at the contracts it depends on, and so Gate 0 can refuse to specify work
 * whose contracts do not exist yet.
 *
 * Usage: node scripts/gh/seed-epics.mjs [--repo owner/name] [--dry-run]
 */

import { execFileSync } from 'node:child_process';

const EPICS = [
  {
    n: 0,
    title: 'Epic 0: Delivery infrastructure',
    label: 'epic:0-delivery',
    milestone: 'Epic 0 - Delivery infrastructure',
    wave: 'Wave 1',
    goal: 'Every subsequent line of code is governed by a gate. Issues cannot be started until they are fully specified, and pull requests cannot merge without proof of correctness.',
    contracts: [
      '`.github/ISSUE_TEMPLATE/agent-task.yml` - the Agent-Ready issue contract enforced by Gate 0',
      '`scripts/ci/check-*.mjs` - the enforcement scripts for Gates 2, 6, and 7',
      '`.github/rulesets/main.json` - version-controlled branch protection and merge queue',
      '`docs/DELIVERY.md` - the shared description of the gate system',
    ],
    exit: [
      'A pull request cannot merge without passing all required checks',
      'An incomplete issue is labelled `needs-spec` automatically and cannot be started',
      'A commit carrying an assistant co-author trailer is rejected',
    ],
  },
  {
    n: 1,
    title: 'Epic 1: Data foundation',
    label: 'epic:1-data',
    milestone: 'Epic 1 - Data foundation',
    wave: 'Wave 1',
    goal: 'One Postgres instance holds application data, vectors, the code graph, and the job queue. MongoDB is gone, along with the duplicated Vercel serverless API.',
    contracts: [
      '`db/migrations/*.sql` applied by dbmate, shared by all three runtimes',
      '`chunk_embeddings.embedding halfvec(384)` with an HNSW index using `halfvec_cosine_ops`',
      '`jobs` table with `FOR UPDATE SKIP LOCKED`, heartbeat, backoff, and a dead-letter path',
      'Postgres `LISTEN/NOTIFY` on channel `ic_events`, bridged to SSE by the API',
    ],
    exit: [
      'Migrations apply up, roll back, and apply again cleanly in CI',
      'Auth and GitHub flows work end to end against Postgres with no MongoDB dependency',
      'A worker can claim, heartbeat, fail, retry, and dead-letter a job',
    ],
  },
  {
    n: 2,
    title: 'Epic 2: Architecture IR and resource contracts',
    label: 'epic:2-ir',
    milestone: 'Epic 2 - Architecture IR',
    wave: 'Wave 1',
    goal: 'A single typed Architecture IR is the source of truth for the canvas, cost, latency, reliability, Well-Architected rules, and code generation. The untyped `Record<string, string | number | boolean>` property bag is gone.',
    contracts: [
      '`packages/ir-schema/schema/**` - versioned JSON Schema, the authority for both languages',
      'Generated TypeScript and Pydantic types, committed and drift-checked by Gate 4',
      '`irToCanvas` and `canvasToIr` in `packages/core`, required to round-trip losslessly',
      'The Resource Contract: each resource type ships schema, cost model, latency contribution, reliability contribution, Well-Architected rules, a Pulumi emitter, and golden tests',
    ],
    exit: [
      'All 24 resource types implement the full seven-part Resource Contract',
      'Canvas to IR to canvas is lossless for every fixture',
      'Changing the schema without bumping the version fails CI',
    ],
  },
  {
    n: 3,
    title: 'Epic 3: Rust ingest engine',
    label: 'epic:3-engine',
    milestone: 'Epic 3 - Rust ingest engine',
    wave: 'Wave 2',
    goal: 'A repository becomes searchable structure: parsed, chunked on AST boundaries, embedded locally, and stored, fast enough and small enough to run on an ordinary laptop.',
    contracts: [
      '`ic_engine::index(IndexOptions) -> Result<IndexStats>`',
      '`trait Embedder { fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>>; fn dim(&self) -> usize; }`',
      'A CLI binary and a PyO3 module built from one crate, so the brain calls it in-process',
      'Merkle content hashing so a push re-indexes only what changed',
    ],
    exit: [
      '100k-file fixture indexes in under 120s at under 300 MB peak RSS',
      'Re-indexing after 100 changed files completes in under 5s',
      'Embeddings work with no API key and no network after the first model fetch',
    ],
  },
  {
    n: 4,
    title: 'Epic 4: Retrieval',
    label: 'epic:4-retrieval',
    milestone: 'Epic 4 - Retrieval',
    wave: 'Wave 2',
    goal: 'Hybrid retrieval that keeps exact-identifier precision while still finding concepts, and an evaluation harness that scores any new strategy on real numbers.',
    contracts: [
      '`Retriever` protocol with a registry, so a new strategy is a plugin rather than a rewrite',
      'Reciprocal rank fusion over BM25, dense, and graph-expanded candidates',
      '`brain.eval.harness` reporting recall@k, nDCG, MRR, latency, and peak RSS',
    ],
    exit: [
      'Hybrid retrieval beats dense-only on the golden set for identifier queries',
      'p95 retrieval latency stays under 250 ms at 1M chunks',
      'A new retriever can be added and scored without touching existing ones',
    ],
  },
  {
    n: 5,
    title: 'Epic 5: Graph RAG',
    label: 'epic:5-graphrag',
    milestone: 'Epic 5 - Graph RAG',
    wave: 'Wave 2',
    goal: 'A code property graph plus hierarchical community summaries, so the system can answer questions about architecture rather than only about individual snippets.',
    contracts: [
      '`graph_nodes` and `graph_edges` with edge kinds: imports, calls, extends, reads_env, http_call, db_query',
      'Leiden community detection in `petgraph`, run in memory rather than in the database',
      'Community summaries with citations, embedded for retrieval at each level',
    ],
    exit: [
      'Graph extraction is correct on fixtures for every supported language',
      'Community summaries cite real files and no summary contains an uncited claim',
      'Graph expansion measurably improves recall on architecture-level questions',
    ],
  },
  {
    n: 6,
    title: 'Epic 6: Brain and agents',
    label: 'epic:6-brain',
    milestone: 'Epic 6 - Brain and agents',
    wave: 'Wave 2',
    goal: 'A typed agent runtime that works with a local model or any hosted provider, and an AppProfile agent whose every claim is traceable to a line of code.',
    contracts: [
      'Provider registry over pydantic-ai covering Anthropic, Bedrock, OpenAI, Gemini, Ollama, and OpenAI-compatible endpoints',
      '`AppProfile` Pydantic model with per-field confidence and `file:line` citations',
      'A citation verifier that rejects any claim whose cited span does not support it',
      'Token budget accounting and a response cache keyed by content hash',
    ],
    exit: [
      'The full flow runs offline against Ollama with no API key',
      'Switching provider requires configuration only, never a code change',
      'An AppProfile field without a valid citation fails validation rather than reaching the user',
    ],
  },
  {
    n: 7,
    title: 'Epic 7: Prediction plane',
    label: 'epic:7-prediction',
    milestone: 'Epic 7 - Prediction plane',
    wave: 'Wave 3',
    goal: 'Honest, explainable predictions of cost, latency, throughput, and availability for an architecture, with every assumption visible and editable.',
    contracts: [
      'A versioned AWS Price List snapshot built in CI, so cost works with no credentials',
      '`costModel`, `latencyContribution`, and `reliabilityContribution` per resource, from Epic 2',
      'Bottleneck solver using Little\'s Law plus hard service limits, returning the component that breaks first',
      'Series-parallel availability model over AZ topology and published AWS SLAs',
    ],
    exit: [
      'Every number is labelled Predicted and lists the assumptions behind it',
      'Changing an assumption updates the result without a re-run of the whole analysis',
      'Cost for the reference architectures is within 10% of the AWS calculator',
    ],
  },
  {
    n: 8,
    title: 'Epic 8: Pulumi code generation and validation',
    label: 'epic:8-codegen',
    milestone: 'Epic 8 - Codegen and validation',
    wave: 'Wave 3',
    goal: 'Deterministic, reviewable Pulumi AWS Python generated from the IR, validated before anyone is asked to trust it.',
    contracts: [
      'One emitter per resource type, from the Resource Contract in Epic 2',
      'Self-managed S3 state backend, so no Pulumi Cloud account is required',
      'Validation gate: ruff, mypy, checkov, then `pulumi preview` as the first CodeBuild stage',
      'Byte-identical output for identical input, enforced by golden tests',
    ],
    exit: [
      'Generated projects pass ruff, mypy, and checkov with no findings',
      'The same IR always produces byte-identical code',
      'Generation fails closed when validation fails, rather than emitting broken code',
    ],
  },
  {
    n: 9,
    title: 'Epic 9: AWS connection and deployment',
    label: 'epic:9-deploy',
    milestone: 'Epic 9 - AWS connect and deploy',
    wave: 'Wave 3',
    goal: 'Deploy a generated stack into the user\'s own AWS account through CodeBuild, with guardrails that make it impossible to forget an experiment and get a surprise bill.',
    contracts: [
      'Cross-account IAM role with external ID. Long-lived access keys are never stored',
      'Bootstrap stack providing CodeBuild, the state bucket, and a least-privilege deploy role with a permission boundary',
      'Every resource tagged `infracanvas:experiment-id`',
      'TTL and budget cap per experiment, enforced by a reaper that destroys on breach',
    ],
    exit: [
      'A deployment streams live logs to the browser and completes or fails cleanly',
      'One click destroys a stack completely, with no orphaned resources',
      'An experiment past its TTL or budget is destroyed automatically',
    ],
  },
  {
    n: 10,
    title: 'Epic 10: Load testing and measured SLIs',
    label: 'epic:10-loadtest',
    milestone: 'Epic 10 - Load test and measured SLIs',
    wave: 'Wave 3',
    goal: 'Replace predictions with measurements, then grade the predictions. This calibration loop is what separates this from a diagram tool.',
    contracts: [
      'k6 scripts generated from the IR request paths',
      'Fargate Spot runner with a ramp profile that finds the knee point',
      'Client-side k6 metrics joined with server-side CloudWatch metrics',
      'A predicted-versus-measured report that feeds corrections back into the Epic 7 models',
    ],
    exit: [
      'Measured p99 and max sustainable RPS are reported for a real deployment',
      'The report states prediction error per metric',
      'Model calibration measurably improves after a feedback cycle',
    ],
  },
  {
    n: 11,
    title: 'Epic 11: Web UI',
    label: 'epic:11-ui',
    milestone: 'Epic 11 - Web UI',
    wave: 'Wave 3',
    goal: 'The canvas becomes an IR editor, with analysis, provenance, deployment, and load-test results presented so a user can make a real decision.',
    contracts: [
      'Canvas reads and writes the IR directly, with no parallel state model',
      'Dashboards for cost, latency, scalability, and SLO, each showing assumptions',
      'Provenance view linking any IR element back to the source lines that justified it',
      'Deploy console with live logs, plus destroy and TTL controls',
    ],
    exit: [
      '500-node canvas stays at 60fps',
      'Initial JavaScript returns to the 250 KB gzip target, down from the current 260 KB ratchet',
      'Every prediction in the UI can be traced to its assumptions',
    ],
  },
  {
    n: 12,
    title: 'Epic 12: Merge-back and launch',
    label: 'epic:12-launch',
    milestone: 'Epic 12 - Merge-back and launch',
    wave: 'Wave 3',
    goal: 'The user keeps the output: infrastructure code and application refactors arrive as reviewable pull requests in their own repository.',
    contracts: [
      'Pull request generator producing `infra/` plus CI workflows',
      'Application refactor patches (Dockerfile, health endpoint, graceful shutdown, 12-factor config), each independently acceptable',
      'Self-host guide and security policy',
    ],
    exit: [
      'A generated pull request applies cleanly and passes the target repository CI',
      'A new contributor can self-host by following the guide alone',
      'No secret ever leaves the user environment',
    ],
  },
];

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function body(epic) {
  return `### Goal

${epic.goal}

### Contracts Introduced

${epic.contracts.map((c) => `- ${c}`).join('\n')}

### Tasks

Populated as ${epic.wave} issues are created. An issue may only be specified once the
contracts it depends on exist, so this list fills in as the epic's dependencies land.

### Exit Criteria

${epic.exit.map((e) => `- [ ] ${e}`).join('\n')}

### Wave

${epic.wave}
`;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const repoIndex = args.indexOf('--repo');
  const repo =
    repoIndex >= 0
      ? args[repoIndex + 1]
      : JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;

  const existing = new Set(
    JSON.parse(
      gh(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '300', '--json', 'title'])
    ).map((i) => i.title)
  );

  for (const epic of EPICS) {
    if (existing.has(epic.title)) {
      console.log(`Exists: ${epic.title}`);
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] create "${epic.title}"`);
      continue;
    }
    const url = gh([
      'issue',
      'create',
      '--repo',
      repo,
      '--title',
      epic.title,
      '--body',
      body(epic),
      '--label',
      'epic',
      '--label',
      epic.label,
      '--milestone',
      epic.milestone,
    ]).trim();
    console.log(`Created ${epic.title} -> ${url}`);
  }
}

main();
