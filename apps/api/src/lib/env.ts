// Environment variable validation and access
// Throws at startup if required variables are missing

/**
 * Where a GitHub token comes from.
 *
 * `oauth` is the hosted, multi-user path: each user authorises the application
 * and gets their own token. `token` is for a laptop or a single-user self-host,
 * where the operator already has a token and registering an OAuth application
 * is friction with nothing behind it.
 */
export type AuthProvider = 'oauth' | 'token';

interface EnvConfig {
  AUTH_PROVIDER: AuthProvider;

  // GitHub OAuth. Empty strings under the `token` provider, which never reads
  // them; typed as string so the OAuth routes need no null handling.
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;

  /**
   * Allow the `token` provider to authenticate a caller that is not on the
   * loopback interface. Off by default: that provider hands out a session for
   * the operator's own GitHub account, so exposing it to a network gives
   * anyone who can reach it the operator's repository access.
   */
  AUTH_TOKEN_ALLOW_REMOTE: boolean;

  // Postgres
  DATABASE_URL: string;

  // Security
  ENCRYPTION_KEY: string;
  JWT_SECRET: string;

  // URLs
  APP_URL: string;
  API_URL: string;

  // Optional AWS
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;

  /**
   * Run the job queue's worker in this process.
   *
   * On by default, so one process is a complete installation. Setting it false is
   * how a deployment separates serving traffic from running jobs, without a
   * second build or a code change.
   */
  WORKER_ENABLED: boolean;

  /**
   * How many jobs this worker runs at once.
   *
   * An analysis is dozens of GitHub requests against one user's rate limit, so
   * beyond a couple this mostly buys 429s rather than throughput.
   */
  WORKER_CONCURRENCY: number;

  /**
   * Shared credential for the internal plane in `apps/api/src/routes/internal`.
   * Optional: when it is unset those routes are not mounted at all, which is
   * the right shape for a deployment that runs nothing beside this process.
   */
  BRAIN_SERVICE_TOKEN?: string;

  // Optional
  GITHUB_WEBHOOK_SECRET?: string;
  NODE_ENV: 'development' | 'production' | 'test';
}

/** `openssl rand -hex 32` produces 64 characters; anything shorter is guessable. */
const MIN_SERVICE_TOKEN_LENGTH = 32;

function readServiceToken(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw.length < MIN_SERVICE_TOKEN_LENGTH) {
    throw new Error(
      `BRAIN_SERVICE_TOKEN must be at least ${MIN_SERVICE_TOKEN_LENGTH} characters.\n` +
        'Generate with: openssl rand -hex 32'
    );
  }
  return raw;
}

function parseAuthProvider(raw: string | undefined): AuthProvider {
  // Defaults to oauth. A deployment that forgets to set this should get the
  // multi-user flow, not one that signs everybody in as the operator.
  if (raw === undefined || raw === '') return 'oauth';
  if (raw === 'oauth' || raw === 'token') return raw;

  throw new Error(
    `AUTH_PROVIDER must be "oauth" or "token", got "${raw}".\n` +
      'Use "oauth" for a hosted multi-user deployment, or "token" for local development ' +
      'and single-user self-hosting.'
  );
}

/**
 * A worker concurrency that will not silently disable the worker.
 *
 * `Number('two')` is `NaN`, and a `NaN` concurrency claims nothing forever: the
 * queue would fill and nothing would say why. A bad value is refused at startup
 * instead, where it is one line in the log rather than a mystery.
 */
function parseConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 2;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`WORKER_CONCURRENCY must be a positive integer, got "${raw}".`);
  }

  return parsed;
}

function getEnv(): EnvConfig {
  const authProvider = parseAuthProvider(process.env.AUTH_PROVIDER);

  const requiredVars = ['DATABASE_URL', 'ENCRYPTION_KEY', 'JWT_SECRET', 'APP_URL', 'API_URL'];

  const missing = requiredVars.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        'Please check your .env file or environment configuration.'
    );
  }

  // Validate ENCRYPTION_KEY is 64 hex characters (32 bytes)
  const encryptionKey = process.env.ENCRYPTION_KEY!;
  if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string (32 bytes).\n' +
        'Generate with: openssl rand -hex 32'
    );
  }

  // A missing OAuth application is reported by GET /auth/methods rather than
  // refused here, because one process now offers both sign-in methods: an
  // operator running locally should not have to register a GitHub application
  // to start, and one deploying for a team should hear about it before a user
  // clicks the button.
  if (authProvider === 'oauth' && !process.env.GITHUB_CLIENT_ID) {
    console.warn(
      'AUTH_PROVIDER is "oauth" but GITHUB_CLIENT_ID is not set. The OAuth sign-in will be ' +
        'offered as unavailable until it is configured.'
    );
  }

  return {
    AUTH_PROVIDER: authProvider,
    AUTH_TOKEN_ALLOW_REMOTE: process.env.AUTH_TOKEN_ALLOW_REMOTE === 'true',
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? '',
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? '',
    DATABASE_URL: process.env.DATABASE_URL!,
    ENCRYPTION_KEY: encryptionKey,
    JWT_SECRET: process.env.JWT_SECRET!,
    APP_URL: process.env.APP_URL!,
    API_URL: process.env.API_URL!,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    WORKER_ENABLED: process.env.WORKER_ENABLED !== 'false',
    WORKER_CONCURRENCY: parseConcurrency(process.env.WORKER_CONCURRENCY),
    BRAIN_SERVICE_TOKEN: readServiceToken(process.env.BRAIN_SERVICE_TOKEN),
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',
  };
}

// Lazy initialization - validates on first access
let _env: EnvConfig | null = null;

export function env(): EnvConfig {
  if (!_env) {
    _env = getEnv();
  }
  return _env;
}

// For development: allow partial env without throwing
export function envSafe(): Partial<EnvConfig> {
  return {
    AUTH_PROVIDER: process.env.AUTH_PROVIDER === 'token' ? 'token' : 'oauth',
    AUTH_TOKEN_ALLOW_REMOTE: process.env.AUTH_TOKEN_ALLOW_REMOTE === 'true',
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    JWT_SECRET: process.env.JWT_SECRET,
    APP_URL: process.env.APP_URL || 'http://localhost:5173',
    API_URL: process.env.API_URL || 'http://localhost:3001',
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    WORKER_ENABLED: process.env.WORKER_ENABLED !== 'false',
    // Read without the length check: `envSafe` is the partial reader for paths
    // that must not throw, and a short token is refused at the boundary that
    // uses it rather than by a getter.
    BRAIN_SERVICE_TOKEN: process.env.BRAIN_SERVICE_TOKEN,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',
  };
}
