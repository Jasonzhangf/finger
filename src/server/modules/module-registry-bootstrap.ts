import type { ModuleRegistry } from '../../orchestration/module-registry.js';

export function registerDefaultModuleRoutes(moduleRegistry: ModuleRegistry): void {
  moduleRegistry.createRoute(() => true, 'echo-output', {
    blocking: false,
    priority: 0,
    description: 'default route to echo-output',
  });
  console.log('[Server] Orchestration modules initialized: echo-input, echo-output, finger-general, finger-orchestrator');
}
