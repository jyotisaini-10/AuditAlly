import type IORedis from 'ioredis';
import type { ScanJobResult } from '../jobs/scanQueue';

export interface CacheMeta {
  hit: boolean;
  ageSeconds: number;
  ttlSeconds: number;
  cachedAt: string;
}

export interface CachedScan {
  meta: CacheMeta;
  payload: {
    result: ScanJobResult;
    cachedAt: string;
  };
}

const PREFIX = 'auditally:scan:v1:';

export function cacheDisabled(): boolean {
  return process.env.SCAN_CACHE_DISABLED === '1';
}

function ttlSeconds(): number {
  const raw = Number(process.env.SCAN_CACHE_TTL_SECONDS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 3600; // 1 hour default
}

function cacheKey(url: string): string {
  return `${PREFIX}${url}`;
}

export async function getCachedScan(
  redis: IORedis,
  url: string
): Promise<CachedScan | null> {
  const raw = await redis.get(cacheKey(url));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { result: ScanJobResult; cachedAt: string };
    const ttl = ttlSeconds();
    const cachedAt = new Date(parsed.cachedAt);
    const ageSeconds = Math.floor((Date.now() - cachedAt.getTime()) / 1000);

    return {
      meta: {
        hit: true,
        ageSeconds,
        ttlSeconds: ttl,
        cachedAt: parsed.cachedAt,
      },
      payload: parsed,
    };
  } catch {
    await redis.del(cacheKey(url));
    return null;
  }
}

export async function setCachedScan(
  redis: IORedis,
  url: string,
  result: ScanJobResult
): Promise<CacheMeta> {
  const ttl = ttlSeconds();
  const cachedAt = new Date().toISOString();
  const payload = JSON.stringify({ result, cachedAt });
  await redis.set(cacheKey(url), payload, 'EX', ttl);
  return { hit: false, ageSeconds: 0, ttlSeconds: ttl, cachedAt };
}
