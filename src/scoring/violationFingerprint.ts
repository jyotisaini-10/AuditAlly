import crypto from 'crypto';

export interface FingerprintableViolation {
  id: string;
  nodes: Array<{ target: string[]; html: string }>;
}

/**
 * Stable fingerprint for a violation: ruleId + first-node selector + trimmed HTML (first 200 chars).
 * Used for:
 *  - deduplicating LLM explanations across scans of the same page
 *  - regression diffing (fixed / new / unchanged)
 */
export function violationFingerprint(v: FingerprintableViolation): string {
  const node = v.nodes[0];
  const target = node?.target?.join(' ') ?? '';
  const html = (node?.html ?? '').trim().slice(0, 200);
  const raw = `${v.id}|${target}|${html}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}