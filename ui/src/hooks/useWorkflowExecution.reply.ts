import type { RuntimeTokenUsage } from './useWorkflowExecution.types.js';
import { estimateTokenUsage, isRecord, parseNumberLike } from './useWorkflowExecution.utils.js';
import { DEFAULT_CHAT_AGENT_ID } from './useWorkflowExecution.constants.js';

function normalizeTokenUsage(source: Record<string, unknown>): RuntimeTokenUsage | undefined {
  const usage = isRecord(source.usage) ? source.usage : source;
  const prompt = parseNumberLike(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.promptTokens,
    usage.inputTokens,
  );
  const completion = parseNumberLike(
    usage.completion_tokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.outputTokens,
  );
  const total = parseNumberLike(
    usage.total_tokens,
    usage.totalTokens,
  );

  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  return {
    ...(prompt !== undefined ? { inputTokens: prompt } : {}),
    ...(completion !== undefined ? { outputTokens: completion } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
    estimated: false,
  };
}

export function extractTokenUsageFromRoundTrace(source: Record<string, unknown>): RuntimeTokenUsage | undefined {
  const traces = source.round_trace ?? source.roundTrace;
  if (!Array.isArray(traces) || traces.length === 0) return undefined;
  for (let i = traces.length - 1; i >= 0; i -= 1) {
    const item = traces[i];
    if (!isRecord(item)) continue;
    const inputTokens = parseNumberLike(item.input_tokens, item.inputTokens);
    const outputTokens = parseNumberLike(item.output_tokens, item.outputTokens);
    const totalTokens = parseNumberLike(item.total_tokens, item.totalTokens);
    if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) continue;
    return {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      estimated: false,
    };
  }
  return undefined;
}

function parseTokenUsage(candidate: Record<string, unknown>): RuntimeTokenUsage | undefined {
  const fromCandidate = normalizeTokenUsage(candidate);
  if (fromCandidate) return fromCandidate;
  if (isRecord(candidate.metadata)) {
    const fromMetadata = normalizeTokenUsage(candidate.metadata);
    if (fromMetadata) return fromMetadata;
    const fromRoundTrace = extractTokenUsageFromRoundTrace(candidate.metadata);
    if (fromRoundTrace) return fromRoundTrace;
  }
  const fromRoundTrace = extractTokenUsageFromRoundTrace(candidate);
  if (fromRoundTrace) return fromRoundTrace;
  return undefined;
}

export function extractChatReply(result: unknown): {
  reply: string;
  agentId: string;
  tokenUsage?: RuntimeTokenUsage;
  pendingInputAccepted?: boolean;
} {
  const candidate = isRecord(result) && isRecord(result.output) ? result.output : result;

  if (typeof candidate === 'string') {
    return { reply: candidate, agentId: DEFAULT_CHAT_AGENT_ID, tokenUsage: estimateTokenUsage(candidate) };
  }

  if (!isRecord(candidate)) {
    const reply = JSON.stringify(candidate);
    return { reply, agentId: DEFAULT_CHAT_AGENT_ID, tokenUsage: estimateTokenUsage(reply) };
  }

  const agentId = typeof candidate.module === 'string' ? candidate.module : DEFAULT_CHAT_AGENT_ID;
  const metadata = isRecord(candidate.metadata) ? candidate.metadata : null;
  const pendingInputAccepted =
    candidate.pendingInputAccepted === true
    || metadata?.pendingInputAccepted === true;
  if (candidate.success === false) {
    const error = typeof candidate.error === 'string' ? candidate.error : 'finger-general request failed';
    throw new Error(error);
  }

  if (typeof candidate.response === 'string' && candidate.response.trim().length > 0) {
    return {
      reply: candidate.response,
      agentId,
      tokenUsage: parseTokenUsage(candidate) ?? estimateTokenUsage(candidate.response),
      ...(pendingInputAccepted ? { pendingInputAccepted: true } : {}),
    };
  }

  if (typeof candidate.output === 'string' && candidate.output.trim().length > 0) {
    return {
      reply: candidate.output,
      agentId,
      tokenUsage: parseTokenUsage(candidate) ?? estimateTokenUsage(candidate.output),
      ...(pendingInputAccepted ? { pendingInputAccepted: true } : {}),
    };
  }

  if (typeof candidate.error === 'string' && candidate.error.length > 0) {
    throw new Error(candidate.error);
  }

  const reply = JSON.stringify(candidate, null, 2);
  return {
    reply,
    agentId,
    tokenUsage: parseTokenUsage(candidate) ?? estimateTokenUsage(reply),
    ...(pendingInputAccepted ? { pendingInputAccepted: true } : {}),
  };
}
