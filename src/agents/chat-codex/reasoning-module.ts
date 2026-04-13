/**
 * Reasoning Module - 模块主文件（新文件）
 * 
 * 这是 reasoning 模块的主入口文件。
 * 暂时为空框架，将在后续 task 中逐步从 chat-codex-module.ts 迁移内容。
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
