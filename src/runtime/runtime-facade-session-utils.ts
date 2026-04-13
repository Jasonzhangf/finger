/**
 * RuntimeFacade Session Utilities - Session 相关辅助方法（独立模块）
 * 
 * 这些方法从 RuntimeFacade 拆分出来，可以被其他模块复用。
 */

import type { Session, ISessionManager } from '../orchestration/session-types.js';
import { SessionControlPlaneStore } from './session-control-plane.js';
import { SYSTEM_PROJECT_PATH } from '../agents/finger-system-agent/index.js';
import { logger } from '../core/logger.js';

const log = logger.module('runtime-facade-session-utils');

/**
 * 判断是否是临时派发 Session ID
 * Only treat runtime-generated transient dispatch ids as ephemeral.
 */
export function isEphemeralDispatchSessionId(sessionId: string): boolean {
  return /^dispatch-\d/i.test(sessionId.trim());
}

/**
 * 判断是否是 System Agent
 */
export function isSystemAgent(agentId: string): boolean {
  return agentId.trim() === 'finger-system-agent';
}

/**
 * 判断 Session 是否允许指定 Agent 访问
 */
export function isSessionAllowedForAgent(agentId: string, session: Session): boolean {
  const normalizedAgentId = agentId.trim();
  const context = (session.context && typeof session.context === 'object')
    ? (session.context as Record<string, unknown>)
    : {};
  const ownerAgentId = typeof context.ownerAgentId === 'string' ? context.ownerAgentId.trim() : '';
  const memoryOwnerWorkerId = typeof context.memoryOwnerWorkerId === 'string'
    ? context.memoryOwnerWorkerId.trim()
    : '';
  const sessionTier = typeof context.sessionTier === 'string' ? context.sessionTier.trim().toLowerCase() : '';
  const isSystemSession = session.projectPath === SYSTEM_PROJECT_PATH
    || sessionTier === 'system'
    || ownerAgentId === 'finger-system-agent'
    || memoryOwnerWorkerId === 'finger-system-agent'
    || session.id.startsWith('system-');

  if (memoryOwnerWorkerId && memoryOwnerWorkerId !== normalizedAgentId) {
    return false;
  }
  if (ownerAgentId && ownerAgentId !== normalizedAgentId) {
    return false;
  }
  if (isSystemAgent(normalizedAgentId)) {
    return isSystemSession;
  }
  return !isSystemSession;
}

/**
 * 判断 Session ID 是否可绑定
 */
export function isBindableSessionId(
  agentId: string,
  sessionId: string,
  sessionManager: ISessionManager,
): boolean {
  const normalized = sessionId.trim();
  if (normalized.length === 0) return false;
  if (normalized === 'default') return false;
  if (isEphemeralDispatchSessionId(normalized)) return false;
  const session = sessionManager.getSession(normalized);
  if (!session) return false;
  return isSessionAllowedForAgent(agentId, session);
}

/**
 * 清理工具 Session 候选
 */
export function sanitizeToolSessionCandidate(
  agentId: string,
  candidate: string | null | undefined,
  source: string,
  sessionManager: ISessionManager,
  options?: { suppressWarn?: boolean },
): string | null {
  if (!candidate) return null;
  const normalized = candidate.trim();
  if (!normalized) return null;
  if (isBindableSessionId(agentId, normalized, sessionManager)) return normalized;
  if (!options?.suppressWarn) {
    log.warn('Ignored invalid tool session candidate', {
      agentId,
      source,
      sessionId: normalized,
      reason: isEphemeralDispatchSessionId(normalized)
        ? 'ephemeral_dispatch_id_forbidden'
        : 'session_not_found_or_agent_scope_forbidden',
    });
  }
  return null;
}

/**
 * 解析持久化的 Agent Session 绑定
 */
export function resolvePersistedAgentSessionBinding(
  agentId: string,
  sessionControlPlaneStore: SessionControlPlaneStore,
  sessionManager: ISessionManager,
): string | null {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) return null;
  try {
    const records = sessionControlPlaneStore.list({ agentId: normalizedAgentId, provider: 'finger' });
    for (const record of records) {
      const candidate = sanitizeToolSessionCandidate(
        normalizedAgentId,
        record.fingerSessionId,
        'callTool.persistedAgentBinding',
        sessionManager,
        { suppressWarn: true },
      );
      if (candidate) return candidate;
    }
  } catch (error) {
    log.warn('Failed to resolve persisted agent session binding', { agentId, error });
  }
  return null;
}
