import type { Request } from 'express';
import type { OrchestrationProfile } from '../../orchestration/orchestration-config.js';
import { buildOrchestrationDispatchPrompt, type OrchestrationPromptAgent } from '../../orchestration/orchestration-prompt.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { getActiveReviewPolicy } from '../orchestration/review-policy.js';
import { SYSTEM_PROJECT_PATH } from '../../agents/finger-system-agent/index.js';
import { isObjectRecord } from '../common/object.js';
import type { MessageRouteDeps } from './message-types.js';

export function resolveActiveOrchestrationProfile(config: { activeProfileId: string; profiles: OrchestrationProfile[] }): OrchestrationProfile | null {
  const activeId = config.activeProfileId;
  return config.profiles.find((item) => item.id === activeId) ?? null;
}

export function shouldInjectProfileReviewPolicy(target: string, deps: MessageRouteDeps): boolean {
  const normalized = target.trim();
  return normalized === deps.primaryOrchestratorTarget
    || normalized === deps.primaryOrchestratorAgentId
    || normalized === deps.primaryOrchestratorGatewayId
    || normalized === deps.legacyOrchestratorAgentId
    || normalized === deps.legacyOrchestratorGatewayId;
}

export function withDefaultProfileReviewPolicy(target: string, message: unknown, deps: MessageRouteDeps): unknown {
  if (!shouldInjectProfileReviewPolicy(target, deps)) return message;
  const reviewPolicy = getActiveReviewPolicy();
  if (reviewPolicy.enabled !== true) return message;
  if (!isObjectRecord(message)) return message;
  const metadata = isObjectRecord(message.metadata) ? message.metadata : {};
  if (isObjectRecord(metadata.review)) return message;
  return {
    ...message,
    metadata: {
      ...metadata,
      review: {
        enabled: true,
        ...(Array.isArray(reviewPolicy.stages) && reviewPolicy.stages.length > 0 ? { stages: reviewPolicy.stages } : {}),
        ...(typeof reviewPolicy.strictness === 'string' && reviewPolicy.strictness.trim().length > 0
          ? { strictness: reviewPolicy.strictness.trim() }
          : {}),
      },
    },
  };
}

export function isPrimaryOrchestratorTarget(target: string, deps: MessageRouteDeps): boolean {
  const normalized = target.trim();
  if (normalized.length === 0) return false;
  return normalized === deps.primaryOrchestratorTarget
    || normalized === deps.primaryOrchestratorAgentId
    || normalized === deps.primaryOrchestratorGatewayId
    || normalized === deps.legacyOrchestratorAgentId
    || normalized === deps.legacyOrchestratorGatewayId;
}

export function isDirectAgentRouteAllowed(req: Request, deps: MessageRouteDeps): boolean {
  if (deps.allowDirectAgentRoute) return true;
  if (process.env.NODE_ENV === 'test') return true;
  const mode = req.header('x-finger-route-mode');
  return typeof mode === 'string' && mode.trim().toLowerCase() === 'test';
}

export function buildOrchestrationPromptInjection(
  message: unknown,
  profile: OrchestrationProfile | null,
  deps: MessageRouteDeps,
): {
  updatedMessage: unknown;
  injectedPrompt: string | null;
  agents: OrchestrationPromptAgent[];
} {
  if (!profile || !isObjectRecord(message)) {
    return { updatedMessage: message, injectedPrompt: null, agents: [] };
  }
  const metadata = isObjectRecord(message.metadata) ? message.metadata : {};
  const { prompt, agents } = buildOrchestrationDispatchPrompt(profile, { selfAgentId: deps.primaryOrchestratorAgentId });
  if (!prompt) {
    return { updatedMessage: message, injectedPrompt: null, agents };
  }
  const existing = typeof metadata.developerInstructions === 'string' && metadata.developerInstructions.trim().length > 0
    ? metadata.developerInstructions.trim()
    : typeof metadata.developer_instructions === 'string' && metadata.developer_instructions.trim().length > 0
      ? metadata.developer_instructions.trim()
      : '';
  const mergedDeveloperInstructions = existing ? `${prompt}\n\n${existing}` : prompt;
  return {
    updatedMessage: {
      ...message,
      metadata: {
        ...metadata,
        developerInstructions: mergedDeveloperInstructions,
      },
    },
    injectedPrompt: prompt,
    agents,
  };
}

