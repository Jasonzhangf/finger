import type { TaskMessage } from './context-builder-types.js';

export interface ContextBuilderOnDemandView {
  sessionId: string;
  agentId: string;
  mode: string;
  buildMode: 'minimal' | 'moderate' | 'aggressive';
  targetBudget: number;
  selectedBlockIds: string[];
  metadata: Record<string, unknown>;
  messages: TaskMessage[];
  createdAt: string;
}

const onDemandViewBySessionAgent = new Map<string, ContextBuilderOnDemandView>();
const bootstrapRebuildAttemptedBySessionAgent = new Set<string>();

function makeKey(sessionId: string, agentId: string): string {
  return `${sessionId.trim()}::${agentId.trim()}`;
}

export function setContextBuilderOnDemandView(view: ContextBuilderOnDemandView): void {
  const key = makeKey(view.sessionId, view.agentId);
  onDemandViewBySessionAgent.set(key, view);
}

export function consumeContextBuilderOnDemandView(
  sessionId: string,
  agentId: string,
): ContextBuilderOnDemandView | undefined {
  const key = makeKey(sessionId, agentId);
  const hit = onDemandViewBySessionAgent.get(key);
  if (!hit) return undefined;
  onDemandViewBySessionAgent.delete(key);
  return hit;
}

export function peekContextBuilderOnDemandView(
  sessionId: string,
  agentId: string,
): ContextBuilderOnDemandView | undefined {
  const key = makeKey(sessionId, agentId);
  return onDemandViewBySessionAgent.get(key);
}

export function shouldRunContextBuilderBootstrapOnce(
  sessionId: string,
  agentId: string,
): boolean {
  const key = makeKey(sessionId, agentId);
  if (bootstrapRebuildAttemptedBySessionAgent.has(key)) return false;
  bootstrapRebuildAttemptedBySessionAgent.add(key);
  return true;
}

export function resetContextBuilderBootstrapOnce(
  sessionId: string,
  agentId: string,
): void {
  const key = makeKey(sessionId, agentId);
  bootstrapRebuildAttemptedBySessionAgent.delete(key);
}
