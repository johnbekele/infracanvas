// Simple in-memory rate limiting
// For production, use Redis-based rate limiting
import { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory store for rate limits
// In production, use Redis or similar
const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}, 60000); // Clean every minute

interface RateLimitOptions {
  windowMs: number; // Time window in milliseconds
  max: number; // Max requests per window
  keyGenerator?: (req: Request) => string;
}

/**
 * Create a rate limiting middleware
 */
export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, keyGenerator } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Generate key for this request
    const key = keyGenerator
      ? keyGenerator(req)
      : req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';

    const now = Date.now();
    const entry = rateLimitStore.get(key);

    if (!entry || entry.resetAt < now) {
      // Start new window
      rateLimitStore.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      next();
      return;
    }

    if (entry.count >= max) {
      // Rate limited
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      res.setHeader('X-RateLimit-Limit', max.toString());
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', entry.resetAt.toString());

      res.status(429).json({
        error: 'Too many requests',
        retryAfter,
      });
      return;
    }

    // Increment counter
    entry.count++;
    rateLimitStore.set(key, entry);

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', max.toString());
    res.setHeader('X-RateLimit-Remaining', (max - entry.count).toString());
    res.setHeader('X-RateLimit-Reset', entry.resetAt.toString());

    next();
  };
}

// Pre-configured rate limiters
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 auth attempts per 15 minutes
});

export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
});
