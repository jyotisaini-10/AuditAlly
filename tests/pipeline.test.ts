/**
 * Integration tests for the A11YScan pipeline.
 * Tests: LLM prompt construction, scan parsing, caching logic, and DB persistence.
 * Runs with Jest + ts-jest; all external services are mocked.
 */

import { buildExplainPrompt, parseExplanationJson, fallbackExplanation } from '../src/llm/prompt';
import { violationFingerprint } from '../src/scoring/violationFingerprint';
import { compareViolations } from '../src/scoring/compareScans';
import { computeAccessibilityScore } from '../src/scoring/accessibilityScore';
import type { AxeViolation } from '../src/scanner/types';
import type { ViolationExplanation } from '../src/llm/types';

// ─── Fixtures ────────────────────────────────────────────────
const mockViolation: AxeViolation = {
  id: 'image-alt',
  impact: 'critical',
  description: 'Ensures <img> elements have alternate text.',
  help: 'Images must have alternate text',
  helpUrl: 'https://dequeuniversity.com/rules/axe/4.9/image-alt',
  tags: ['cat.text-alternatives', 'wcag2a', 'wcag111'],
  nodes: [
    {
      target: ['#hero-img'],
      html: '<img src="hero.jpg" />',
      failureSummary: 'Fix any of the following: Element does not have an alt attribute',
    },
  ],
};

const mockExplanation: ViolationExplanation = {
  plainLanguageExplanation: 'This image is missing an alt attribute.',
  whyItMatters: 'Screen reader users cannot understand the image.',
  suggestedFixCode: '<img src="hero.jpg" alt="Hero banner" />',
  severity: 'critical',
  confidence: 'high',
};

// ─── 1. LLM Prompt Construction ──────────────────────────────

describe('buildExplainPrompt', () => {
  it('includes rule ID in user prompt', () => {
    const { user } = buildExplainPrompt(
      mockViolation,
      mockViolation.nodes[0],
      'https://example.com'
    );
    expect(user).toContain('image-alt');
  });

  it('includes offending HTML in user prompt', () => {
    const { user } = buildExplainPrompt(
      mockViolation,
      mockViolation.nodes[0],
      'https://example.com'
    );
    expect(user).toContain('<img src="hero.jpg" />');
  });

  it('includes page URL in user prompt', () => {
    const { user } = buildExplainPrompt(
      mockViolation,
      mockViolation.nodes[0],
      'https://example.com'
    );
    expect(user).toContain('https://example.com');
  });

  it('system prompt requests JSON output', () => {
    const { system } = buildExplainPrompt(
      mockViolation,
      mockViolation.nodes[0],
      'https://example.com'
    );
    expect(system).toContain('JSON');
    expect(system).toContain('plainLanguageExplanation');
    expect(system).toContain('suggestedFixCode');
  });
});

// ─── 2. LLM JSON Parsing ────────────────────────────────────

