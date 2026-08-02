import type IORedis from 'ioredis';
import type { ViolationExplanation } from '../llm/types';
import { violationFingerprint, type FingerprintableViolation } from '../scoring';

const PREFIX = 'auditally:explain:v1:';

function ttlSeconds(): number {
  const raw = Number(process.env.EXPLAIN_CACHE_TTL_SECONDS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 60 * 60 * 24 * 7; // 7 days
}

export function explainCacheKey(v: FingerprintableViolation): string {
  return `${PREFIX}${violationFingerprint(v)}`;
}

export async function getCachedExplanation(
  redis: IORedis,
  v: FingerprintableViolation
): Promise<ViolationExplanation | null> {
  const raw = await redis.get(explainCacheKey(v));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ViolationExplanation;
  } catch {
    await redis.del(explainCacheKey(v));
    return null;
  }
}

export async function setCachedExplanation(
  redis: IORedis,
  v: FingerprintableViolation,
  explanation: ViolationExplanation
): Promise<void> {
  await redis.set(
    explainCacheKey(v),
    JSON.stringify(explanation),
    'EX',
    ttlSeconds()
  );
}
