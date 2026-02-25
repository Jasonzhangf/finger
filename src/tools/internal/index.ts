import { InternalToolRegistry } from './registry.js';
import { resolveAvailableCliCapabilities } from '../external/cli-capability-registry.js';
import { createCliCapabilityTool } from './cli-capability-tool.js';
import { shellExecTool } from './shell-tool.js';

export * from './types.js';
export * from './registry.js';
export * from './shell-tool.js';
export * from './spawn-runner.js';
export * from './cli-capability-tool.js';

export function createDefaultInternalToolRegistry(): InternalToolRegistry {
  const registry = new InternalToolRegistry();
  registry.register(shellExecTool);
  const capabilities = resolveAvailableCliCapabilities();
  for (const capability of capabilities) {
    registry.register(createCliCapabilityTool(capability));
  }
  return registry;
}
