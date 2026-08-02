import OpenAI from 'openai';
import type IORedis from 'ioredis';
import type { AxeViolation, ViolationNode } from '../scanner/types';
import {
  buildExplainPrompt,
  buildRetryPrompt,
  fallbackExplanation,
  parseExplanationJson,
} from './prompt';
import type { ExplainResult, ExplainUsage, ViolationExplanation } from './types';
import { getCachedExplanation, setCachedExplanation } from '../cache/explanationCache';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const MAX_ATTEMPTS = 2; // initial + one correction retry

let client: OpenAI | null = null;

function getModel(): string {
  return process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;
}

function getClient(): OpenAI {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'GROQ_API_KEY is not set. Add it to .env to enable LLM explanations.'
    );
  }
  if (!client) {
    client = new OpenAI({
      apiKey,
      baseURL: GROQ_BASE_URL,
    });
  }
  return client;
}

export function isLlmConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY?.trim()) || isMockLlm();
}

export function isMockLlm(): boolean {
  return process.env.AUDITALLY_LLM_MOCK === '1';
}

/**
 * Explain one axe violation node. Retries once on malformed JSON;
 * returns a graceful fallback if still invalid or the API fails.
 */
export async function explainViolation(
  violation: AxeViolation,
  node: ViolationNode,
  pageUrl: string
): Promise<ExplainResult> {
  if (isMockLlm()) {
    return mockExplain(violation, node);
  }

  const { system, user } = buildExplainPrompt(violation, node, pageUrl);
  let attempts = 0;
  let usage: ExplainUsage = emptyUsage(getModel());
  let lastRaw = '';
  let lastError = 'unknown';

  try {
    const openai = getClient();
    const model = getModel();

    // Attempt 1
    attempts = 1;
    const first = await chatJson(openai, model, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    usage = mergeUsage(usage, first.usage, model);
    lastRaw = first.content;

    try {
      const explanation = parseExplanationJson(first.content);
      return { explanation, usage, attempts };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    // Attempt 2 — correction
    attempts = 2;
    const second = await chatJson(openai, model, [
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: first.content },
      { role: 'user', content: buildRetryPrompt(first.content, lastError) },
    ]);
    usage = mergeUsage(usage, second.usage, model);
    lastRaw = second.content;

    try {
      const explanation = parseExplanationJson(second.content);
      return { explanation, usage, attempts };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[llm] malformed JSON after retry for ${violation.id}: ${lastError}`
      );
      console.warn(`[llm] raw (truncated): ${lastRaw.slice(0, 200)}`);
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[llm] API error for ${violation.id}: ${lastError}`);
  }

  return {
    explanation: fallbackExplanation(violation, lastError),
    usage,
    attempts: Math.max(attempts, 1),
  };
}

/**
 * Explain every violation (first node only per rule for Step 3 cost control).
 * Assumption: one explanation per rule ID is enough for the initial UI;
 * later we can explain additional nodes on demand.
 */
export async function explainViolations(
  violations: AxeViolation[],
  pageUrl: string,
  onEach?: (payload: {
    index: number;
    total: number;
    violation: AxeViolation;
    explanation: ViolationExplanation;
    usage: ExplainUsage;
    reused: boolean;
  }) => void | Promise<void>,
  redis?: IORedis | null
): Promise<{
  explanations: Array<{
    ruleId: string;
    explanation: ViolationExplanation;
    usage: ExplainUsage;
    reused: boolean;
  }>;
  totalUsage: ExplainUsage;
  reusedCount: number;
}> {
  const explanations: Array<{
    ruleId: string;
    explanation: ViolationExplanation;
    usage: ExplainUsage;
    reused: boolean;
  }> = [];
  let totalUsage = emptyUsage(getModel());
  let reusedCount = 0;

  for (let i = 0; i < violations.length; i++) {
    const violation = violations[i];
    const node = violation.nodes[0] ?? {
      target: [],
      html: '',
      failureSummary: '',
    };

    let result: ExplainResult;
    let reused = false;

    if (redis && !isMockLlm()) {
      const cached = await getCachedExplanation(redis, violation);
      if (cached) {
        reused = true;
        reusedCount += 1;
        result = {
          explanation: cached,
          usage: emptyUsage(getModel()),
          attempts: 0,
        };
      } else {
        result = await explainViolation(violation, node, pageUrl);
        if (!result.explanation.isFallback) {
          await setCachedExplanation(redis, violation, result.explanation);
        }
      }
    } else {
      result = await explainViolation(violation, node, pageUrl);
    }

    explanations.push({
      ruleId: violation.id,
      explanation: result.explanation,
      usage: result.usage,
      reused,
    });
    totalUsage = mergeUsage(totalUsage, result.usage, totalUsage.model);
    await onEach?.({
      index: i,
      total: violations.length,
      violation,
      explanation: result.explanation,
      usage: result.usage,
      reused,
    });
  }

  return { explanations, totalUsage, reusedCount };
}

async function chatJson(
  openai: OpenAI,
  model: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
): Promise<{ content: string; usage: ExplainUsage }> {
  const completion = await openai.chat.completions.create({
    model,
    messages,
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });

  const content = completion.choices[0]?.message?.content ?? '';
  const usage: ExplainUsage = {
    promptTokens: completion.usage?.prompt_tokens ?? 0,
    completionTokens: completion.usage?.completion_tokens ?? 0,
    totalTokens: completion.usage?.total_tokens ?? 0,
    model,
  };
  return { content, usage };
}

function mockExplain(
  violation: AxeViolation,
  node: ViolationNode
): ExplainResult {
  const severity =
    (violation.impact as ViolationExplanation['severity']) || 'moderate';
  const explanation: ViolationExplanation = {
    plainLanguageExplanation: `[mock] ${violation.help}. The element at ${node.target.join(' ') || '(unknown)'} does not meet this rule.`,
    whyItMatters:
      '[mock] People using assistive tech may not be able to perceive or operate this control.',
    suggestedFixCode: `<!-- mock fix for ${violation.id} -->\n${node.html || '<!-- no html -->'}`,
    severity,
    confidence: 'medium',
    confidenceNote: 'Mock LLM mode (AUDITALLY_LLM_MOCK=1).',
  };
  return {
    explanation,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      model: 'mock',
    },
    attempts: 1,
  };
}

function emptyUsage(model: string): ExplainUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, model };
}

function mergeUsage(
  a: ExplainUsage,
  b: ExplainUsage,
  model: string
): ExplainUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    model,
  };
}
