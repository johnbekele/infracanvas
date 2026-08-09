// Integration tests exercise the data layer, which imports env() and would
// otherwise refuse to start over unrelated missing variables. Only DATABASE_URL
// is a real input; the rest are placeholders that satisfy validation.
//
// Every assignment is conditional so that a developer pointing at their own
// database or key keeps their value.
const defaults: Record<string, string> = {
  DATABASE_URL: 'postgres://infracanvas:infracanvas@localhost:5433/infracanvas?sslmode=disable',
  ENCRYPTION_KEY: '0'.repeat(64),
  JWT_SECRET: 'integration-test-jwt-secret-not-used-for-anything-real',
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  APP_URL: 'http://localhost:5173',
  API_URL: 'http://localhost:3001',
  NODE_ENV: 'test',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
