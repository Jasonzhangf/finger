import { createDefaultInternalToolRegistry } from '../tools/internal/index.js';
import { ToolRegistry } from './tool-registry.js';
import { registerProjectTool } from '../tools/internal/project-tool/project-tool.js';
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
      handler: async (input: unknown): Promise<unknown> => internalRegistry.execute(tool.name, input),
    });
    loadedToolNames.push(tool.name);
  }

  // 注册 project_tool（需要 AgentRuntimeDeps）
  if (getAgentRuntimeDeps) {
    registerProjectTool(runtimeToolRegistry, getAgentRuntimeDeps);
    loadedToolNames.push('project_tool');
  }

  return loadedToolNames;
}
