import {
  createChatCodexModule,
  ProcessChatCodexRunner,
  CHAT_CODEX_CODER_ALLOWED_TOOLS,
  CHAT_CODEX_EXECUTOR_ALLOWED_TOOLS,
  CHAT_CODEX_ORCHESTRATOR_ALLOWED_TOOLS,
  CHAT_CODEX_RESEARCHER_ALLOWED_TOOLS,
  CHAT_CODEX_REVIEWER_ALLOWED_TOOLS,
  type ChatCodexLoopEvent,
  type ChatCodexKernelEvent,
  type ChatCodexModuleConfig,
  type ChatCodexRunContext,
  type ChatCodexRunResult,
  type ChatCodexRunner,
  type ChatCodexRunnerInterruptResult,
  type ChatCodexRunnerSessionState,
  type KernelInputItem,
} from '../chat-codex/chat-codex-module.js';

export const FINGER_GENERAL_AGENT_ID = 'finger-general';
export const FINGER_ORCHESTRATOR_AGENT_ID = 'finger-orchestrator';
export const FINGER_RESEARCHER_AGENT_ID = 'finger-researcher';
export const FINGER_EXECUTOR_AGENT_ID = 'finger-executor';
export const FINGER_CODER_AGENT_ID = 'finger-coder';
export const FINGER_REVIEWER_AGENT_ID = 'finger-reviewer';

export const FINGER_GENERAL_ALLOWED_TOOLS = [...CHAT_CODEX_ORCHESTRATOR_ALLOWED_TOOLS];
export const FINGER_ORCHESTRATOR_ALLOWED_TOOLS = [...CHAT_CODEX_ORCHESTRATOR_ALLOWED_TOOLS];
export const FINGER_RESEARCHER_ALLOWED_TOOLS = [...CHAT_CODEX_RESEARCHER_ALLOWED_TOOLS];
export const FINGER_EXECUTOR_ALLOWED_TOOLS = [...CHAT_CODEX_EXECUTOR_ALLOWED_TOOLS];
export const FINGER_CODER_ALLOWED_TOOLS = [...CHAT_CODEX_CODER_ALLOWED_TOOLS];
export const FINGER_REVIEWER_ALLOWED_TOOLS = [...CHAT_CODEX_REVIEWER_ALLOWED_TOOLS];

export type FingerRoleProfile =
  | 'general'
  | 'orchestrator'
  | 'researcher'
  | 'executor'
  | 'coder'
  | 'reviewer';

export type FingerGeneralModuleConfig = Partial<ChatCodexModuleConfig> & {
  roleProfile?: FingerRoleProfile;
};

function inferRoleProfile(moduleId: string | undefined, explicitRoleProfile: FingerRoleProfile | undefined): FingerRoleProfile {
  if (explicitRoleProfile) return explicitRoleProfile;
  const normalized = (moduleId ?? '').trim().toLowerCase();
  if (normalized.includes('orchestr')) return 'orchestrator';
  if (normalized.includes('research') || normalized.includes('search')) return 'researcher';
  if (normalized.includes('review')) return 'reviewer';
  if (normalized.includes('coder')) return 'coder';
  if (normalized.includes('execut')) return 'executor';
  return 'general';
}

export function createFingerGeneralModule(config: FingerGeneralModuleConfig = {}, runner?: ChatCodexRunner) {
  const id = typeof config.id === 'string' && config.id.trim().length > 0
    ? config.id.trim()
    : FINGER_GENERAL_AGENT_ID;
  const roleProfile = inferRoleProfile(id, config.roleProfile);
  return createChatCodexModule({
    ...config,
    id,
    name: config.name ?? id,
    defaultRoleProfileId: roleProfile,
  }, runner);
}

export {
  createChatCodexModule,
  ProcessChatCodexRunner,
};
export type {
  ChatCodexKernelEvent,
  ChatCodexLoopEvent,
  ChatCodexRunContext,
  ChatCodexRunResult,
  ChatCodexRunner,
  ChatCodexRunnerInterruptResult,
  ChatCodexRunnerSessionState,
  KernelInputItem,
};
