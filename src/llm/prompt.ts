import type { AxeViolation, ViolationNode } from '../scanner/types';
import type { ViolationExplanation } from './types';

/**
 * Build the system + user prompts for explaining one axe-core violation.
 * The LLM's job is ONLY interpretation: not detection.
 */
export function buildExplainPrompt(
  violation: AxeViolation,
  node: ViolationNode,
  pageUrl: string
): { system: string; user: string } {
  const system = `You are an accessibility expert. Given an axe-core WCAG violation, you explain it in plain language and suggest a concrete fix.

You MUST respond with ONLY a valid JSON object containing these exact keys:
{
  "plainLanguageExplanation": "A 1-2 sentence explanation of what is wrong, in plain English for a developer.",
  "whyItMatters": "A 1-2 sentence explanation of who is harmed and how.",
  "suggestedFixCode": "A corrected HTML snippet. Keep it concise and directly address the violation.",
  "severity": "One of: critical | serious | moderate | minor",
  "confidence": "One of: high | medium | low",
  "confidenceNote": "Optional. If confidence is not high, briefly explain why (e.g., complex ARIA pattern)."
}

Do not include any text outside the JSON object. Do not wrap in markdown code fences.`;

  const user = `Accessibility violation detected by axe-core:

Rule ID: ${violation.id}
Impact: ${violation.impact ?? 'unknown'}
Description: ${violation.description}
Help: ${violation.help}
WCAG Tags: ${violation.tags.filter((t) => t.startsWith('wcag')).join(', ')}
Page URL: ${pageUrl}

Offending element selector: ${node.target.join(' ')}
Offending HTML:
${node.html.slice(0, 600)}

Failure summary: ${node.failureSummary?.slice(0, 300) ?? 'N/A'}

Respond with a JSON object as specified.`;

  return { system, user };
}

/**
 * Correction prompt when the first response was malformed JSON.
 */
export function buildRetryPrompt(badResponse: string, parseError: string): string {
  return `Your previous response could not be parsed as JSON. Error: "${parseError}"

Your invalid response was:
${badResponse.slice(0, 300)}

Please respond again with ONLY a valid JSON object matching the required schema. No markdown fences, no extra text.`;
}

/**
 * Parse and validate the LLM's JSON response.
 */
export function parseExplanationJson(raw: string): ViolationExplanation {
  let parsed: unknown;

  // Strip markdown code fences if present
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`JSON.parse failed on LLM output (${cleaned.slice(0, 100)}...)`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('LLM response is not an object');
  }

  const obj = parsed as Record<string, unknown>;

  const validSeverities = ['critical', 'serious', 'moderate', 'minor'];
  const validConfidences = ['high', 'medium', 'low'];

  const plainLanguageExplanation = typeof obj.plainLanguageExplanation === 'string'
    ? obj.plainLanguageExplanation
    : '';
  const whyItMatters = typeof obj.whyItMatters === 'string' ? obj.whyItMatters : '';
  const suggestedFixCode = typeof obj.suggestedFixCode === 'string' ? obj.suggestedFixCode : '';
  const severity = validSeverities.includes(obj.severity as string)
    ? (obj.severity as ViolationExplanation['severity'])
    : 'moderate';
  const confidence = validConfidences.includes(obj.confidence as string)
    ? (obj.confidence as ViolationExplanation['confidence'])
    : 'low';
  const confidenceNote = typeof obj.confidenceNote === 'string' ? obj.confidenceNote : undefined;

  if (!plainLanguageExplanation && !whyItMatters) {
    throw new Error('LLM response missing required explanation fields');
  }

  return { plainLanguageExplanation, whyItMatters, suggestedFixCode, severity, confidence, confidenceNote };
}

/**
 * Graceful fallback when LLM fails after retries.
 * Never surfaces raw error to user.
 */
export function fallbackExplanation(
  violation: AxeViolation,
  _errorDetail: string
): ViolationExplanation {
  const severity =
    (violation.impact as ViolationExplanation['severity'] | null) ?? 'moderate';

  return {
    plainLanguageExplanation: `This element violates the "${violation.id}" accessibility rule: ${violation.help}.`,
    whyItMatters:
      'This may prevent users relying on assistive technologies (screen readers, keyboard navigation) from accessing this content.',
    suggestedFixCode: violation.nodes[0]?.html ?? '<!-- see axe-core help link for fix guidance -->',
    severity,
    confidence: 'low',
    confidenceNote: 'Automated fallback — AI explanation unavailable for this violation. Check the helpUrl for guidance.',
    isFallback: true,
  };
}
