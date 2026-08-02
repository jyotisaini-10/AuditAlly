export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

export interface ScoreBreakdown {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
  penalty: number;
}

export interface AccessibilityScoreResult {
  score: number;
  breakdown: ScoreBreakdown;
}

export const SEVERITY_WEIGHTS: Record<Severity, number> = {
  critical: 25,
  serious: 10,
  moderate: 4,
  minor: 1,
};

/**
 * Weighted penalty score: starts at 100, subtracts per violation.
 * Score is clamped to [0, 100].
 */
export function computeAccessibilityScore(
  violations: Array<{ impact?: string | null; explanation?: { severity?: string } }>
): AccessibilityScoreResult {
  const breakdown: ScoreBreakdown = {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
    penalty: 0,
  };

  let penalty = 0;

  for (const v of violations) {
    // Prefer LLM severity if available; fall back to axe impact
    const sev =
      (v.explanation?.severity as Severity | undefined) ||
      (v.impact as Severity | null) ||
      'moderate';

    const weight = SEVERITY_WEIGHTS[sev as Severity] ?? SEVERITY_WEIGHTS.moderate;
    breakdown[sev as Severity] = (breakdown[sev as Severity] ?? 0) + 1;
    penalty += weight;
  }

  breakdown.penalty = penalty;
  const score = Math.max(0, Math.min(100, 100 - penalty));

  return { score, breakdown };
}