export function resolveDryRunFlag(req: Request, message: unknown): boolean {
  const queryFlag = typeof req.query.dryrun === 'string'
    ? req.query.dryrun.trim().toLowerCase()
    : undefined;
  if (queryFlag === '1' || queryFlag === 'true' || queryFlag === 'yes') return true;
  const headerFlag = req.header('x-finger-dryrun');
  if (typeof headerFlag === 'string') {
    const normalized = headerFlag.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  }
  if (isObjectRecord(message)) {
    const metadata = isObjectRecord(message.metadata) ? message.metadata : {};
    const metaFlag = metadata.dryRun ?? metadata.dryrun ?? metadata.dry_run;
    if (typeof metaFlag === 'boolean') return metaFlag;
    if (typeof metaFlag === 'string') {
      const normalized = metaFlag.trim().toLowerCase();
      if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
    }
  }
  return false;
}

export function ensureSessionExists(sessionManager: SessionManager, sessionId: string, nameHint?: string, projectPathOverride?: string): void {
  const existing = sessionManager.getSession(sessionId);
  if (existing) return;
  // Use SYSTEM_PROJECT_PATH for system sessions to prevent projectPath corruption
  const isSystemSession = sessionId.startsWith('system-') || sessionId === 'system-default-session';
  const currentSession = sessionManager.getCurrentSession();
  const fallbackProjectPath = isSystemSession
    ? SYSTEM_PROJECT_PATH
    : (projectPathOverride ?? currentSession?.projectPath ?? process.cwd());
  sessionManager.ensureSession(sessionId, fallbackProjectPath, nameHint);
}

export function buildChannelId(req: Request, sender: string): string {
  const headerChannel = req.header('x-finger-channel');
  if (typeof headerChannel === 'string' && headerChannel.trim().length > 0) {
    return headerChannel.trim();
  }
  if (sender.length > 0) return sender;
  return 'webui';
}

export function withMessageContent(message: unknown, content: string): unknown {
  if (typeof message === 'string') return content;
  if (!isObjectRecord(message)) return { content };
  const metadata = isObjectRecord(message.metadata) ? message.metadata : {};
  return {
    ...message,
    content,
    text: content,
    metadata,
  };
}

export function buildAgentEnvelope(agentId: string) {
  if (agentId === 'finger-system-agent') {
    return { id: 'finger-system-agent', name: 'SystemBot', role: 'system', mode: 'system' as const };
  }
  if (agentId === 'finger-project-agent' || agentId === 'finger-orchestrator' || agentId === 'finger-general') {
    return { id: 'finger-project-agent', name: 'Project Agent', role: 'project', mode: 'business' as const };
  }
  if (agentId === 'finger-reviewer') {
    return { id: 'finger-reviewer', name: 'Reviewer', role: 'reviewer', mode: 'business' as const };
  }
  return { id: agentId, name: agentId, role: 'agent', mode: 'business' as const };
}

export function prefixAgentResponse(agentId: string, text: string): string {
  const normalized = text.trim();
  if (agentId === 'finger-system-agent') {
    if (normalized.toLowerCase().startsWith('systembot:')) return normalized;
    return `SystemBot: ${normalized}`;
  }
  if (agentId === 'finger-project-agent' || agentId === 'finger-orchestrator' || agentId === 'finger-general') {
    if (normalized.toLowerCase().startsWith('project agent:')) return normalized;
    return `Project Agent: ${normalized}`;
  }
  if (agentId === 'finger-reviewer') {
    if (normalized.toLowerCase().startsWith('reviewer:')) return normalized;
    return `Reviewer: ${normalized}`;
  }
  return normalized;
}
