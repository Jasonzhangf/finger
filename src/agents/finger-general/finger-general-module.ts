import {
  createChatCodexModule,
  ProcessChatCodexRunner,
  CHAT_CODEX_PROJECT_ALLOWED_TOOLS,
  CHAT_CODEX_SYSTEM_ALLOWED_TOOLS,
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

export const FINGER_PROJECT_AGENT_ID = 'finger-project-agent';
export const FINGER_REVIEWER_AGENT_ID = 'finger-reviewer';
export const FINGER_SYSTEM_AGENT_ID = 'finger-system-agent';
export const FINGER_GENERAL_AGENT_ID = FINGER_PROJECT_AGENT_ID;
export const FINGER_ORCHESTRATOR_AGENT_ID = FINGER_PROJECT_AGENT_ID;

export const FINGER_PROJECT_ALLOWED_TOOLS = [...CHAT_CODEX_PROJECT_ALLOWED_TOOLS, 'report-task-completion'];
export const FINGER_REVIEWER_ALLOWED_TOOLS = [...CHAT_CODEX_REVIEWER_ALLOWED_TOOLS];
export const FINGER_SYSTEM_ALLOWED_TOOLS = [...CHAT_CODEX_SYSTEM_ALLOWED_TOOLS, 'project_tool', 'system-registry-tool'];
export const FINGER_GENERAL_ALLOWED_TOOLS = [...FINGER_PROJECT_ALLOWED_TOOLS];
export const FINGER_ORCHESTRATOR_ALLOWED_TOOLS = [...FINGER_PROJECT_ALLOWED_TOOLS];

export type FingerRoleProfile =
  | 'project'
  | 'reviewer'
  | 'system';

export type FingerGeneralModuleConfig = Partial<ChatCodexModuleConfig> & {
  roleProfile?: FingerRoleProfile;
};

function inferRoleProfile(moduleId: string | undefined, explicitRoleProfile: FingerRoleProfile | undefined): FingerRoleProfile {
  if (explicitRoleProfile) return explicitRoleProfile;
  const normalized = (moduleId ?? '').trim().toLowerCase();
  if (normalized.includes('review')) return 'reviewer';
  if (normalized.includes('system')) return 'system';
  return 'project';
}

export function createFingerGeneralModule(config: FingerGeneralModuleConfig = {}, runner?: ChatCodexRunner) {
  const id = typeof config.id === 'string' && config.id.trim().length > 0
    ? config.id.trim()
    : FINGER_PROJECT_AGENT_ID;
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
