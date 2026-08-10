---
title: '[api] Make the API start from a fresh clone and in Docker'
labels: tier:1, size:s, area:api, epic:0-delivery
---

### Epic

#1

### Context

The API cannot be started by either documented route.

`pnpm dev` runs `tsx watch src/index.ts`, which does not read `apps/api/.env`. Nothing fails at
startup, because `env()` validates lazily, so the process binds a port and reports itself as running.
The misconfiguration only surfaces on the first request that touches the database, as
`{"status":"degraded","database":"down"}`, which points at Postgres rather than at the missing
variables. The header comment on `env.ts` already claims it "throws at startup"; it does not.

`docker compose up api` builds the `development` stage, which installs dependencies but never builds
`packages/core`. `@infracanvas/core` resolves through its `dist` output, so the container crash
loops on `ERR_MODULE_NOT_FOUND: Cannot find package '@infracanvas/core'` as soon as anything imports
the analysis code. This appeared when the repository analysis routes landed and began importing the
package; before that the API happened not to touch it at runtime.

The two together mean a new contributor following `README.md` gets either a silently broken server
or a restart loop, with no message naming the real cause.

### Contract

No new interfaces. Three changes to how the process starts:

```jsonc
// apps/api/package.json
"dev": "tsx watch --env-file-if-exists=.env src/index.ts"
```

`--env-file-if-exists` rather than `--env-file`, because the container supplies configuration through
Compose's `env_file` and has no `.env` of its own; the strict flag would make it exit.

```typescript
// apps/api/src/index.ts, before the port is bound
try {
  env();
} catch (error) {
  logError('Refusing to start', error);
  process.exit(1);
}
```

```dockerfile
# apps/api/Dockerfile, development stage, after pnpm install
RUN pnpm --filter @infracanvas/core build
```

### Files

- MODIFY `apps/api/package.json` - load `.env` in `dev`
- MODIFY `apps/api/src/index.ts` - validate configuration before listening
- MODIFY `apps/api/Dockerfile` - build `@infracanvas/core` in the development stage

### Acceptance Criteria

- [ ] `pnpm dev` in `apps/api` reads `apps/api/.env` and `/health` reports `database: up`
- [ ] A missing required variable exits non-zero naming the variable, rather than binding a port
- [ ] `docker compose up api` reaches "server running" instead of `ERR_MODULE_NOT_FOUND`
- [ ] The container still takes its configuration from Compose's `env_file` with no `.env` present

### Required Tests

Manual, since all three concern process startup rather than a unit:

- `pnpm --filter @infracanvas/api dev` followed by `curl localhost:3001/health` returning
  `{"status":"ok","database":"up"}`
- The same with a required variable removed, expecting a non-zero exit naming it
- `docker compose build api && docker compose up -d api && docker logs infracanvas-api-1`

### Performance Budget

n/a

### Out of Scope

- Do not change the production or builder stages of the Dockerfile; only the development stage is
  broken, and Render builds through `turbo`, which resolves the workspace dependency correctly
- Do not change which variables are required or how they are validated
- Do not add a process manager or a dotenv dependency; Node loads the file natively

### Dependencies

none

### Verification

```bash
curl -s localhost:3001/health
docker compose build api && docker compose up -d api && docker logs infracanvas-api-1
```

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:s - under 200 lines
