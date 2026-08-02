import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { scanUrl } from './scanner';
import type { AxeViolation, ScanResult } from './scanner';
import {
  explainViolations,
  isLlmConfigured,
  isMockLlm,
  type ViolationExplanation,
  type ExplainUsage,
} from './llm';
import { isSafePublicUrl, normalizeScanUrl } from './utils/urlSafety';
import {
  enqueueScan,
  getJobSnapshot,
  startScanWorker,
  getQueueEvents,
  getRedisConnection,
  type ScanJobProgress,
  type ScanJobResult,
} from './jobs/scanQueue';
import { connectMongo } from './db';
import {
  listScansForUser,
  getScanByIdForUser,
  persistScanResult,
  getComparisonForScan,
  getScoreHistoryForUrl,
  ensureShareToken,
  getScanByShareToken,
} from './db/scans';
import {
  authRouter,
  optionalAuth,
  requireAuth,
  type AuthedRequest,
} from './auth';
import {
  getCachedScan,
  setCachedScan,
  cacheDisabled,
  type CacheMeta,
} from './cache';
import { scanRateLimit } from './middleware/rateLimit';
import { generateHtmlReport } from './reports/generateReport';
import { buildCostBreakdown } from './utils/costEstimate';

const PORT = Number(process.env.PORT) || 3000;

export interface ExplainedViolation extends AxeViolation {
  explanation: ViolationExplanation;
}

export interface ExplainedScanResult extends ScanResult {
  violations: ExplainedViolation[];
  llm: {
    enabled: boolean;
    mock: boolean;
    usage: ExplainUsage;
  };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'auditally',
    step: 8,
    llm: {
      configured: isLlmConfigured(),
      mock: isMockLlm(),
    },
    cache: {
      disabled: cacheDisabled(),
      ttlSeconds: Number(process.env.SCAN_CACHE_TTL_SECONDS) || 3600,
    },
  });
});

app.use('/auth', authRouter);

/**
 * GET /scans — past scans for the authenticated user
 * Query: ?limit=&skip=&url=
 */
