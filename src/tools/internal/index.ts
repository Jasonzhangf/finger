import { InternalToolRegistry } from './registry.js';
import { shellExecTool } from './shell-tool.js';
import { runSpawnCommand } from './spawn-runner.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { registerProjectTool } from './project-tool/project-tool.js';
import { registerSystemRegistryTool } from './system-registry-tool.js';
import { registerReportTaskCompletionTool } from './report-task-completion-tool.js';
import { clockTool } from './codex-clock-tool.js';
import { execCommandTool, writeStdinTool } from './codex-exec-tools.js';
import { applyPatchTool } from './codex-apply-patch-tool.js';
import { codexShellTool } from './codex-shell-tool.js';
import { unifiedExecTool } from './codex-unified-exec-tool.js';
import { updatePlanTool } from './codex-update-plan-tool.js';
import { viewImageTool } from './codex-view-image-tool.js';
import { webSearchTool } from './codex-web-search-tool.js';
import { contextLedgerMemoryTool } from './context-ledger-memory-tool.js';
import { noopTool } from './codex-noop-tool.js';
import { permissionTools } from './permission-tools.js';

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
export * from './permission-tools.js';

export function createDefaultInternalToolRegistry(): InternalToolRegistry {
  const registry = new InternalToolRegistry();
  registry.register(shellExecTool);
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
  registry.register(noopTool);
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
