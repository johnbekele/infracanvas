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

function getEnv(): EnvConfig {
  const authProvider = parseAuthProvider(process.env.AUTH_PROVIDER);

  const requiredVars = ['DATABASE_URL', 'ENCRYPTION_KEY', 'JWT_SECRET', 'APP_URL', 'API_URL'];

  // Only the OAuth provider ever reads these, and demanding them under the
  // token provider is what made a fresh clone unrunnable without first
  // registering a GitHub application.
  if (authProvider === 'oauth') {
    requiredVars.push('GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET');
  }

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
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',
  };
}
