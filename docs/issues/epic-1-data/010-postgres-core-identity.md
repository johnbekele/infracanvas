---
title: '[db] Replace MongoDB with Postgres and pgvector for core identity'
labels: tier:2, size:m, area:db, epic:1-data
---

### Epic

#2

### Context

The platform needs vector search over code embeddings, a code property graph, and a durable job
queue. MongoDB gives us none of the three. Adding a vector store and a queue beside it would mean
three systems to install before anyone can self-host, and a retrieval query would cross a network
boundary to join an embedding against the graph.

Postgres with pgvector does all three in one process. Changing the store now, while there is no data
worth migrating, is far cheaper than changing it once there is.

This issue covers only the tables that exist today. The ingestion, graph, experiment, and queue
tables arrive in later issues so each is reviewable on its own.

Spec: `docs/DATABASE.md`

### Contract

```typescript
export interface User {
  id: string;
  githubId: number;
  githubUsername: string;
  githubAvatar: string;
  email: string | null;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function findOrCreateUser(input: CreateUserInput): Promise<User>;
export function findUserById(userId: string): Promise<User | null>;
export function findUserByGitHubId(githubId: number): Promise<User | null>;
export function updateUser(userId: string, updates: UserProfileUpdate): Promise<User | null>;

export function saveGitHubToken(input: SaveTokenInput): Promise<void>;
export function getGitHubToken(userId: string): Promise<string | null>;
export function hasGitHubToken(userId: string): Promise<boolean>;
export function deleteGitHubToken(userId: string): Promise<void>;

export function getPool(): pg.Pool;
export function query<T>(text: string, params?: readonly unknown[]): Promise<pg.QueryResult<T>>;
export function withTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
export function ping(): Promise<boolean>;
export function closePool(): Promise<void>;
```

DDL: `users` keyed by `uuid` with a unique `github_id`, and `github_tokens` keyed by `user_id` with
`ON DELETE CASCADE`. `updated_at` is maintained by a trigger, not by the application, because the
Python and Rust services will write these tables too.

### Files

- CREATE `db/migrations/20260809120000_core_identity.sql`
- CREATE `apps/api/src/lib/db/client.ts`
- CREATE `apps/api/src/lib/db/users.integration.test.ts`
- CREATE `apps/api/src/lib/db/tokens.integration.test.ts`
- CREATE `apps/api/vitest.config.ts`
- CREATE `apps/api/vitest.integration.config.ts`
- CREATE `apps/api/src/test/setup-integration.ts`
- CREATE `docs/DATABASE.md`
- MODIFY `apps/api/src/lib/db/users.ts`
- MODIFY `apps/api/src/lib/db/tokens.ts`
- MODIFY `apps/api/src/lib/env.ts`
- MODIFY `apps/api/src/index.ts`
- MODIFY `apps/api/src/routes/auth/status.ts`
- MODIFY `apps/api/src/routes/auth/callback.ts`
- MODIFY `docker-compose.yml`
- MODIFY `render.yaml`
- DELETE `apps/api/src/lib/mongodb.ts`

### Acceptance Criteria

- [ ] `dbmate up`, `rollback`, then `up` succeeds against `pgvector/pgvector:pg17`
- [ ] `findOrCreateUser` called twice with the same `githubId` yields one row and the same `id`
- [ ] Two concurrent `findOrCreateUser` calls for the same account do not raise a unique violation
- [ ] A GitHub token is unreadable as plaintext in the `github_tokens` table
- [ ] Deleting a user removes their token row
- [ ] `getGitHubToken` returns `null`, not a thrown error, when the ciphertext cannot be decrypted
- [ ] `GET /health` returns 503 when the database is unreachable
- [ ] The `mongodb` package is absent from `apps/api/package.json`

### Required Tests

- `creates a user that does not exist yet`
- `returns the same row on a second call rather than duplicating the account`
- `survives two concurrent OAuth callbacks for the same account`
- `stores absent optional fields as null instead of the string "undefined"`
- `never writes the plaintext token to the database`
- `rejects a token for a user that does not exist`
- `returns null rather than throwing when the stored value cannot be decrypted`
- `removes the token with the user it belongs to`

### Performance Budget

n/a

### Out of Scope

- Do not add ingestion, chunk, embedding, graph, experiment, or job tables; those are separate issues
- Do not delete `apps/web/api`; that needs `VITE_API_URL` set on Vercel first and is issue-tracked separately
- Do not change the shape of any HTTP response body; `null` from the database is converted to
  `undefined` at the route boundary so the client sees identical JSON
- Do not introduce an ORM

### Dependencies

none

### Verification

```bash
pnpm db:up
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
pnpm --filter @infracanvas/api test:integration
pnpm turbo typecheck build test
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
