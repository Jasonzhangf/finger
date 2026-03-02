import type { Express } from 'express';
import type { AgentRuntimeRouteDeps } from './types.js';
import { registerRuntimeViewRoutes } from './runtime-view.js';
import { registerAgentOpsRoutes } from './agent-ops.js';
import { registerResourceRoutes } from './resources.js';

export * from './types.js';

export function registerAgentRuntimeRoutes(app: Express, deps: AgentRuntimeRouteDeps): void {
  registerRuntimeViewRoutes(app, deps);
  registerAgentOpsRoutes(app, deps);
  registerResourceRoutes(app, deps);
}
