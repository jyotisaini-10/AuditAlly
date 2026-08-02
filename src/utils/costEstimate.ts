import type { ExplainUsage } from '../llm/types';

export interface CostBreakdown {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedUsd: number;
  reusedCount: number;
  model: string;
}

/**
 * Groq pricing (configurable via env, defaults to llama-3.3-70b approximate rates).
 * Prices are per 1 million tokens.
 */
function inputCostPer1M(): number {
  return Number(process.env.GROQ_INPUT_COST_PER_1M) || 0.59;
}

function outputCostPer1M(): number {
  return Number(process.env.GROQ_OUTPUT_COST_PER_1M) || 0.79;
}

export function buildCostBreakdown(
  usage: ExplainUsage,
  reusedCount = 0
): CostBreakdown {
  const estimatedUsd =
    (usage.promptTokens / 1_000_000) * inputCostPer1M() +
    (usage.completionTokens / 1_000_000) * outputCostPer1M();

  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    estimatedUsd: Math.round(estimatedUsd * 1_000_000) / 1_000_000, // 6 decimal places
    reusedCount,
    model: usage.model,
  };
}