describe('parseExplanationJson', () => {
  it('parses a valid JSON response', () => {
    const raw = JSON.stringify(mockExplanation);
    const parsed = parseExplanationJson(raw);
    expect(parsed.plainLanguageExplanation).toBe(mockExplanation.plainLanguageExplanation);
    expect(parsed.confidence).toBe('high');
    expect(parsed.severity).toBe('critical');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n' + JSON.stringify(mockExplanation) + '\n```';
    const parsed = parseExplanationJson(raw);
    expect(parsed.confidence).toBe('high');
  });

  it('defaults severity to "moderate" for unknown values', () => {
    const raw = JSON.stringify({ ...mockExplanation, severity: 'unknown-value' });
    const parsed = parseExplanationJson(raw);
    expect(parsed.severity).toBe('moderate');
  });

  it('defaults confidence to "low" for unknown values', () => {
    const raw = JSON.stringify({ ...mockExplanation, confidence: 'uncertain' });
    const parsed = parseExplanationJson(raw);
    expect(parsed.confidence).toBe('low');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseExplanationJson('not json at all')).toThrow();
  });

  it('throws on empty object missing required fields', () => {
    expect(() => parseExplanationJson('{}')).toThrow();
  });
});

// ─── 3. Fallback Explanation ─────────────────────────────────

describe('fallbackExplanation', () => {
  it('returns a fallback with isFallback=true', () => {
    const result = fallbackExplanation(mockViolation, 'parse error');
    expect(result.isFallback).toBe(true);
    expect(result.confidence).toBe('low');
  });

  it('includes the rule ID in the explanation', () => {
    const result = fallbackExplanation(mockViolation, 'error');
    expect(result.plainLanguageExplanation).toContain('image-alt');
  });

  it('uses axe impact as severity', () => {
    const result = fallbackExplanation(mockViolation, 'error');
    expect(result.severity).toBe('critical');
  });
});

// ─── 4. Violation Fingerprinting ─────────────────────────────

describe('violationFingerprint', () => {
  it('returns a stable 16-char hex string', () => {
    const fp = violationFingerprint(mockViolation);
    expect(fp).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(fp)).toBe(true);
  });

  it('is deterministic for the same input', () => {
    expect(violationFingerprint(mockViolation)).toBe(violationFingerprint(mockViolation));
  });

  it('differs for different rule IDs', () => {
    const other: AxeViolation = { ...mockViolation, id: 'color-contrast' };
    expect(violationFingerprint(mockViolation)).not.toBe(violationFingerprint(other));
  });

  it('differs for different selectors', () => {
    const other: AxeViolation = {
      ...mockViolation,
      nodes: [{ ...mockViolation.nodes[0], target: ['#footer-img'] }],
    };
    expect(violationFingerprint(mockViolation)).not.toBe(violationFingerprint(other));
  });
});

// ─── 5. Scan Comparison / Regression Diffing ─────────────────

describe('compareViolations', () => {
  const v1: AxeViolation = mockViolation;
  const v2: AxeViolation = {
    ...mockViolation,
    id: 'color-contrast',
    nodes: [{ target: ['#text'], html: '<p style="color:#ccc">...</p>', failureSummary: '' }],
  };
  const v3: AxeViolation = {
    ...mockViolation,
    id: 'label',
    nodes: [{ target: ['input'], html: '<input />', failureSummary: '' }],
  };

  it('identifies fixed violations (in prev, not in curr)', () => {
    const result = compareViolations([v1, v2], [v1], 'prev-id');
    expect(result.fixed).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.new).toBe(0);
  });

  it('identifies new violations (in curr, not in prev)', () => {
    const result = compareViolations([v1], [v1, v3], 'prev-id');
    expect(result.new).toBe(1);
    expect(result.fixed).toBe(0);
    expect(result.unchanged).toBe(1);
  });

  it('identifies unchanged violations', () => {
    const result = compareViolations([v1, v2], [v1, v2], 'prev-id');
    expect(result.unchanged).toBe(2);
    expect(result.fixed).toBe(0);
    expect(result.new).toBe(0);
  });

  it('handles empty previous (first scan)', () => {
    const result = compareViolations([], [v1, v2], null);
    expect(result.new).toBe(2);
    expect(result.fixed).toBe(0);
    expect(result.unchanged).toBe(0);
  });
});

// ─── 6. Accessibility Score Computation ──────────────────────

describe('computeAccessibilityScore', () => {
  it('returns 100 for no violations', () => {
    const { score } = computeAccessibilityScore([]);
    expect(score).toBe(100);
  });

  it('deducts more for critical than minor', () => {
    const { score: critScore } = computeAccessibilityScore([{ impact: 'critical' }]);
    const { score: minorScore } = computeAccessibilityScore([{ impact: 'minor' }]);
    expect(critScore).toBeLessThan(minorScore);
  });

  it('clamps score to 0 for many violations', () => {
    const violations = Array.from({ length: 20 }, () => ({ impact: 'critical' as const }));
    const { score } = computeAccessibilityScore(violations);
    expect(score).toBe(0);
  });

  it('prefers LLM severity over axe impact', () => {
    const v = { impact: 'minor' as const, explanation: { severity: 'critical' as const } };
    const { breakdown } = computeAccessibilityScore([v]);
    expect(breakdown.critical).toBe(1);
    expect(breakdown.minor).toBe(0);
  });
});
