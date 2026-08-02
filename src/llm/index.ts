export { explainViolation, explainViolations, isLlmConfigured, isMockLlm } from './explain';
export type { ViolationExplanation, ExplainUsage, ExplainResult } from './types';
export { parseExplanationJson, fallbackExplanation, buildExplainPrompt } from './prompt';
