# Self-Host InfraCanvas

This guide is the tested startup path. Commands a self-hoster runs are fenced as `bash verify`;
`scripts/ci/verify-self-host.mjs` extracts those blocks in order and executes them in a clean scratch
copy. Prose explains the commands, but it is not a second setup path.

Related context lives in the [database guide](docs/DATABASE.md), the [brain service notes](services/brain/README.md),
the [API environment example](apps/api/.env.example), and the [web environment example](apps/web/.env.example).

## 1. Prerequisites

The verifier asserts these versions before it runs the guide. Install the same version family before
you start; a different family is treated as a stale self-host path, not as a warning.

| Tool             | Pinned version | What uses it                          |
| ---------------- | -------------- | ------------------------------------- |
| `node`           | `24.x`         | TypeScript services and health checks |
| `pnpm`           | `8.15.0`       | Monorepo install and scripts          |
| `docker`         | `29.x`         | Local Postgres container              |
| `docker compose` | `5.x`          | Local Postgres orchestration          |
| `rustc`          | `1.97.1`       | Engine workspace compatibility        |
| `python3`        | `3.14.x`       | Brain service runtime                 |
| `dbmate`         | `2.35.x`       | Postgres migrations                   |
| `uv`             | `0.11.x`       | Brain dependency install and runner   |

## 2. Clone and install

Start from the repository root of a clean clone. The verifier creates that clean copy before this
block runs.

```bash verify
test -f package.json
pnpm install --frozen-lockfile
uv sync --directory services/brain --all-extras
```

## 3. Start Postgres and apply migrations

The database is a Postgres 17 container with pgvector. Its local port is chosen at runtime and the
resulting connection string is recorded under `.self-host`.

```bash verify
mkdir -p .self-host
postgres_port=$(node - <<'NODE'
const net = require('node:net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  console.log(server.address().port);
  server.close();
});
NODE
)
docker_name=$(node - <<'NODE'
const fallback = `infracanvas-self-host-${process.pid}`;
const name = process.env.COMPOSE_PROJECT_NAME || fallback;
console.log(name.replace(/[^a-zA-Z0-9_.-]/g, '-'));
NODE
)
postgres_container="${docker_name}-postgres"
postgres_volume="${docker_name}-postgres-data"
database_url="postgres://infracanvas:infracanvas@localhost:${postgres_port}/infracanvas?sslmode=disable"
printf '%s\n' "$docker_name" > .self-host/docker-name
printf '%s\n' "$database_url" > .self-host/database-url
docker volume create "$postgres_volume"
docker run --detach \
  --name "$postgres_container" \
  --label="infracanvas.self-host=${docker_name}" \
  --publish "127.0.0.1:${postgres_port}:5432" \
  --volume "$postgres_volume:/var/lib/postgresql/data" \
  --env=POSTGRES_USER=infracanvas \
  --env=POSTGRES_PASSWORD=infracanvas \
  --env=POSTGRES_DB=infracanvas \
  pgvector/pgvector:pg17
for attempt in $(seq 1 60); do
  if docker exec "$postgres_container" pg_isready -U infracanvas -d infracanvas >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    docker logs "$postgres_container"
    exit 1
  fi
  sleep 1
done
DATABASE_URL="$database_url" pnpm db:migrate
```

## 4. Configure the environment

The API reads `apps/api/.env`; Vite reads `apps/web/.env.local`. The examples are copied directly,
then local-only URLs, ports, and secrets are generated.

