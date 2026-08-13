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

  /**
   * How long a new experiment lives before the sweeper may reclaim it, and what
   * it is allowed to cost. Both are set on the row at creation rather than read
   * at sweep time, so changing them later does not silently extend or shrink the
   * guardrails on experiments that already exist.
   */
  EXPERIMENT_DEFAULT_TTL_HOURS: number;
  EXPERIMENT_DEFAULT_BUDGET_USD: number;

  // Optional AWS
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  /** Always populated: `getEnv` applies a default, so no caller needs a fallback. */
  AWS_REGION: string;

  // Optional
  GITHUB_WEBHOOK_SECRET?: string;
  NODE_ENV: 'development' | 'production' | 'test';
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
 * A positive number from the environment, or `fallback` when unset.
 *
 * Rejects zero, a negative, and anything unparseable rather than falling back,
 * because a misspelled budget silently becoming the default is how an experiment
 * gets a cap nobody chose. The database CHECK refuses a non-positive budget
 * anyway; failing here means hearing about it at startup rather than on the first
 * request that tries to create one.
 */
function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}".`);
  }
  return value;
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
    EXPERIMENT_DEFAULT_TTL_HOURS: positiveNumber(
      'EXPERIMENT_DEFAULT_TTL_HOURS',
      process.env.EXPERIMENT_DEFAULT_TTL_HOURS,
      8
    ),
    EXPERIMENT_DEFAULT_BUDGET_USD: positiveNumber(
      'EXPERIMENT_DEFAULT_BUDGET_USD',
      process.env.EXPERIMENT_DEFAULT_BUDGET_USD,
      50
    ),
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
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
    EXPERIMENT_DEFAULT_TTL_HOURS: positiveNumber(
      'EXPERIMENT_DEFAULT_TTL_HOURS',
      process.env.EXPERIMENT_DEFAULT_TTL_HOURS,
      8
    ),
    EXPERIMENT_DEFAULT_BUDGET_USD: positiveNumber(
      'EXPERIMENT_DEFAULT_BUDGET_USD',
      process.env.EXPERIMENT_DEFAULT_BUDGET_USD,
      50
    ),
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',
  };
}
