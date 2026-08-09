// CORS middleware
import { type Request, type Response, type NextFunction } from 'express';
import { envSafe } from '../lib/env.js';

/**
 * CORS middleware for API routes
 * Allows credentials and configures allowed origins
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const config = envSafe();
  const allowedOrigins = [
    config.APP_URL,
    'http://localhost:5173', // Vite dev server
    'http://localhost:3000', // Alternative dev port
  ].filter(Boolean) as string[];

  const origin = req.headers.origin;

  // Check if origin is allowed
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  // Allow credentials (cookies)
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Allowed methods
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');

  // Allowed headers
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  // Expose custom headers
  res.setHeader('Access-Control-Expose-Headers', 'X-Refreshed-Token');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}
