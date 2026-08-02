/**
 * Step 7 cache check: miss → scan, hit → instant cached response.
 * Requires API running with AUDITALLY_LLM_MOCK=1.
 *
 * Usage: npx ts-node scripts/test-cache.ts
 */
const BASE = process.env.API_BASE || 'http://localhost:3000';
const TEST_URL = process.env.TEST_URL || 'https://example.com';

interface ScanResponseBody {
  cached?: boolean;
  jobId?: string;
  cache?: { ageSeconds?: number; ttlSeconds?: number };
  result?: { violationCount?: number; scanId?: string };
}

interface JobSnapshot {
  status: string;
  failedReason?: string;
  result?: { violationCount?: number; scanId?: string };
}

async function scan(force = false): Promise<{
  status: number;
  ms: number;
  body: ScanResponseBody;
}> {
  const started = Date.now();
  const res = await fetch(`${BASE}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: TEST_URL, force }),
  });
  const body = (await res.json()) as ScanResponseBody;
  return { status: res.status, ms: Date.now() - started, body };
}

async function waitJob(jobId: string): Promise<JobSnapshot> {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(`${BASE}/scan/${jobId}`);
    const snap = (await res.json()) as JobSnapshot;
    if (snap.status === 'completed') return snap;
    if (snap.status === 'failed') throw new Error(snap.failedReason || 'failed');
  }
  throw new Error('timeout');
}

async function main() {
  console.log('Force refresh (cache miss path)…');
  const first = await scan(true);
  console.log('  HTTP', first.status, first.ms + 'ms', 'cached=', first.body.cached);

  if (first.status === 202 && first.body.jobId) {
    const snap = await waitJob(first.body.jobId);
    console.log(
      '  job completed, violations=',
      snap.result?.violationCount,
      'scanId=',
      snap.result?.scanId
    );
  } else if (first.body.cached) {
    console.log('  unexpected cache hit on force=true');
  }

  // Small delay so cache SET is visible even under slow Redis
  await new Promise((r) => setTimeout(r, 200));

  console.log('Second request (expect cache hit)…');
  const second = await scan(false);
  console.log(
    '  HTTP',
    second.status,
    second.ms + 'ms',
    'cached=',
    second.body.cached,
    'age=',
    second.body.cache?.ageSeconds
  );

  if (!(second.status === 200 && second.body.cached === true)) {
    console.error('FAIL: expected cache hit');
    process.exitCode = 1;
    return;
  }
  if (second.ms > 5000) {
    console.warn('WARN: cache hit was slow (>5s):', second.ms);
  }
  if ((second.body.cache?.ageSeconds ?? 999) > 30) {
    console.warn(
      'WARN: cache age high after force refresh:',
      second.body.cache?.ageSeconds
    );
  }
  console.log('CACHE_OK');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
