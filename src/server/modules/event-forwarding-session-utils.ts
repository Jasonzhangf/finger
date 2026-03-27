/**
 * Event Forwarding - Session & Dispatch Utilities
 *
 * Extracted from event-forwarding.ts to keep file under 500 lines.
 */

import { isObjectRecord } from '../common/object.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { asString } from './event-forwarding-helpers.js';

/**
 * Resolve a potentially raw dispatch sessionId to an actual session ID.
 * Walks root/parent hierarchy to find the canonical ledger session.
 */
export function normalizeDispatchLedgerSessionId(
  sessionManager: SessionManager,
  rawSessionId: string | undefined,
): { sessionId?: string; originalSessionId?: string } {
  const lookup = (sessionId: string): { sessionId?: string; originalSessionId?: string } | null => {
    const normalized = sessionId.trim();
    if (normalized.length === 0) return null;
    if (normalized.startsWith('msg-')) return null;
    const getSession = (sessionManager as unknown as { getSession?: (id: string) => unknown }).getSession;
    if (typeof getSession !== 'function') {
      return { sessionId: normalized };
    }
    const session = getSession.call(sessionManager, normalized) as { id?: string; context?: unknown } | null;
    if (!session || typeof session.id !== 'string' || session.id.trim().length === 0) {
      return null;
    }
    const context = isObjectRecord(session.context) ? session.context : {};
    const rootSessionId = asString(context.rootSessionId) ?? asString(context.parentSessionId);
    if (rootSessionId) {
      const root = getSession.call(sessionManager, rootSessionId) as { id?: string } | null;
      if (root?.id && root.id.trim().length > 0) {
        return {
          sessionId: root.id,
          ...(root.id !== normalized ? { originalSessionId: normalized } : {}),
        };
      }
    }
    return { sessionId: session.id };
  };

  const candidates: string[] = [];
  if (typeof rawSessionId === 'string' && rawSessionId.trim().length > 0) {
    candidates.push(rawSessionId.trim());
  }

  const getCurrentSession = (sessionManager as unknown as { getCurrentSession?: () => { id?: string } | null }).getCurrentSession;
  const currentSessionId = typeof getCurrentSession === 'function'
    ? asString(getCurrentSession.call(sessionManager)?.id)
    : undefined;
  if (currentSessionId) candidates.push(currentSessionId);

  const getSystemSession = (sessionManager as unknown as { getOrCreateSystemSession?: () => { id?: string } | null }).getOrCreateSystemSession;
  const systemSessionId = typeof getSystemSession === 'function'
    ? asString(getSystemSession.call(sessionManager)?.id)
    : undefined;
  if (systemSessionId) candidates.push(systemSessionId);

  for (const candidate of candidates) {
    const resolved = lookup(candidate);
    if (resolved?.sessionId) {
      return resolved;
    }
  }

  if (typeof rawSessionId === 'string') {
    const fallback = rawSessionId.trim();
    if (fallback.length > 0 && !fallback.startsWith('msg-')) {
      return { sessionId: fallback };
    }
  }
  return {};
}
