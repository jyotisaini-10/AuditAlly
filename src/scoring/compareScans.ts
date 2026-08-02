import { violationFingerprint, type FingerprintableViolation } from './violationFingerprint';

export interface ComparisonItem {
  fingerprint: string;
  ruleId: string;
  target: string[];
}

export interface ScanComparison {
  previousScanId: string | null;
  fixed: number;
  new: number;
  unchanged: number;
  fixedItems: ComparisonItem[];
  newItems: ComparisonItem[];
  unchangedItems: ComparisonItem[];
}

function toItem(v: FingerprintableViolation): ComparisonItem {
  return {
    fingerprint: violationFingerprint(v),
    ruleId: v.id,
    target: v.nodes[0]?.target ?? [],
  };
}

export function compareViolations(
  previous: FingerprintableViolation[],
  current: FingerprintableViolation[],
  previousScanId: string | null
): ScanComparison {
  const prevMap = new Map(previous.map((v) => [violationFingerprint(v), v]));
  const currMap = new Map(current.map((v) => [violationFingerprint(v), v]));

  const fixedItems: ComparisonItem[] = [];
  const newItems: ComparisonItem[] = [];
  const unchangedItems: ComparisonItem[] = [];

  for (const [fp, v] of prevMap) {
    if (currMap.has(fp)) {
      unchangedItems.push(toItem(currMap.get(fp)!));
    } else {
      fixedItems.push(toItem(v));
    }
  }

  for (const [fp, v] of currMap) {
    if (!prevMap.has(fp)) {
      newItems.push(toItem(v));
    }
  }

  return {
    previousScanId,
    fixed: fixedItems.length,
    new: newItems.length,
    unchanged: unchangedItems.length,
    fixedItems,
    newItems,
    unchangedItems,
  };
}
