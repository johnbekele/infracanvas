// Integration tests exercise the data layer, which imports env() and would
// otherwise refuse to start over unrelated missing variables. Only DATABASE_URL
// is a real input; the rest are placeholders that satisfy validation.
//
// Every assignment is conditional so that a developer pointing at their own
// database or key keeps their value.
const defaults: Record<string, string> = {
  DATABASE_URL:
    'postgres://infracanvas:infracanvas@localhost:5433/infracanvas_test?sslmode=disable',
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

/**
 * Refuse to run against a database that is not obviously a test database.
 *
 * These tests truncate every table between cases. Pointed at a development
 * database that is one command away by name, they delete the repositories,
 * analyses and experiments someone was working with, and the only evidence is
 * an application that looks freshly installed. A conditional default is not
 * enough protection, because `DATABASE_URL` is exported in the shell for
 * `dbmate` and is then inherited here.
 *
 * The rule is the name, which is what CI already uses: `infracanvas_test`,
 * `infracanvas_e2e`, `infracanvas_bench`. Anything else has to say so.
 */
const TEST_DATABASE = /(_test|_e2e|_bench|_migrate)(\?|$)/;

const url = process.env.DATABASE_URL ?? '';
if (!TEST_DATABASE.test(url) && process.env.INTEGRATION_ALLOW_ANY_DATABASE !== 'true') {
  const name = url.split('/').pop()?.split('?')[0] ?? url;
  throw new Error(
    `Refusing to run integration tests against "${name}": these tests truncate every table, ` +
      'and that name is not a test database.\n' +
      'Use a database whose name ends in _test, for example:\n' +
      '  createdb -h localhost -p 5433 -U infracanvas infracanvas_test\n' +
      '  DATABASE_URL=postgres://infracanvas:infracanvas@localhost:5433/infracanvas_test?sslmode=disable dbmate up\n' +
      'Set INTEGRATION_ALLOW_ANY_DATABASE=true only if you meant this one.'
  );
}
