// Environment variable access for Vercel serverless functions

export function getEnv() {
  return {
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID!,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET!,
    MONGODB_URI: process.env.MONGODB_URI!,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY!,
    JWT_SECRET: process.env.JWT_SECRET!,
    APP_URL: process.env.VITE_APP_URL || process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:5173',
    NODE_ENV: process.env.NODE_ENV || 'development',
  };
}
