import { FINGER_PROJECT_AGENT_ID } from '../../../agents/finger-general/finger-general-module.js';

const TARGET_ALIAS_MAP = new Map<string, string>([
  ['finger-orchestrator', FINGER_PROJECT_AGENT_ID],
  ['finger-orchestrator-gateway', FINGER_PROJECT_AGENT_ID],
  ['finger-project-agent-gateway', FINGER_PROJECT_AGENT_ID],
  ['finger-general', FINGER_PROJECT_AGENT_ID],
  ['chat-codex-gateway', 'chat-codex'],
]);

export interface DispatchTargetNormalizationResult {
  targetAgentId: string;
  normalizedFrom?: string;
  invalidReason?: string;
}

export function normalizeDispatchTargetAgentId(rawTargetAgentId: string): DispatchTargetNormalizationResult {
  const trimmed = rawTargetAgentId.trim();
  if (!trimmed) return { targetAgentId: '' };

  const aliasTarget = TARGET_ALIAS_MAP.get(trimmed.toLowerCase());
  if (aliasTarget) {
    return {
      targetAgentId: aliasTarget,
      normalizedFrom: trimmed,
    };
  }

  if (trimmed.toLowerCase().endsWith('-gateway')) {
    return {
      targetAgentId: trimmed,
      invalidReason: `gateway module id is not dispatchable: ${trimmed}; use concrete agent id (e.g. ${FINGER_PROJECT_AGENT_ID})`,
    };
  }

  return { targetAgentId: trimmed };
}
