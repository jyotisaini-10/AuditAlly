import crypto from 'crypto';
import { Types } from 'mongoose';
import { Scan, type IScan } from './models/Scan';
import {
  computeAccessibilityScore,
} from '../scoring/accessibilityScore';
import { compareViolations } from '../scoring/compareScans';
import type { ScanJobResult } from '../jobs/scanQueue';

export interface PersistOptions {
  userId?: string | null;
  result: ScanJobResult;
}

export interface EnrichedScanFields {
  accessibilityScore: number;
  scoreBreakdown: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    penalty: number;
  };
  comparison: {
    previousScanId: string | null;
    fixed: number;
    new: number;
    unchanged: number;
  } | null;
  llmCostUsd?: number;
}

/**
 * Persist a completed scan + LLM explanations to MongoDB.
 * Also computes:
 *  - accessibility score (weighted penalty)
 *  - regression diff vs most recent prior scan of same URL
 */
export async function persistScanResult(opts: PersistOptions): Promise<{
  scan: IScan;
  enriched: EnrichedScanFields;
}> {
  const { userId, result } = opts;

  const userObjId = userId ? new Types.ObjectId(userId) : null;

  // Compute score
  const { score, breakdown } = computeAccessibilityScore(
    (result.violations ?? []) as Array<{ impact?: string | null; explanation?: { severity?: string } }>
  );

  // Regression diff: find most recent prior scan of same URL by same user
  let comparison: {
    previousScanId: string | null;
    fixed: number;
    new: number;
    unchanged: number;
  } | null = null;

  if (userObjId) {
    const previousScan = await Scan.findOne({
      userId: userObjId,
      url: result.url,
      status: 'completed',
    })
      .sort({ scannedAt: -1 })
      .select({ violations: 1, _id: 1 })
      .lean();

    if (previousScan) {
      const diff = compareViolations(
        previousScan.violations ?? [],
        result.violations ?? [],
        String(previousScan._id)
      );
      comparison = {
        previousScanId: diff.previousScanId,
        fixed: diff.fixed,
        new: diff.new,
        unchanged: diff.unchanged,
      };
    }
  }

  const scan = await Scan.create({
    userId: userObjId,
    jobId: result.jobId,
    url: result.url,
    scannedAt: result.timestamp ? new Date(result.timestamp) : new Date(),
    violationCount: result.violationCount ?? result.violations?.length ?? 0,
    incompleteCount: result.incompleteCount ?? 0,
    passesCount: result.passesCount ?? 0,
    scanDurationMs: result.scanDurationMs ?? 0,
    violations: result.violations ?? [],
    accessibilityScore: score,
    scoreBreakdown: breakdown,
    comparison: comparison
      ? {
          previousScanId: comparison.previousScanId
            ? new Types.ObjectId(comparison.previousScanId)
            : null,
          fixed: comparison.fixed,
          new: comparison.new,
          unchanged: comparison.unchanged,
        }
      : undefined,
    llm: result.llm,
    llmCostUsd: (result as { llmCostUsd?: number }).llmCostUsd,
    llmReusedCount: (result as { llmReusedCount?: number }).llmReusedCount ?? 0,
    status: 'completed',
  });

  return {
    scan,
    enriched: {
      accessibilityScore: score,
      scoreBreakdown: breakdown,
      comparison,
      llmCostUsd: (result as { llmCostUsd?: number }).llmCostUsd,
    },
  };
}

export async function listScansForUser(
  userId: string,
  opts: { limit?: number; skip?: number; url?: string } = {}
): Promise<{ scans: IScan[]; total: number }> {
  const { limit = 20, skip = 0, url } = opts;
  const query: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
  if (url) query.url = url;

  const [scans, total] = await Promise.all([
    Scan.find(query).sort({ scannedAt: -1 }).skip(skip).limit(limit).lean(),
    Scan.countDocuments(query),
  ]);

  return { scans: scans as unknown as IScan[], total };
}

export async function getScanByIdForUser(
  id: string,
  userId: string
): Promise<IScan | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  return Scan.findOne({
    _id: new Types.ObjectId(id),
    userId: new Types.ObjectId(userId),
  }).lean() as Promise<IScan | null>;
}

export async function getComparisonForScan(
  id: string,
  userId: string
): Promise<{
  scan: IScan;
  comparison: {
    previousScanId: string | null;
    fixed: number;
    new: number;
    unchanged: number;
  } | null;
  previousScan: IScan | null;
} | null> {
  if (!Types.ObjectId.isValid(id)) return null;

  const scan = (await Scan.findOne({
    _id: new Types.ObjectId(id),
    userId: new Types.ObjectId(userId),
  }).lean()) as IScan | null;

  if (!scan) return null;

  const comp = scan.comparison;
  let previousScan: IScan | null = null;

  if (comp?.previousScanId) {
    previousScan = (await Scan.findById(comp.previousScanId)
      .select({ _id: 1, scannedAt: 1, violationCount: 1, accessibilityScore: 1 })
      .lean()) as IScan | null;
  }

  return {
    scan,
    comparison: comp
      ? {
          previousScanId: comp.previousScanId ? String(comp.previousScanId) : null,
          fixed: comp.fixed,
          new: comp.new,
          unchanged: comp.unchanged,
        }
      : null,
    previousScan,
  };
}

export async function getScoreHistoryForUrl(
  url: string,
  userId: string
): Promise<Array<{ scanId: string; scannedAt: string; score: number; violationCount: number }>> {
  const scans = await Scan.find({
    userId: new Types.ObjectId(userId),
    url,
    status: 'completed',
  })
    .sort({ scannedAt: 1 })
    .select({ _id: 1, scannedAt: 1, accessibilityScore: 1, violationCount: 1 })
    .limit(50)
    .lean();

  return scans.map((s) => ({
    scanId: String(s._id),
    scannedAt: (s.scannedAt as Date).toISOString(),
    score: (s.accessibilityScore as number) ?? 0,
    violationCount: (s.violationCount as number) ?? 0,
  }));
}

export async function ensureShareToken(
  id: string,
  userId: string
): Promise<string | null> {
  if (!Types.ObjectId.isValid(id)) return null;

  const scan = await Scan.findOne({
    _id: new Types.ObjectId(id),
    userId: new Types.ObjectId(userId),
  });

  if (!scan) return null;

  if (scan.shareToken) return scan.shareToken;

  const token = crypto.randomBytes(16).toString('hex');
  scan.shareToken = token;
  await scan.save();
  return token;
}

export async function getScanByShareToken(token: string): Promise<IScan | null> {
  return Scan.findOne({ shareToken: token }).lean() as Promise<IScan | null>;
}
