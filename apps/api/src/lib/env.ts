// Environment variable validation and access
// Throws at startup if required variables are missing

interface EnvConfig {
  // GitHub OAuth
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;

  // MongoDB
  MONGODB_URI: string;

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

function getEnv(): EnvConfig {
  const requiredVars = [
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'MONGODB_URI',
    'ENCRYPTION_KEY',
    'JWT_SECRET',
    'APP_URL',
    'API_URL',
  ];

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
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID!,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET!,
    MONGODB_URI: process.env.MONGODB_URI!,
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
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    MONGODB_URI: process.env.MONGODB_URI,
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
