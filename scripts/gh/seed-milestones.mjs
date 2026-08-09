#!/usr/bin/env node
/**
 * Create the epic milestones. Idempotent.
 *
 * Milestones track the thirteen epics; the wave grouping in the description is
 * what stops us specifying work whose contracts do not exist yet.
 *
 * Usage: node scripts/gh/seed-milestones.mjs [--repo owner/name] [--dry-run]
 */

import { execFileSync } from 'node:child_process';

const MILESTONES = [
  ['Epic 0 - Delivery infrastructure', 'Wave 1. Gate system, issue contract, and CI. Everything after this is governed by it.'],
  ['Epic 1 - Data foundation', 'Wave 1. Postgres 17 with pgvector, migrations, DB layers, and the job queue.'],
  ['Epic 2 - Architecture IR', 'Wave 1. IR schema plus the 24 resource contracts that everything downstream reads.'],
  ['Epic 3 - Rust ingest engine', 'Wave 2. Parsing, chunking, embedding, and incremental indexing.'],
  ['Epic 4 - Retrieval', 'Wave 2. Hybrid retrieval and the pluggable evaluation harness.'],
  ['Epic 5 - Graph RAG', 'Wave 2. Code property graph, communities, and hierarchical summaries.'],
  ['Epic 6 - Brain and agents', 'Wave 2. Agent runtime, provider registry, and the AppProfile agent.'],
  ['Epic 7 - Prediction plane', 'Wave 3. Cost, latency, scale, and reliability models.'],
  ['Epic 8 - Codegen and validation', 'Wave 3. Pulumi Python emission and the validation gate.'],
  ['Epic 9 - AWS connect and deploy', 'Wave 3. CodeBuild deployment with TTL and budget guardrails.'],
  ['Epic 10 - Load test and measured SLIs', 'Wave 3. k6 at scale and predicted-versus-measured calibration.'],
  ['Epic 11 - Web UI', 'Wave 3. Canvas, dashboards, and the deploy console.'],
  ['Epic 12 - Merge-back and launch', 'Wave 3. Pull requests into user repositories, docs, and OSS launch.'],
];

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
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
    JSON.parse(gh(['api', `repos/${repo}/milestones?state=all&per_page=100`])).map((m) => m.title)
  );

  for (const [title, description] of MILESTONES) {
    if (existing.has(title)) {
      console.log(`Exists: ${title}`);
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] create ${title}`);
      continue;
    }
    gh([
      'api',
      '--method',
      'POST',
      `repos/${repo}/milestones`,
      '-f',
      `title=${title}`,
      '-f',
      `description=${description}`,
    ]);
    console.log(`Created: ${title}`);
  }
}

main();
