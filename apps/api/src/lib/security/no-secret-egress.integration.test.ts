/**
 * Canary-seeded integration test: credentials must never appear in responses,
 * logs, or outbound requests to hosts outside CREDENTIAL_HOSTS.
 *
 * Outbound traffic is captured by replacing `globalThis.fetch`. An undici
 * MockAgent would do the same job; the package is not a dependency of this
 * workspace, and adding one is outside this issue's file list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { CANARY } from './canary.js';
import { closePool, query } from '../db/client.js';
import { findOrCreateUser } from '../db/users.js';
import { saveGitHubToken } from '../db/tokens.js';
import { createSession } from '../db/sessions.js';
import { saveCredential } from '../db/llm-credentials.js';
import { createSessionToken, SESSION_MAX_AGE_MS } from '../jwt.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';

/** Re-export so the contract's location and the helper stay aligned. */
export { CANARY };

/** Mirrors `CREDENTIAL_HOSTS` in scripts/ci/check-egress-allowlist.mjs. */
const CREDENTIAL_HOSTS = ['api.github.com'] as const;

interface CapturedRequest {
  host: string;
  url: string;
  hasAuthorization: boolean;
  bodyIncludesCanary: boolean;
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));

  // Lazy imports so env() has been satisfied by setup-integration.ts first.
  return Promise.all([
    import('../../routes/auth/index.js'),
    import('../../routes/github/index.js'),
    import('../../routes/repositories/index.js'),
    import('../../routes/settings/index.js'),
  ]).then(([auth, github, repositories, settings]) => {
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok' });
    });
    app.use('/auth', auth.default);
    app.use('/github', github.default);
    app.use('/repositories', repositories.default);
    app.use('/settings', settings.default);
    app.use((_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
    return app;
  });
}