app.get(
  '/scans',
  requireAuth,
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const limit = Number(req.query.limit) || 20;
      const skip = Number(req.query.skip) || 0;
      const url = typeof req.query.url === 'string' ? req.query.url : undefined;
      const { scans, total } = await listScansForUser(req.user!.userId, {
        limit,
        skip,
        url,
      });
      res.json({
        total,
        scans: scans.map((s) => ({
          id: String((s as { _id: unknown })._id),
          url: s.url,
          scannedAt: s.scannedAt,
          violationCount: s.violationCount,
          accessibilityScore: s.accessibilityScore,
          status: s.status,
          jobId: s.jobId,
          llm: s.llm,
          scanDurationMs: s.scanDurationMs,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /scans/score-history?url= — trend line data for a URL */
app.get(
  '/scans/score-history',
  requireAuth,
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
      if (!url) {
        res.status(400).json({ error: 'Missing url query parameter' });
        return;
      }
      const history = await getScoreHistoryForUrl(url, req.user!.userId);
      res.json({ url, history });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /scans/:id — full scan detail (must belong to user) */
app.get(
  '/scans/:id',
  requireAuth,
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const scan = await getScanByIdForUser(req.params.id, req.user!.userId);
      if (!scan) {
        res.status(404).json({ error: 'Scan not found' });
        return;
      }
      res.json(scan);
    } catch (err) {
      next(err);
    }
  }
);

/** GET /scans/:id/compare — regression diff vs previous scan of same URL */
app.get(
  '/scans/:id/compare',
  requireAuth,
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await getComparisonForScan(req.params.id, req.user!.userId);
      if (!data) {
        res.status(404).json({ error: 'Scan not found' });
        return;
      }
      res.json({
        scanId: String(data.scan._id),
        url: data.scan.url,
        comparison: data.comparison ?? data.scan.comparison ?? null,
        previousScan: data.previousScan
          ? {
              id: String(data.previousScan._id),
              scannedAt: data.previousScan.scannedAt,
              violationCount: data.previousScan.violationCount,
              accessibilityScore: data.previousScan.accessibilityScore,
            }
          : null,
      });
    } catch (err) {
      next(err);
    }
  }
);

/** POST /scans/:id/share — create public share token for HTML report */
app.post(
  '/scans/:id/share',
  requireAuth,
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const token = await ensureShareToken(req.params.id, req.user!.userId);
      if (!token) {
        res.status(404).json({ error: 'Scan not found' });
        return;
      }
      const base = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
      res.json({
        shareToken: token,
        reportUrl: `${base}/reports/${token}`,
      });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /reports/:token — public HTML report (no auth) */
app.get('/reports/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const scan = await getScanByShareToken(req.params.token);
    if (!scan) {
      res.status(404).send('Report not found');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(generateHtmlReport(scan));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scan { url, async?, explain?, force? }
 * Auth optional — if Bearer token present, scan is tied to that user.
 * Cache: within TTL, returns cached axe+LLM result (skip Puppeteer + Groq).
 * Pass force=true to bypass cache.
 */
app.post(
  '/scan',
  scanRateLimit(getRedisConnection()),
  optionalAuth,
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const url = await parseAndValidateUrl(req, res);
      if (!url) return;

      const explain = req.body?.explain !== false;
      const asyncMode = req.body?.async !== false;
      const force = req.body?.force === true;
      const userId = req.user?.userId ?? null;

      // --- Redis URL cache (Step 7) ---
      if (explain && !force && !cacheDisabled()) {
        const cached = await getCachedScan(getRedisConnection(), url);
        if (cached) {
          let result = cached.payload.result;
          try {
            const { scan: saved, enriched } = await persistScanResult({
              userId,
              result: {
                ...result,
                // fresh timestamp for this user's history row
                timestamp: new Date().toISOString(),
              },
            });
            result = {
              ...result,
              ...enriched,
              scanId: saved._id.toString(),
            };
          } catch (persistErr) {
            console.error('[scan] cache-hit persist failed:', persistErr);
          }

          res.status(200).json({
            cached: true,
            cache: cached.meta,
            result,
          });
          return;
        }
      }

      if (asyncMode) {
        if (explain && !isLlmConfigured()) {
          res.status(503).json({
            error:
              'LLM not configured. Set GROQ_API_KEY in .env, or AUDITALLY_LLM_MOCK=1 for mock explanations.',
          });
          return;
        }
        const { jobId } = await enqueueScan({ url, explain, userId });
        res.status(202).json({
          jobId,
          cached: false,
          statusUrl: `/scan/${jobId}`,
          streamUrl: `/scan/${jobId}/stream`,
        });
        return;
      }

      // --- sync path ---
      const scan = await scanUrl(url);

      if (!explain || scan.violations.length === 0) {
        const payload = !explain
          ? scan
          : {
              ...scan,
              llm: {
                enabled: false,
                mock: isMockLlm(),
                usage: {
                  promptTokens: 0,
                  completionTokens: 0,
                  totalTokens: 0,
                  model: isMockLlm() ? 'mock' : 'none',
                },
              },
            };

        if (explain) {
          try {
            const { scan: saved, enriched } = await persistScanResult({
              userId,
              result: {
                ...scan,
                llm: (payload as ExplainedScanResult).llm,
              },
            });
            const result = {
              ...payload,
              ...enriched,
              scanId: saved._id.toString(),
            };
            await maybeCache(url, result as ScanJobResult, explain);
            res.json({ cached: false, result });
            return;
          } catch (persistErr) {
            console.error('[scan] persist failed:', persistErr);
          }
        }
        res.json({ cached: false, result: payload });
        return;
      }

      if (!isLlmConfigured()) {
        res.status(503).json({
          error:
            'LLM not configured. Set GROQ_API_KEY in .env, or AUDITALLY_LLM_MOCK=1 for mock explanations.',
          scan,
        });
        return;
      }

      const { explanations, totalUsage, reusedCount } = await explainViolations(
        scan.violations,
        url,
        undefined,
        getRedisConnection()
      );

      const payload: ExplainedScanResult = {
        ...scan,
        violations: scan.violations.map((v, i) => ({
          ...v,
          explanation: explanations[i].explanation,
        })),
        llm: {
          enabled: true,
          mock: isMockLlm(),
          usage: totalUsage,
        },
      };

      const cost = buildCostBreakdown(totalUsage, reusedCount);
      (payload as ExplainedScanResult & { llmCostUsd?: number; llmReusedCount?: number }).llmCostUsd =
        cost.estimatedUsd;
      (payload as ExplainedScanResult & { llmReusedCount?: number }).llmReusedCount =
        reusedCount;

      try {
        const { scan: saved, enriched } = await persistScanResult({
          userId,
          result: payload,
        });
        const result = {
          ...payload,
          ...enriched,
          scanId: saved._id.toString(),
        };
        await maybeCache(url, result, explain);
        res.json({ cached: false, result });
      } catch (persistErr) {
        console.error('[scan] persist failed:', persistErr);
        res.json({ cached: false, result: payload });
      }
    } catch (err) {
      next(err);
    }
  }
);

async function maybeCache(
  url: string,
  result: ScanJobResult,
  explain: boolean
): Promise<CacheMeta | null> {
  if (!explain || cacheDisabled()) return null;
  try {
    return await setCachedScan(getRedisConnection(), url, result);
  } catch (err) {
    console.warn('[scan] cache write failed:', err);
    return null;
  }
}

app.get('/scan/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const snapshot = await getJobSnapshot(req.params.jobId);
    if (snapshot.status === 'unknown' && snapshot.progress === null) {
      res.status(404).json({ error: 'Job not found', jobId: req.params.jobId });
      return;
    }
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

app.get('/scan/:jobId/stream', async (req: Request, res: Response) => {
  const jobId = req.params.jobId;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const events = getQueueEvents();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onProgress = (args: any) => {
    const id: string = args.jobId;
    const data = args.data;
    if (id !== jobId) return;
    const progress = data as ScanJobProgress;
    send('progress', progress);
    if (progress.phase === 'explaining' && progress.violation?.explanation) {
      send('violation', {
        index: progress.index,
        total: progress.total,
        violation: progress.violation,
      });
    }
  };

  const onCompleted = async ({ jobId: id }: { jobId: string }) => {
    if (id !== jobId) return;
    const snapshot = await getJobSnapshot(jobId);
    send('completed', snapshot);
    cleanup();
    res.end();
  };

  const onFailed = async ({
    jobId: id,
    failedReason,
  }: {
    jobId: string;
    failedReason: string;
  }) => {
    if (id !== jobId) return;
    send('failed', { jobId, error: failedReason });
    cleanup();
    res.end();
  };

  const cleanup = () => {
    events.off('progress', onProgress);
    events.off('completed', onCompleted);
    events.off('failed', onFailed);
  };

  events.on('progress', onProgress);
  events.on('completed', onCompleted);
  events.on('failed', onFailed);

  try {
    const snapshot = await getJobSnapshot(jobId);
    if (snapshot.status === 'unknown') {
      send('failed', { jobId, error: 'Job not found' });
      cleanup();
      res.end();
      return;
    }
    send('progress', snapshot.progress ?? { status: snapshot.status });
    if (snapshot.status === 'completed') {
      send('completed', snapshot);
      cleanup();
      res.end();
      return;
    }
    if (snapshot.status === 'failed') {
      send('failed', { jobId, error: snapshot.failedReason });
      cleanup();
      res.end();
      return;
    }
  } catch (err) {
    send('failed', {
      jobId,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    cleanup();
    res.end();
  }

  req.on('close', cleanup);
});

app.post('/scan/stream', optionalAuth, async (req: AuthedRequest, res: Response) => {
  const url = await parseAndValidateUrl(req, res);
  if (!url) return;

  if (!isLlmConfigured()) {
    res.status(503).json({
      error:
        'LLM not configured. Set GROQ_API_KEY in .env, or AUDITALLY_LLM_MOCK=1 for mock explanations.',
    });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    send('status', { phase: 'scanning', url });
    const scan = await scanUrl(url);
    send('scan_complete', {
      url: scan.url,
      timestamp: scan.timestamp,
      violationCount: scan.violationCount,
      incompleteCount: scan.incompleteCount,
      passesCount: scan.passesCount,
      scanDurationMs: scan.scanDurationMs,
    });

    if (scan.violations.length === 0) {
      send('done', { violationCount: 0, llm: { mock: isMockLlm() } });
      res.end();
      return;
    }

    send('status', { phase: 'explaining', total: scan.violations.length });

    const { explanations, totalUsage, reusedCount } = await explainViolations(
      scan.violations,
      url,
      async ({ index, total, violation, explanation, usage }) => {
        send('violation', { index, total, violation, explanation, usage });
      },
      getRedisConnection()
    );

    const cost = buildCostBreakdown(totalUsage, reusedCount);
    const payload = {
      ...scan,
      violations: scan.violations.map((v, i) => ({
        ...v,
        explanation: explanations[i].explanation,
      })),
      llm: { enabled: true, mock: isMockLlm(), usage: totalUsage },
      llmCostUsd: cost.estimatedUsd,
      llmReusedCount: reusedCount,
    };

    try {
      const { scan: saved, enriched } = await persistScanResult({
        userId: req.user?.userId,
        result: payload,
      });
      send('done', {
        violationCount: scan.violations.length,
        scanId: saved._id.toString(),
        accessibilityScore: enriched.accessibilityScore,
        comparison: enriched.comparison,
        llm: payload.llm,
        llmCostUsd: enriched.llmCostUsd,
      });
    } catch {
      send('done', {
        violationCount: scan.violations.length,
        llm: payload.llm,
      });
    }
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    send('error', { error: 'Scan failed', detail: message });
    res.end();
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status =
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
      ? (err as { status: number }).status
      : 500;
  const message = err instanceof Error ? err.message : 'Unknown error';
  if (status >= 500) console.error('[error]', message);
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : message,
    ...(status >= 500 ? { detail: message } : {}),
  });
});

async function parseAndValidateUrl(
  req: Request,
  res: Response
): Promise<string | null> {
  const rawUrl = req.body?.url;
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    res.status(400).json({
      error: 'Missing or invalid "url" in request body. Expected { "url": "https://..." }.',
    });
    return null;
  }

  let url: string;
  try {
    url = normalizeScanUrl(rawUrl);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Invalid URL',
    });
    return null;
  }

  const safety = await isSafePublicUrl(url);
  if (!safety.ok) {
    res.status(400).json({ error: safety.reason });
    return null;
  }

  return url;
}

async function main(): Promise<void> {
  if (!process.env.REDIS_URI) {
    process.env.REDIS_URI = 'redis://localhost:6379/2';
  }

  await connectMongo();
  startScanWorker();

  app.listen(PORT, () => {
    console.log(`AuditAlly listening on http://localhost:${PORT}`);
    console.log(`POST /auth/signup  /auth/login`);
    console.log(`GET  /auth/me      /scans  /scans/:id`);
    console.log(`POST /scan → cache hit 200 | miss 202 { jobId }`);
    console.log(`Redis: ${process.env.REDIS_URI}`);
    console.log(
      `LLM: ${
        isMockLlm()
          ? 'MOCK'
          : isLlmConfigured()
            ? 'Groq configured'
            : 'NOT configured'
      }`
    );
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

export { app };
