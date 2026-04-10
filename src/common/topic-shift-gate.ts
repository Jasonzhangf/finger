/**
 * Topic Shift Gate Types and Resolution Logic
 * 
 * Provides structured types for multi-turn topic-shift confidence gating
 * and LLM-backed recheck decision for context rebuild.
 * 
 * Part of finger-283.4: LLM recheck tool pipeline
 */

export interface TopicShiftRecheckInput {
  previousGoal: string;
  currentGoal: string;
  windowSize: number;
  confidenceSequence: number[];
  evidenceSummary: string;
  pendingTaskAnchor?: string;
  recentUserIntent?: string;
  sessionId: string;
  agentId: string;
}

export interface TopicShiftRecheckResult {
  should_rebuild: boolean;
  confidence: number;
  reason: string;
  risk_of_forgetting_recent: number;
  evidence_summary: string;
}

export interface TopicShiftGateContext {
  sessionId: string;
  agentId: string;
}

/**
 * Resolve topic-shift recheck with deterministic fallback.
 * 
 * If LLM-based resolution is not available, uses rule-based fallback:
 * - rebuild if mean confidence >= 75 and goal transition is clear
 * - risk assessment based on evidence completeness
 */
export async function resolveTopicShiftRecheck(
  input: TopicShiftRecheckInput,
  context: TopicShiftGateContext,
): Promise<TopicShiftRecheckResult> {
  const { previousGoal, currentGoal, confidenceSequence, evidenceSummary } = input;

  // Rule-based fallback (LLM integration would be injected by runtime)
  const hasClearTransition = previousGoal !== currentGoal
    && previousGoal.length > 10
    && currentGoal.length > 10;

  const meanConfidence = confidenceSequence.length > 0
    ? confidenceSequence.reduce((a, b) => a + b, 0) / confidenceSequence.length
    : 0;

  const highConfidenceRatio = confidenceSequence.length > 0
    ? confidenceSequence.filter((c) => c >= 70).length / confidenceSequence.length
    : 0;

  // Rebuild decision: mean >= 75, high confidence ratio >= 0.67, clear transition
  const should_rebuild = hasClearTransition
    && meanConfidence >= 75
    && highConfidenceRatio >= 0.67;

  // Risk assessment: incomplete evidence increases risk
  const hasEvidence = evidenceSummary && evidenceSummary.length > 20;
  const hasPendingTask = input.pendingTaskAnchor && input.pendingTaskAnchor.length > 10;
  const risk_of_forgetting_recent = hasEvidence && hasPendingTask
    ? Math.max(10, 100 - meanConfidence)
    : Math.max(40, 100 - meanConfidence);

  const reason = should_rebuild
    ? `rule_based_rebuild_approved:mean=${meanConfidence.toFixed(1)},ratio=${highConfidenceRatio.toFixed(2)}`
    : `rule_based_rebuild_rejected:mean=${meanConfidence.toFixed(1)},transition=${hasClearTransition}`;

  return {
    should_rebuild,
    confidence: Math.round(meanConfidence),
    reason,
    risk_of_forgetting_recent: Math.round(risk_of_forgetting_recent),
    evidence_summary: evidenceSummary || '',
  };
}

/**
 * Build recheck input from window gate state.
 */
export function buildRecheckInputFromWindow(
  sessionId: string,
  agentId: string,
  entries: Array<{
    turnId: string;
    confidence: number;
    fromTopic?: string;
    toTopic?: string;
    rationale?: string;
  }>,
  previousGoal: string,
  currentGoal: string,
  pendingTaskAnchor?: string,
  recentUserIntent?: string,
): TopicShiftRecheckInput {
  const confidenceSequence = entries.map((e) => e.confidence);
  const evidenceSummary = entries
    .map((e) => `${e.turnId}:conf=${e.confidence},from=${e.fromTopic ?? 'unknown'},to=${e.toTopic ?? 'unknown'}`)
    .join('\n');

  return {
    previousGoal,
    currentGoal,
    windowSize: entries.length,
    confidenceSequence,
    evidenceSummary,
    pendingTaskAnchor,
    recentUserIntent,
    sessionId,
    agentId,
  };
}