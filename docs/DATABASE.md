# Database

One Postgres instance holds everything: application records, embeddings, the code graph, and the
job queue. Running a single store rather than a database plus a vector service plus a queue keeps a
self-hosted install to one container, and lets a retrieval query join an embedding against the graph
without a network hop between systems.

The image is `pgvector/pgvector:pg17`, which is stock Postgres 17 with the `vector` extension
already built. A plain `postgres:17` image will fail on the first migration.

## Running it locally

```bash
pnpm db:up        # starts Postgres on port 5433
pnpm db:migrate   # applies everything in db/migrations
```

Port 5433 is deliberate. It leaves 5432 free for whatever Postgres is already installed on the
machine, so this project does not collide with an existing one.

Migrations need [dbmate](https://github.com/amacneil/dbmate) on your `PATH` (`brew install dbmate`).

| Command              | Effect                                  |
| -------------------- | --------------------------------------- |
| `pnpm db:migrate`    | Apply all pending migrations            |
| `pnpm db:rollback`   | Reverse the most recent migration       |
| `pnpm db:status`     | Show which migrations have been applied |
| `pnpm db:new <name>` | Create a new timestamped migration file |

## Writing a migration

Every migration must have a `migrate:down` that actually reverses its `migrate:up`. Gate 4 proves
this by running up, down, and up again against a real database, so a migration that cannot roll back
fails before it merges rather than during an incident.

Dropping a table or column in `migrate:up` additionally requires the `db:destructive-approved`
label. A `DROP` inside `migrate:down` is the normal way to write a reversible migration and is not
flagged.

`db/schema.sql` is not committed. The migrations are the source of truth, and a generated dump would
only be one more thing to fall out of date.

## The job queue

`jobs` and `job_events` are the queue. Work that cannot finish inside an HTTP request goes there
instead of running in the request handler; repository analysis is the first such job.

A worker claims work with a single statement, so two workers racing never take the same job:

```sql
UPDATE jobs SET status = 'running', attempts = attempts + 1,
       leased_until = now() + $lease, lease_owner = $owner
WHERE id IN (
  SELECT id FROM jobs
   WHERE kind = ANY($kinds) AND run_at <= now() AND attempts < max_attempts
     AND (status = 'queued' OR (status = 'running' AND leased_until < now()))
   ORDER BY priority, run_at
   FOR UPDATE SKIP LOCKED
   LIMIT $limit
)
RETURNING *;
```

`leased_until` is what makes this a queue rather than a list of intentions. A worker renews its lease
while it works; one that dies stops renewing, and the job becomes claimable again. Every write is
scoped to `lease_owner`, so a worker whose lease lapsed cannot report a result over the worker that
replaced it.

`job_events` is the progress log, keyed by a monotonic `bigserial`. That id is what a browser sends
back as `Last-Event-ID`, so a dropped progress stream resumes rather than replaying.

The worker runs inside the API process. `WORKER_ENABLED=false` turns it off, which is how a process
serving traffic and a process running jobs are separated when that becomes worth doing.

## Timestamps

`created_at` and `updated_at` are maintained by a database trigger rather than by the application.
The schema is shared by the TypeScript API, the Python brain, and the Rust engine, and
application-side timestamps drift as soon as a second writer appears.

## Tests

Unit tests run with no database. Tests ending in `.integration.test.ts` need a live Postgres with
migrations applied, and run separately:

```bash
pnpm --filter @infracanvas/api test:integration
```

They truncate tables between cases, so they run against `infracanvas_test` and refuse to start
against a database whose name does not look like one. Create it once:

```bash
createdb -h localhost -p 5433 -U infracanvas infracanvas_test
DATABASE_URL=postgres://infracanvas:infracanvas@localhost:5433/infracanvas_test?sslmode=disable dbmate up
```

The guard is there because `DATABASE_URL` is usually already exported in the shell for `dbmate`,
and it is inherited by the test run. Without the check, the suite deletes the repositories,
analyses and experiments you were working with, and the only symptom is an application that looks
freshly installed. `INTEGRATION_ALLOW_ANY_DATABASE=true` overrides it if you really mean it.

## Production

`render.yaml` provisions the database and injects its connection string. Render only offers a
pre-deploy hook on paid instance types, so migrations are applied manually before promoting a
release that adds one:

```bash
DATABASE_URL='<render connection string>' pnpm db:migrate
```