```bash verify
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
node - <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function configure() {
  const apiPort = await freePort();
  const webPort = await freePort();
  const brainPort = await freePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const brainUrl = `http://127.0.0.1:${brainPort}`;
  const databaseUrl = fs.readFileSync('.self-host/database-url', 'utf8').trim();

  fs.writeFileSync('.self-host/api-url', `${apiUrl}\n`);
  fs.writeFileSync('.self-host/web-url', `${webUrl}\n`);
  fs.writeFileSync('.self-host/brain-url', `${brainUrl}\n`);
  fs.writeFileSync('.self-host/web-port', `${webPort}\n`);
  fs.writeFileSync('.self-host/brain-port', `${brainPort}\n`);

  const apiPath = 'apps/api/.env';
  let apiText = fs.readFileSync(apiPath, 'utf8');
  apiText = apiText.replace(/^DATABASE_URL=.*/m, `DATABASE_URL=${databaseUrl}`);
  apiText = apiText.replace(/^APP_URL=.*/m, `APP_URL=${webUrl}`);
  apiText = apiText.replace(/^API_URL=.*/m, `API_URL=${apiUrl}`);
  apiText = apiText.replace(/^PORT=.*/m, `PORT=${apiPort}`);
  apiText = apiText.replace(
    /^ENCRYPTION_KEY=.*/m,
    `ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`
  );
  apiText = apiText.replace(/^JWT_SECRET=.*/m, `JWT_SECRET=${crypto.randomBytes(32).toString('hex')}`);
  fs.writeFileSync(apiPath, apiText);

  const webPath = 'apps/web/.env.local';
  let webText = fs.readFileSync(webPath, 'utf8');
  webText = webText.replace(/^VITE_API_URL=.*/m, `VITE_API_URL=${apiUrl}`);
  fs.writeFileSync(webPath, webText);
}

configure().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
```

Environment variables documented by those examples:

| Variable                  | Required for start | What it is for                                       | How to obtain it                                    |
| ------------------------- | ------------------ | ---------------------------------------------------- | --------------------------------------------------- |
| `AUTH_PROVIDER`           | yes                | Chooses the first offered sign-in method             | Keep `token` for single-user self-hosting           |
| `GITHUB_CLIENT_ID`        | no                 | GitHub OAuth application id                          | Create a GitHub OAuth App for multi-user hosting    |
| `GITHUB_CLIENT_SECRET`    | no                 | GitHub OAuth application secret                      | Created with the same GitHub OAuth App              |
| `AUTH_TOKEN_ALLOW_REMOTE` | no                 | Allows token sign-in from non-loopback callers       | Set only on a trusted private network               |
| `GITHUB_TOKEN`            | no                 | Token sign-in without reading the GitHub CLI         | Personal token with repository access               |
| `DATABASE_URL`            | yes                | Postgres connection string                           | Generated when the database container starts        |
| `ENCRYPTION_KEY`          | yes                | Encrypts stored user and model credentials           | Generated by the command in this section            |
| `JWT_SECRET`              | yes                | Signs local sessions                                 | Generated by the command in this section            |
| `APP_URL`                 | yes                | Frontend origin for CORS and callbacks               | Generated in this section                           |
| `API_URL`                 | yes                | Public API origin                                    | Generated in this section                           |
| `AWS_ACCESS_KEY_ID`       | no                 | Optional AWS integration credentials                 | Prefer a short-lived role outside local development |
| `AWS_SECRET_ACCESS_KEY`   | no                 | Optional AWS integration credentials                 | Pair with the optional AWS access key               |
| `AWS_REGION`              | no                 | AWS region for optional integrations                 | Use the region you operate in                       |
| `TRUST_PROXY_HOPS`        | yes                | How many reverse proxies are trusted for rate limits | Keep `0` when running directly                      |
| `GITHUB_WEBHOOK_SECRET`   | no                 | Verifies optional GitHub webhooks                    | Generate a random webhook secret                    |
| `NODE_ENV`                | yes                | Runtime mode                                         | Keep `development` for this guide                   |
| `PORT`                    | yes                | API listen port                                      | Generated in this section                           |
| `VITE_API_URL`            | yes                | Browser-facing API origin                            | Generated in this section                           |

## 5. Start the services

Build the shared TypeScript package first, then start the API, web, and brain services explicitly.
Each service writes a PID and log file under `.self-host`.

```bash verify
pnpm turbo build --filter=@infracanvas/core
pnpm --filter @infracanvas/api dev > .self-host/api.log 2>&1 & echo $! > .self-host/api.pid
pnpm --filter @infracanvas/web dev --host 127.0.0.1 --port "$(cat .self-host/web-port)" --strictPort > .self-host/web.log 2>&1 & echo $! > .self-host/web.pid
DATABASE_URL="$(cat .self-host/database-url)" uv run --directory services/brain uvicorn brain.app:create_app --factory --host 127.0.0.1 --port "$(cat .self-host/brain-port)" > .self-host/brain.log 2>&1 & echo $! > .self-host/brain.pid
```

## 6. Verify

The API is healthy when it can serve requests and reach Postgres.

```bash verify
node - <<'NODE'
const fs = require('node:fs');
const url = `${fs.readFileSync('.self-host/api-url', 'utf8').trim()}/health`;

