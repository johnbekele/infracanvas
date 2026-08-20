-- Fixed-uuid user, repository, and ingestion run for Gate 6 ingest-performance.
-- Idempotent: safe to re-run against a migrated database.

INSERT INTO users (id, github_id, github_username, github_avatar)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  11111111,
  'perf-fixture',
  'https://example.com/perf.png'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO repositories (
  id, user_id, github_id, github_owner, github_name, default_branch, is_private
)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  22222222,
  'infracanvas',
  'perf-fixture',
  'main',
  false
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO ingestion_runs (
  id, repository_id, commit_sha, ref, status
)
VALUES (
  '33333333-3333-4333-8333-333333333333',
  '22222222-2222-4222-8222-222222222222',
  '0000000000000000000000000000000000000000',
  'main',
  'pending'
)
ON CONFLICT (id) DO NOTHING;
