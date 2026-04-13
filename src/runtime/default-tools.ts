import {
  createDefaultInternalToolRegistry,
  registerProjectToolInRuntime,
  registerSystemRegistryToolInRuntime,
  registerReportTaskCompletionToolInRuntime,
  registerProjectTaskToolInRuntime,
  registerSendLocalImageToolInRuntime,
  registerProjectClaimCompletionToolInRuntime,
  registerProjectApproveTaskToolInRuntime,
  registerProjectRejectTaskToolInRuntime,
} from '../tools/internal/index.js';
import { ToolRegistry } from './tool-registry.js';
import type { AgentRuntimeDeps } from '../server/modules/agent-runtime/types.js';

export function registerDefaultRuntimeTools(
  runtimeToolRegistry: ToolRegistry,
  getAgentRuntimeDeps?: () => AgentRuntimeDeps
): string[] {
  const internalRegistry = createDefaultInternalToolRegistry();
  const loadedToolNames: string[] = [];

  for (const tool of internalRegistry.list()) {
    runtimeToolRegistry.register({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      policy: 'allow',
      handler: async (input: unknown, context?: Record<string, unknown>): Promise<unknown> =>
        internalRegistry.execute(tool.name, input, context ?? {}),
    });
    loadedToolNames.push(tool.name);
  }

  // 注册 project_tool（需要 AgentRuntimeDeps）
  if (getAgentRuntimeDeps) {
    registerProjectToolInRuntime(runtimeToolRegistry);
    loadedToolNames.push('project_tool');
    registerSystemRegistryToolInRuntime(runtimeToolRegistry);
    loadedToolNames.push('system-registry-tool');
    registerReportTaskCompletionToolInRuntime(runtimeToolRegistry);
    loadedToolNames.push('report-task-completion');
    registerProjectTaskToolInRuntime(runtimeToolRegistry);
    loadedToolNames.push('project.task.status');
    loadedToolNames.push('project.task.update');
    registerSendLocalImageToolInRuntime(runtimeToolRegistry);
    loadedToolNames.push('send_local_image');

    // V3 Claim Tools
    registerProjectClaimCompletionToolInRuntime(runtimeToolRegistry);
    loadedToolNames.push('project.claim_completion');
    registerProjectApproveTaskToolInRuntime(runtimeToolRegistry);
    loadedToolNames.push('project.approve_task');
    registerProjectRejectTaskToolInRuntime(runtimeToolRegistry);
    loadedToolNames.push('project.reject_task');
  }

  return loadedToolNames;
}