async function waitForApi() {
  let last = 'no response';
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(url);
      const body = await response.json();
      last = JSON.stringify(body);
      if (response.ok && body.status === 'ok' && body.database === 'up') {
        console.log(`api healthy: ${last}`);
        return;
      }
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`api health never reported {"status":"ok","database":"up"}: ${last}`);
}

waitForApi().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
```

The web service is healthy when the Vite server answers the health path with the app shell. The
production container uses the same path and returns `ok`.

```bash verify
node - <<'NODE'
const fs = require('node:fs');
const url = `${fs.readFileSync('.self-host/web-url', 'utf8').trim()}/health`;

async function waitForWeb() {
  let last = 'no response';
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      last = body.trim().slice(0, 120);
      const healthy = response.ok && (body.trim() === 'ok' || body.includes('<div id="root"></div>'));
      if (healthy) {
        console.log(`web healthy: ${last}`);
        return;
      }
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`web health never returned the app shell or ok: ${last}`);
}

waitForWeb().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
```

The brain service is healthy when it can serve requests and reach the same Postgres database.

```bash verify
node - <<'NODE'
const fs = require('node:fs');
const url = `${fs.readFileSync('.self-host/brain-url', 'utf8').trim()}/health`;

async function waitForBrain() {
  let last = 'no response';
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(url);
      const body = await response.json();
      last = JSON.stringify(body);
      if (response.ok && body.status === 'ok' && body.database === 'up') {
        console.log(`brain healthy: ${last}`);
        return;
      }
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`brain health never reported {"status":"ok","database":"up"}: ${last}`);
}

waitForBrain().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
```

## 7. Bring your own keys

Model-assisted features work without shared InfraCanvas credentials. OpenAI, Anthropic, and Google
keys are entered in the Settings screen after sign-in and are encrypted with `ENCRYPTION_KEY` before
storage. Bedrock uses the AWS credentials already available to the API process, and Ollama uses a
local model server.

Without model credentials, the canvas, cost estimation, deterministic checks, GitHub sign-in, and
health endpoints still work. Architecture proposals that require a hosted model stay unavailable
until a key is saved.

## 8. Troubleshooting

| Symptom                                      | Cause                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| API health reports database down             | Postgres is not healthy yet, or `DATABASE_URL` points at the wrong port       |
| Brain health reports database down           | The brain process was started without the same `DATABASE_URL`                 |
| API exits before listening                   | `ENCRYPTION_KEY`, `JWT_SECRET`, `APP_URL`, or `API_URL` is missing or invalid |
| Browser requests fail from the web app       | `VITE_API_URL` does not match the API origin                                  |
| OAuth is shown as unavailable                | `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are not set                     |
| Token sign-in works only on the same machine | `AUTH_TOKEN_ALLOW_REMOTE` is unset, which is the safe default                 |
| Migrations cannot connect                    | Docker Compose has not finished starting Postgres                             |
| A generated service port is already used     | Another local service bound to the port after it was selected                 |
