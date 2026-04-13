/**
 * Reasoning Module - 模块主文件（新文件）
 * 
 * 这是 reasoning 模块的主入口文件。
 * 逐步从 chat-codex-module.ts 迁移内容。
 */

import type {
  ReasoningRoleProfile,
  ReasoningToolSpec,
  ReasoningToolExecutionConfig,
  ReasoningModuleConfig,
  ReasoningResult,
  ReasoningLoopEvent,
  ReasoningKernelEvent,
  ReasoningContext,
  ReasoningRunner,
  ReasoningInputItem,
  ReasoningSessionState,
  ReasoningInterruptResult,
} from './reasoning-types.js';
import { BASE_AGENT_ROLE_CONFIG } from './agent-role-config.js';
import { getFingerAppVersion } from '../../core/app-version.js';
import { logger } from '../../core/logger/index.js';

// ==================== 常量配置 ====================

const DEFAULT_KERNEL_TIMEOUT_MS = 120_000;
const DEFAULT_KERNEL_TIMEOUT_RETRY_COUNT = 3;
const DEFAULT_KERNEL_STALL_TIMEOUT_MS = 600_000;
const ACTIVE_TURN_STALE_GRACE_MS = 15_000;
const FLOW_PROMPT_MAX_CHARS = 10_000;
const USER_PROFILE_PROMPT_MAX_CHARS = 8_000;
const AGENTS_PROMPT_MAX_FILES = 4;
const AGENTS_PROMPT_MAX_CHARS_PER_FILE = 4_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 262_144;
const reasoningLog = logger.module('ReasoningModule');

// ==================== 工具白名单 ====================

export const REASONING_ORCHESTRATOR_ALLOWED_TOOLS = [
  ...BASE_AGENT_ROLE_CONFIG.project.allowedTools,
];
export const REASONING_EXECUTOR_ALLOWED_TOOLS = [
  ...BASE_AGENT_ROLE_CONFIG.project.allowedTools,
];
export const REASONING_SEARCHER_ALLOWED_TOOLS = [
  ...BASE_AGENT_ROLE_CONFIG.project.allowedTools,
];
export const REASONING_RESEARCHER_ALLOWED_TOOLS = REASONING_SEARCHER_ALLOWED_TOOLS;
export const REASONING_CODER_ALLOWED_TOOLS = REASONING_EXECUTOR_ALLOWED_TOOLS;
export const REASONING_CODING_CLI_ALLOWED_TOOLS = REASONING_ORCHESTRATOR_ALLOWED_TOOLS;
export const REASONING_PROJECT_ALLOWED_TOOLS = REASONING_ORCHESTRATOR_ALLOWED_TOOLS;
export const REASONING_SYSTEM_ALLOWED_TOOLS = [...BASE_AGENT_ROLE_CONFIG.system.allowedTools];

// 兼容性别名（旧命名）
export const CHAT_CODEX_ORCHESTRATOR_ALLOWED_TOOLS = REASONING_ORCHESTRATOR_ALLOWED_TOOLS;
export const CHAT_CODEX_EXECUTOR_ALLOWED_TOOLS = REASONING_EXECUTOR_ALLOWED_TOOLS;
export const CHAT_CODEX_SEARCHER_ALLOWED_TOOLS = REASONING_SEARCHER_ALLOWED_TOOLS;
export const CHAT_CODEX_RESEARCHER_ALLOWED_TOOLS = REASONING_RESEARCHER_ALLOWED_TOOLS;
export const CHAT_CODEX_CODER_ALLOWED_TOOLS = REASONING_CODER_ALLOWED_TOOLS;
export const CHAT_CODEX_CODING_CLI_ALLOWED_TOOLS = REASONING_CODING_CLI_ALLOWED_TOOLS;
export const CHAT_CODEX_PROJECT_ALLOWED_TOOLS = REASONING_PROJECT_ALLOWED_TOOLS;
export const CHAT_CODEX_SYSTEM_ALLOWED_TOOLS = REASONING_SYSTEM_ALLOWED_TOOLS;

// ==================== Runner 框架 ====================

// TODO: finger-299.3 将逐步迁移 chat-codex-module.ts 内容到此文件

export class ProcessReasoningRunner implements ReasoningRunner {
  async runTurn(text: string, items?: ReasoningInputItem[], context?: ReasoningContext): Promise<ReasoningResult> {
    // TODO: 实现逻辑（从 chat-codex-module.ts 迁移）
    throw new Error('Not implemented - will be migrated from chat-codex-module.ts');
  }

  async interrupt(sessionId: string): Promise<ReasoningInterruptResult | null> {
    // TODO: 实现逻辑（从 chat-codex-module.ts 迁移）
    throw new Error('Not implemented - will be migrated from chat-codex-module.ts');
  }

  getSessionState(sessionId: string): ReasoningSessionState | null {
    // TODO: 实现逻辑（从 chat-codex-module.ts 迁移）
    return null;
  }
}

// 临时导出旧模块别名（兼容性）
export { ProcessReasoningRunner as ProcessChatCodexRunner };
