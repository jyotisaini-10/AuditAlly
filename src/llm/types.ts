/** LLM explanation for a single accessibility violation. */
export interface ViolationExplanation {
  plainLanguageExplanation: string;
  whyItMatters: string;
  suggestedFixCode: string;
  /** Echo / refine of axe impact, or LLM judgment if axe impact was null. */
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  /** LLM self-reported confidence in the suggested fix. */
  confidence: 'high' | 'medium' | 'low';
  /** True when the model failed and we returned a safe fallback. */
  isFallback?: boolean;
  /** Optional model note about confidence (used later in UI). */
  confidenceNote?: string;
}

export interface ExplainUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
}

export interface ExplainResult {
  explanation: ViolationExplanation;
  usage: ExplainUsage;
  attempts: number;
}
