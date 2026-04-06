import { InternalToolRegistry } from './registry.js';
import { shellExecTool } from './shell-tool.js';
import { runSpawnCommand } from './spawn-runner.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { registerProjectTool } from './project-tool/project-tool.js';
import { registerSystemRegistryTool } from './system-registry-tool.js';
import { registerReportTaskCompletionTool } from './report-task-completion-tool.js';
import { registerProjectTaskTool } from './project-task-tool.js';
import { registerSendLocalImageTool } from './send-local-image-tool.js';
import { clockTool } from './codex-clock-tool.js';
import { execCommandTool, writeStdinTool } from './codex-exec-tools.js';
import { applyPatchTool } from './codex-apply-patch-tool.js';
import { codexShellTool } from './codex-shell-tool.js';
import { unifiedExecTool } from './codex-unified-exec-tool.js';
import { updatePlanTool } from './codex-update-plan-tool.js';
import { viewImageTool } from './codex-view-image-tool.js';
import { webSearchTool } from './codex-web-search-tool.js';
import { contextLedgerMemoryTool } from './context-ledger-memory-tool.js';
import { contextLedgerExpandTaskTool } from './context-ledger-expand-task-tool.js';
import { contextBuilderRebuildTool } from './context-builder-rebuild-tool.js';
import { noopTool } from './codex-noop-tool.js';
import { permissionTools } from './permission-tools.js';
import { heartbeatEnableTool, heartbeatDisableTool, heartbeatStatusTool, heartbeatAddTaskTool, heartbeatCompleteTaskTool, heartbeatRemoveTaskTool, heartbeatListTasksTool, heartbeatBatchAddTool, heartbeatBatchCompleteTool, heartbeatBatchRemoveTool } from './heartbeat-control-tool.js';
import { heartbeatStateTool, heartbeatStopTool, heartbeatResumeTool, mailboxHealthTool, mailboxClearTool, mailboxMarkSkipTool } from './heartbeat-state-tool.js';
import {
  mailboxListTool,
  mailboxReadTool,
  mailboxReadAllTool,
  mailboxAckTool,
  mailboxStatusTool,
} from './mailbox-tool.js';
import { mailboxRemoveTool, mailboxRemoveAllTool } from './mailbox-tool-remove.js';
import { skillsListTool, skillsStatusTool } from './skills-tool.js';
import { stopReasoningPolicyTool, stopReasoningTool } from './stop-reasoning-tool.js';
import { sleepTool } from './codex-sleep-tool.js';

export * from './types.js';
export * from './registry.js';
export * from './shell-tool.js';
export * from './spawn-runner.js';
export * from './cli-capability-tool.js';
export * from './codex-exec-session-manager.js';
export * from './codex-exec-tools.js';
export * from './codex-apply-patch-tool.js';
export * from './codex-shell-tool.js';
export * from './codex-unified-exec-tool.js';
export * from './codex-update-plan-tool.js';
export * from './codex-view-image-tool.js';
export * from './memory/index.js';
export * from './codex-clock-tool.js';
export * from './codex-noop-tool.js';
export * from './codex-web-search-tool.js';
export * from './context-ledger-memory-tool.js';
export * from './context-ledger-expand-task-tool.js';
export * from './context-builder-rebuild-tool.js';
export * from './permission-tools.js';
export * from './heartbeat-control-tool.js';
export * from './heartbeat-state-tool.js';
export * from './mailbox-tool.js';
export * from './mailbox-tool-remove.js';
export * from './send-local-image-tool.js';
export * from './skills-tool.js';
export * from './project-task-tool.js';
export * from './stop-reasoning-tool.js';
export * from './codex-sleep-tool.js';

export function createDefaultInternalToolRegistry(): InternalToolRegistry {
  const registry = new InternalToolRegistry();
  registry.register(shellExecTool);
  registry.register(heartbeatStateTool);
  registry.register(heartbeatStopTool);
  registry.register(heartbeatResumeTool);
  registry.register(mailboxHealthTool);
  registry.register(mailboxClearTool);
  registry.register(mailboxMarkSkipTool);
  registry.register(clockTool);
  registry.register(execCommandTool);
  registry.register(writeStdinTool);
  registry.register(applyPatchTool);
  registry.register(codexShellTool);
  registry.register(unifiedExecTool);
  registry.register(updatePlanTool);
  registry.register(viewImageTool);
  registry.register(webSearchTool);
  registry.register(contextLedgerMemoryTool);
  registry.register(contextLedgerExpandTaskTool);
  registry.register(contextBuilderRebuildTool);
  registry.register(noopTool);
  registry.register(heartbeatEnableTool);
  registry.register(heartbeatDisableTool);
  registry.register(heartbeatStatusTool);
  registry.register(heartbeatAddTaskTool);
  registry.register(heartbeatCompleteTaskTool);
  registry.register(heartbeatRemoveTaskTool);
  registry.register(heartbeatListTasksTool);
  registry.register(heartbeatBatchAddTool);
  registry.register(heartbeatBatchCompleteTool);
  registry.register(heartbeatBatchRemoveTool);
  registry.register(mailboxListTool);
  registry.register(mailboxReadTool);
  registry.register(mailboxReadAllTool);
  registry.register(mailboxAckTool);
  registry.register(mailboxRemoveTool);
  registry.register(mailboxRemoveAllTool);
  registry.register(mailboxStatusTool);
  registry.register(skillsListTool);
  registry.register(skillsStatusTool);
  registry.register(stopReasoningTool);
  registry.register(stopReasoningPolicyTool);
  registry.register(sleepTool);
  for (const tool of permissionTools) {
    registry.register(tool);
  }
  // NOTE: project_tool 只在运行时注册，不在 CLI 内部注册表中注册
  // 因为它需要 AgentRuntimeDeps（sessionManager, dispatchTaskToAgent）
  return registry;
}

/**
 * 在运行时注册 project_tool（需要完整的 AgentRuntimeDeps）
 */
export function registerProjectToolInRuntime(
  toolRegistry: ToolRegistry,
  getAgentRuntimeDeps: () => AgentRuntimeDeps
): void {
  registerProjectTool(toolRegistry, getAgentRuntimeDeps);
}

/**
 * 在运行时注册 system-registry-tool（仅 System Agent 可用）
 */
export function registerSystemRegistryToolInRuntime(
  toolRegistry: ToolRegistry,
  getAgentRuntimeDeps: () => AgentRuntimeDeps
): void {
  registerSystemRegistryTool(toolRegistry, getAgentRuntimeDeps);
}

/**
 * 在运行时注册 report-task-completion-tool（Project Agent 报告任务完成）
 */
export function registerReportTaskCompletionToolInRuntime(
  toolRegistry: ToolRegistry,
  getAgentRuntimeDeps: () => AgentRuntimeDeps
): void {
  registerReportTaskCompletionTool(toolRegistry, getAgentRuntimeDeps);
}

/**
 * 在运行时注册 project.task.status / project.task.update（项目任务状态与更新）
 */
export function registerProjectTaskToolInRuntime(
  toolRegistry: ToolRegistry,
  getAgentRuntimeDeps: () => AgentRuntimeDeps,
): void {
  registerProjectTaskTool(toolRegistry, getAgentRuntimeDeps);
}

/**
 * 在运行时注册 send_local_image 工具（发送本地图片到当前渠道）
 */
export function registerSendLocalImageToolInRuntime(
  toolRegistry: ToolRegistry,
  getAgentRuntimeDeps: () => AgentRuntimeDeps,
): void {
  registerSendLocalImageTool(toolRegistry, getAgentRuntimeDeps);
}