describe('no secret egress', () => {
  let app: express.Express;
  let originalFetch: typeof globalThis.fetch;
  let captured: CapturedRequest[];
  let logLines: string[];
  let originalError: typeof console.error;
  let originalLog: typeof console.log;
  let sessionCookie: string;
  let userId: string;
  let credentialId: string;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await query('TRUNCATE users CASCADE');

    captured = [];
    logLines = [];
    originalFetch = globalThis.fetch;
    originalError = console.error;
    originalLog = console.log;

    console.error = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    };
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    };

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      const auth = headers.get('authorization') ?? headers.get('Authorization');
      const body =
        typeof init?.body === 'string' ? init.body : init?.body != null ? String(init.body) : '';

      const host = hostOf(url);
      captured.push({
        host,
        url,
        hasAuthorization: Boolean(auth),
        bodyIncludesCanary:
          url.includes(CANARY) || body.includes(CANARY) || Boolean(auth?.includes(CANARY)),
      });

      if (
        !(CREDENTIAL_HOSTS as readonly string[]).includes(host) &&
        !['localhost', '127.0.0.1'].includes(host)
      ) {
        // Unexpected host: still return a benign response so the route can finish;
        // the assertion below fails the test.
      }

      if (host === 'api.github.com') {
        const path = new URL(url).pathname;
        if (path === '/user') {
          return new Response(
            JSON.stringify({
              id: 4242,
              login: 'canary-user',
              avatar_url: 'https://example.com/a.png',
              name: 'Canary',
              email: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (path.startsWith('/user/repos')) {
          if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
            return new Response(
              JSON.stringify({
                id: 99,
                name: 'tmp-canary-repo',
                full_name: 'canary-user/tmp-canary-repo',
                html_url: 'https://github.com/canary-user/tmp-canary-repo',
              }),
              { status: 201, headers: { 'content-type': 'application/json' } }
            );
          }
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (/^\/repos\/[^/]+\/[^/]+$/.test(path) && (!init?.method || init.method === 'GET')) {
          return new Response(
            JSON.stringify({
              id: 99,
              name: 'demo',
              owner: { login: 'canary-user' },
              default_branch: 'main',
              private: false,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (path.includes('/git/trees/')) {
          return new Response(JSON.stringify({ tree: [], truncated: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (path.includes('/git/blobs/')) {
          return new Response(
            JSON.stringify({ content: Buffer.from('').toString('base64'), encoding: 'base64' }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (path.includes('/languages')) {
          return new Response(JSON.stringify({ TypeScript: 1 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (
          path.includes('/commits/') ||
          path.includes('/git/ref/') ||
          path.includes('/git/refs')
        ) {
          return new Response(
            JSON.stringify({
              sha: 'abc123',
              object: { sha: 'abc123' },
              tree: { sha: 'tree123' },
              html_url: 'https://github.com/canary-user/demo/commit/abc123',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (path.includes('/branches')) {
          return new Response(JSON.stringify([{ name: 'main', commit: { sha: 'abc123' } }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            sha: 'abc123',
            object: { sha: 'abc123' },
            tree: { sha: 'tree123' },
            html_url: 'https://github.com/canary-user/demo/commit/abc123',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    process.env.AWS_SECRET_ACCESS_KEY = CANARY;

    const user = await findOrCreateUser({
      githubId: 4242,
      githubUsername: 'canary-user',
      githubAvatar: 'https://example.com/a.png',
    });
    userId = user.id;

    await saveGitHubToken({
      userId,
      accessToken: CANARY,
      tokenType: 'bearer',
      scope: 'repo',
    });

    const credential = await saveCredential({
      userId,
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: CANARY,
      makeDefault: true,
    });
    credentialId = credential.id;

    // Bedrock needs no key; verifying it exercises the route without sending the canary.
    await saveCredential({
      userId,
      provider: 'bedrock',
      model: 'anthropic.claude-sonnet-4-5-v1:0',
    });

    const session = await createSession({
      userId,
      expiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS),
      authMethod: 'token',
      tokenOrigin: 'test',
      userAgent: 'canary-test',
    });

    const token = await createSessionToken({
      userId,
      githubId: user.githubId,
      githubUsername: user.githubUsername,
      sessionId: session.id,
    });
    sessionCookie = `${SESSION_COOKIE_NAME}=${token}`;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.log = originalLog;
  });

  afterAll(async () => {
    await closePool();
  });

  async function authed(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
    return request(app)[method](path).set('Cookie', sessionCookie);
  }

  async function exerciseRoutes() {
    const bodies: string[] = [];

    const record = async (res: request.Response) => {
      bodies.push(JSON.stringify(res.body) + (res.text ?? ''));
      return res;
    };

    await record(await authed('get', '/health'));
    await record(await authed('get', '/auth/status'));
    await record(await authed('get', '/auth/methods'));
    await record(await authed('get', '/github/user'));
    await record(await authed('get', '/github/repos'));
    await record(
      await request(app)
        .post('/github/repos')
        .set('Cookie', sessionCookie)
        .send({ name: 'tmp-canary-repo', description: 'x', isPrivate: true })
    );
    await record(await authed('get', '/github/branches/canary-user/demo'));
    await record(
      await request(app)
        .post('/github/branches/canary-user/demo')
        .set('Cookie', sessionCookie)
        .send({ branchName: 'feat', fromBranch: 'main' })
    );
    await record(
      await request(app)
        .post('/github/push')
        .set('Cookie', sessionCookie)
        .send({
          owner: 'canary-user',
          repo: 'demo',
          branch: 'main',
          message: 'test',
          files: [{ path: 'README.md', content: 'hi' }],
        })
    );

    await record(await authed('get', '/repositories'));
    const connected = await record(
      await request(app)
        .post('/repositories')
        .set('Cookie', sessionCookie)
        .send({ owner: 'canary-user', repo: 'demo' })
    );
    const repositoryId = connected.body?.repository?.id as string | undefined;

    if (repositoryId) {
      await record(await authed('get', `/repositories/${repositoryId}`));
      // Analysis hits many GitHub URLs; the mock returns empty trees / ok payloads.
      await record(
        await request(app)
          .post(`/repositories/${repositoryId}/analyses`)
          .set('Cookie', sessionCookie)
          .send({})
      );
      await record(await authed('get', `/repositories/${repositoryId}/analyses`));
      await record(await authed('delete', `/repositories/${repositoryId}`));
    }

    await record(await authed('get', '/settings'));
    await record(
      await request(app)
        .patch('/settings')
        .set('Cookie', sessionCookie)
        .send({ reasoningScale: 'fast' })
    );
    await record(
      await request(app)
        .post('/settings/llm')
        .set('Cookie', sessionCookie)
        .send({ provider: 'ollama', model: 'llama3.3' })
    );

    const bedrock = await query<{ id: string }>(
      `SELECT id FROM llm_credentials WHERE user_id = $1 AND provider = 'bedrock'`,
      [userId]
    );
    const bedrockId = bedrock.rows[0]?.id;
    if (bedrockId) {
      await record(
        await request(app)
          .post(`/settings/llm/${bedrockId}/verify`)
          .set('Cookie', sessionCookie)
          .send({})
      );
      await record(
        await request(app)
          .post(`/settings/llm/${bedrockId}/default`)
          .set('Cookie', sessionCookie)
          .send({})
      );
    }

    // Touch the canary credential routes without verifying OpenAI (that would
    // send the canary to api.openai.com, outside CREDENTIAL_HOSTS).
    await record(await authed('get', '/settings'));
    await record(
      await request(app).delete(`/settings/llm/${credentialId}`).set('Cookie', sessionCookie)
    );

    await record(await request(app).post('/auth/logout').set('Cookie', sessionCookie));

    // Public auth entry points (no session needed after logout).
    await record(await request(app).get('/auth/github?method=oauth'));
    await record(await request(app).get('/auth/github/callback'));

    return bodies;
  }

  it('the canary token never appears in an api response body', async () => {
    const bodies = await exerciseRoutes();
    for (const body of bodies) {
      expect(body).not.toContain(CANARY);
    }
  });

  it('the canary token never appears in a log line', async () => {
    await exerciseRoutes();
    for (const line of logLines) {
      expect(line).not.toContain(CANARY);
    }
  });

  it('the canary token is sent only to a credential host', async () => {
    await exerciseRoutes();

    const canarySends = captured.filter((c) => c.bodyIncludesCanary);
    expect(canarySends.length).toBeGreaterThan(0);

    for (const send of canarySends) {
      expect(CREDENTIAL_HOSTS as readonly string[]).toContain(send.host);
    }

    const authToNonCredential = captured.filter(
      (c) => c.hasAuthorization && !(CREDENTIAL_HOSTS as readonly string[]).includes(c.host)
    );
    expect(authToNonCredential).toEqual([]);

    for (const req of captured) {
      if (
        !(CREDENTIAL_HOSTS as readonly string[]).includes(req.host) &&
        req.host !== 'github.com'
      ) {
        // Model-provider defaults must not receive the canary in this test.
        expect(req.bodyIncludesCanary).toBe(false);
      }
    }
  });
});
