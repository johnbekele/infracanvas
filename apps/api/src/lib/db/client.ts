// Postgres connection pool shared by every route and worker in this process.
import pg from 'pg';
import { env } from '../env.js';
import { logError } from '../log.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

/**
 * Managed Postgres providers terminate unencrypted connections, but their
 * certificates are frequently signed by an internal CA that is not in the Node
 * trust store. Verification is therefore relaxed only when the connection
 * string explicitly asks for SSL, so a local instance stays plain and a
 * production instance still gets an encrypted transport.
 */
function sslConfig(connectionString: string): pg.ConnectionConfig['ssl'] {
  if (/sslmode=disable/.test(connectionString)) return undefined;
  if (/sslmode=(require|prefer|verify-ca|verify-full)/.test(connectionString)) {
    return { rejectUnauthorized: false };
  }
  return env().NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined;
}

export function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = env().DATABASE_URL;

  pool = new Pool({
    connectionString,
    ssl: sslConfig(connectionString),
    // Sized for a single API instance. The ingestion workers open their own
    // pools, so this ceiling only has to cover request-path concurrency.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Without this, a query that hangs holds a pool slot until the process dies.
    statement_timeout: 30_000,
  });

  // A pool-level error is emitted for idle clients dropped by the server. It is
  // not tied to any request, and an unhandled 'error' event would crash Node.
  pool.on('error', (error) => {
    logError('Unexpected Postgres pool error', error);
  });

  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: readonly unknown[]
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Verify the database is reachable. Used by the health endpoint and at startup. */
export async function ping(): Promise<boolean> {
  try {
    await query('SELECT 1');
    return true;
  } catch (error) {
    logError('Postgres ping failed', error);
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
