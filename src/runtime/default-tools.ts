import { createDefaultInternalToolRegistry } from '../tools/internal/index.js';
import { ToolRegistry } from './tool-registry.js';

export function registerDefaultRuntimeTools(runtimeToolRegistry: ToolRegistry): string[] {
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

  return loadedToolNames;
}
