import { logger } from '../../core/logger.js';
import type { ModuleRegistry } from '../../orchestration/module-registry.js';

export function registerDefaultModuleRoutes(moduleRegistry: ModuleRegistry): void {
  moduleRegistry.createRoute(() => true, 'echo-output', {
    blocking: false,
    priority: 0,
    description: 'default route to echo-output',
  });
  logger.module('module-registry-bootstrap').info('Orchestration modules initialized: echo-input, echo-output, finger-general, finger-orchestrator');
}
