import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import IORedis from 'ioredis';
import { scanUrl } from '../scanner';
import { explainViolations } from '../llm';
import { persistScanResult } from '../db/scans';
import { setCachedScan, cacheDisabled } from '../cache';
import { buildCostBreakdown } from '../utils/costEstimate';
import type { ExplainUsage } from '../llm/types';
import type { AxeViolation } from '../scanner/types';

export interface ScanJobData {
  url: string;
  explain: boolean;
  userId: string | null;
}

export interface ScanJobProgress {
  phase: 'scanning' | 'scan_complete' | 'explaining' | 'persisting' | 'done';
  message?: string;
  index?: number;
  total?: number;
  violationCount?: number;
  scanDurationMs?: number;
  url?: string;
  violations?: ScanJobResult['violations'];
  violation?: AxeViolation & { explanation?: unknown };
}

export interface ScanJobResult {
  jobId?: string;
  url: string;
  timestamp: string;
  violations: Array<AxeViolation & { explanation?: unknown }>;
  violationCount: number;
  incompleteCount: number;
  passesCount: number;
  scanDurationMs: number;
  llm?: {
    enabled: boolean;
    mock: boolean;
    usage: ExplainUsage;
  };
  llmCostUsd?: number;
  llmReusedCount?: number;
  accessibilityScore?: number;
  scoreBreakdown?: unknown;
  comparison?: unknown;
  scanId?: string;
}

const QUEUE_NAME = 'scan';
let queue: Queue | null = null;
let queueEvents: QueueEvents | null = null;
let redisClient: IORedis | null = null;

function getRedisConfig() {
  const uri = process.env.REDIS_URI || 'redis://localhost:6379/2';
  return new IORedis(uri, { maxRetriesPerRequest: null });
}

export function getRedisConnection(): IORedis {
  if (!redisClient) {
    redisClient = getRedisConfig();
  }
  return redisClient;
}

function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, { connection: getRedisConnection() });
  }
  return queue;
}

export function getQueueEvents(): QueueEvents {
  if (!queueEvents) {
    queueEvents = new QueueEvents(QUEUE_NAME, {
      connection: getRedisConfig(),
    });
  }
  return queueEvents;
}

export async function enqueueScan(
  data: ScanJobData
): Promise<{ jobId: string }> {
  const job = await getQueue().add('scan', data, {
    removeOnComplete: { age: 3600 * 24 },
    removeOnFail: { age: 3600 * 24 },
  });
  return { jobId: job.id! };
}

export async function getJobSnapshot(jobId: string): Promise<{
  id: string;
  status: string;
  progress: ScanJobProgress | null;
  result?: ScanJobResult;
  failedReason?: string;
}> {
  const job = await Job.fromId(getQueue(), jobId);
  if (!job) {
    return { id: jobId, status: 'unknown', progress: null };
  }

  const state = await job.getState();
  const progress = (job.progress as ScanJobProgress | number | null) ?? null;

  return {
    id: jobId,
    status: state,
    progress: typeof progress === 'object' ? (progress as ScanJobProgress) : null,
    result: state === 'completed' ? (job.returnvalue as ScanJobResult) : undefined,
    failedReason: state === 'failed' ? job.failedReason : undefined,
  };
}

export function startScanWorker(): Worker {
  const { isMockLlm, isLlmConfigured, explainViolations: explain } = require('../llm') as {
    isMockLlm: () => boolean;
    isLlmConfigured: () => boolean;
    explainViolations: typeof explainViolations;
  };

  const worker = new Worker<ScanJobData, ScanJobResult>(
    QUEUE_NAME,
    async (job) => {
      const { url, explain: doExplain, userId } = job.data;

      // Phase 1: Scan
      await job.updateProgress({
        phase: 'scanning',
        message: `Scanning ${url} with axe-core…`,
        url,
      } satisfies ScanJobProgress);

      const scan = await scanUrl(url);

      await job.updateProgress({
        phase: 'scan_complete',
        message: `Found ${scan.violations.length} violation(s) — generating AI explanations…`,
        violationCount: scan.violations.length,
        scanDurationMs: scan.scanDurationMs,
        url: scan.url,
        violations: scan.violations,
      } satisfies ScanJobProgress);

      // Phase 2: LLM explanations
      let violations: ScanJobResult['violations'] = scan.violations;
      let llm: ScanJobResult['llm'] = {
        enabled: false,
        mock: isMockLlm(),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, model: 'none' },
      };
      let llmCostUsd = 0;
      let llmReusedCount = 0;

      if (doExplain && scan.violations.length > 0 && isLlmConfigured()) {
        const redis = getRedisConnection();
        const { explanations, totalUsage, reusedCount } = await explain(
          scan.violations,
          url,
          async ({ index, total, violation, explanation }) => {
            const enriched = { ...violation, explanation };
            await job.updateProgress({
              phase: 'explaining',
              message: `Explaining violation ${index + 1} of ${total}…`,
              index,
              total,
              violation: enriched,
            } satisfies ScanJobProgress);
          },
          redis
        );

        violations = scan.violations.map((v, i) => ({
          ...v,
          explanation: explanations[i].explanation,
        }));

        const cost = buildCostBreakdown(totalUsage, reusedCount);
        llm = { enabled: true, mock: isMockLlm(), usage: totalUsage };
        llmCostUsd = cost.estimatedUsd;
        llmReusedCount = reusedCount;
      }

      // Phase 3: Persist
      await job.updateProgress({
        phase: 'persisting',
        message: 'Saving results…',
      } satisfies ScanJobProgress);

      const result: ScanJobResult = {
        jobId: job.id,
        url: scan.url,
        timestamp: scan.timestamp,
        violations,
        violationCount: violations.length,
        incompleteCount: scan.incompleteCount,
        passesCount: scan.passesCount,
        scanDurationMs: scan.scanDurationMs,
        llm,
        llmCostUsd,
        llmReusedCount,
      };

      try {
        const { scan: saved, enriched } = await persistScanResult({ userId, result });
        Object.assign(result, enriched, { scanId: String(saved._id) });
      } catch (err) {
        console.error('[worker] persist failed:', err);
      }

      // Cache
      if (doExplain && !cacheDisabled()) {
        try {
          const { setCachedScan: setCache } = await import('../cache');
          await setCache(getRedisConnection(), url, result);
        } catch {
          // non-fatal
        }
      }

      await job.updateProgress({ phase: 'done', message: 'Complete' } satisfies ScanJobProgress);
      return result;
    },
    {
      connection: getRedisConfig(),
      concurrency: 2,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} failed:`, err?.message);
  });

  return worker;
}
