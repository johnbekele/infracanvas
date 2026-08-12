// InfraCanvas API Server
import express from 'express';
import { corsMiddleware } from './middleware/cors.js';
import authRoutes from './routes/auth/index.js';
import githubRoutes from './routes/github/index.js';
import { mountInternalRoutes } from './routes/internal/index.js';
import repositoryRoutes from './routes/repositories/index.js';
import settingsRoutes from './routes/settings/index.js';
import { closePool, ping } from './lib/db/client.js';
import { startWorker, stopWorker } from './lib/jobs/runtime.js';
import { TRUST_PROXY_HOPS } from './middleware/rate-limit.js';
import { logError } from './lib/log.js';
import { env } from './lib/env.js';
import { useSystemCertificateAuthorities } from './lib/tls.js';

// Before any outbound call, so a corporate TLS proxy does not make every LLM
// provider look unreachable.
useSystemCertificateAuthorities();

// Read the configuration before binding a port. It is validated lazily, so
// without this a misconfigured process starts, accepts traffic, and reports the
// problem as a database failure on the first request that touches one.
try {
  env();
} catch (error) {
  logError('Refusing to start', error);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3001;

// How many reverse proxies sit in front of this process, so `req.ip` is the
// caller rather than the proxy. Zero locally; one behind a platform router.
// Rate limiting keys off this, so an over-permissive value would let a caller
// pick their own bucket by setting X-Forwarded-For.
app.set('trust proxy', TRUST_PROXY_HOPS);

// Middleware
app.use(express.json({ limit: '10mb' }));

// Mounted before CORS, and only when a service token is configured. Nothing in
// a browser calls the internal plane, so it is kept off the surface that exists
// for one.
mountInternalRoutes(app);

app.use(corsMiddleware);

// Health check. Reports the database separately so a load balancer can tell a
// process that is up from one that cannot serve requests.
app.get('/health', async (_req, res) => {
  const database = await ping();
  res.status(database ? 200 : 503).json({
    status: database ? 'ok' : 'degraded',
    database: database ? 'up' : 'down',
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.use('/auth', authRoutes);
app.use('/github', githubRoutes);
app.use('/repositories', repositoryRoutes);
app.use('/settings', settingsRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logError('Unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`InfraCanvas API server running on port ${PORT}`);
});

startWorker();

// Graceful shutdown. The worker is stopped before the pool closes, because
// handing a job back to the queue is a database write: closing the pool first
// would leave every in-flight job stranded until its lease lapsed.
const shutdown = async () => {
  console.log('Shutting down gracefully...');
  server.close();
  await stopWorker();
  await closePool();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default app;
