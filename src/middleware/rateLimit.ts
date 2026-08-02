import type { Request, Response, NextFunction } from 'express';
import type IORedis from 'ioredis';
import type { AuthedRequest } from '../auth/auth';

const PREFIX = 'auditally:ratelimit:v1:';

function windowSeconds(): number {
  return Number(process.env.RATE_LIMIT_WINDOW_SECONDS) || 3600;
}

function maxScans(): number {
  return Number(process.env.RATE_LIMIT_MAX_SCANS) || 20;
}

function isDisabled(): boolean {
  return process.env.RATE_LIMIT_DISABLED === '1';
}

function rateLimitKey(userId: string | undefined, ip: string): string {
  const identifier = userId || ip;
  const window = Math.floor(Date.now() / (windowSeconds() * 1000));
  return `${PREFIX}${window}:${identifier}`;
}

/**
 * Returns a rate-limit middleware that uses Redis sliding-window counting.
 * Falls back gracefully if Redis is unavailable.
 */
export function scanRateLimit(redis: IORedis) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (isDisabled()) {
      next();
      return;
    }

    try {
      const userId = (req as AuthedRequest).user?.userId;
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
        || req.socket.remoteAddress
        || 'unknown';

      const key = rateLimitKey(userId, ip);
      const current = await redis.incr(key);

      // Set TTL on first request in window
      if (current === 1) {
        await redis.expire(key, windowSeconds());
      }

      const limit = maxScans();
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - current)));

      if (current > limit) {
        res.status(429).json({
          error: `Rate limit exceeded. Max ${limit} scans per ${windowSeconds()}s window.`,
          retryAfterSeconds: windowSeconds(),
        });
        return;
      }
    } catch (err) {
      // Redis error → fail open (don't block legitimate requests)
      console.warn('[rateLimit] Redis error, skipping check:', err);
    }

    next();
  };
}
