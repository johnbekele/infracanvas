# Database

One Postgres instance holds everything: application records, embeddings, the code graph, and the
job queue. Running a single store rather than a database plus a vector service plus a queue keeps a
self-hosted install to one container, and lets a retrieval query join an embedding against the graph
without a network hop between systems.

The image is `pgvector/pgvector:pg17`, which is stock Postgres 17 with the `vector` extension
already built. A plain `postgres:17` image will fail on the first migration.

## Tenancy

Two levels, not one and not three.

An **organization** owns billing, the plan, audit retention and organization-wide policy. A
**workspace** is the isolation boundary: every tenant row carries `workspace_id`, and every row-level
security policy compares against it. Projects, architectures, experiments and deployments live inside
a workspace.

A third level was considered and rejected. Teams that group members inside a workspace are a
permissions convenience, and can be added later as a grouping over `workspace_members` without moving
the boundary. Moving the boundary later is a migration of every table.

A solo user gets an organization too. `kind = 'personal'` marks it, and nothing else about it is
special: one member, one workspace, the same policies and the same code path. The alternative — a
nullable `organization_id` meaning "just me" — puts a branch in every query and every policy, and the
branch that is rarely exercised is the one that leaks.

`organization_id` lives only on `workspaces`. Denormalising it onto every leaf table would make the
policies marginally cheaper and would invite exactly one bug: a row whose `workspace_id` and
`organization_id` disagree. The request context resolves workspace to organization once, on the way
in.

Deleting an organization that still has a workspace is refused by the database (`ON DELETE
RESTRICT`). A cascade would let one `DELETE` remove an organization, its workspaces, and eventually
every experiment and deployment record beneath them — including the rows naming AWS stacks that are
still running and still billing. Deleting an organization has to be a workflow that destroys cloud
resources and settles accounts, so the database refuses the shortcut.

Slug uniqueness is enforced by partial unique indexes over `lower(slug)` `WHERE deleted_at IS NULL`,
scoped to the organization for workspaces. Two organizations may each have a workspace called
`production`; one organization may not have two. A soft-deleted workspace frees its slug for reuse,
which is what makes the index partial rather than total.

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

When a column must be replaced rather than added, rename it instead of dropping it. A rename is
reversible in one statement and keeps the provenance of the old values; a drop plus an insert is
neither.

### No new `ENUM` for a value set that will grow

New value sets use `text` with a `CHECK`, not a Postgres `ENUM`.

`ALTER TYPE ... ADD VALUE` has no inverse. Undoing it means recreating the type and rewriting every
dependent column, which is destructive DDL inside `migrate:down` and fails the up/rollback/up round
trip Gate 4 runs. Adding a value to a `CHECK` is reversed by dropping the constraint and adding the
previous one back, which is an ordinary reversible statement.

The `ENUM` types already in the schema — `analysis_status` and the others created before this policy
— stay as they are. Rewriting them would be exactly the destructive migration the policy exists to
avoid. `organizations.kind` and `organizations.plan` are the first columns written under it.

A closed set that genuinely cannot grow is still a fair use of `ENUM`. In practice, very few are.

`db/schema.sql` is not committed. The migrations are the source of truth, and a generated dump would
only be one more thing to fall out of date.

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

They truncate tables between cases, so point `DATABASE_URL` at a scratch database rather than one
holding anything you want to keep.

## Production

`render.yaml` provisions the database and injects its connection string. Render only offers a
pre-deploy hook on paid instance types, so migrations are applied manually before promoting a
release that adds one:

```bash
DATABASE_URL='<render connection string>' pnpm db:migrate
```
