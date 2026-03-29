import { logger } from '../../core/logger.js';
/**
 * Server Post-Init
 *
 * Event forwarding, message hub routes, and orchestration config applied
 * after server is listening.
 */

import type { MessageHub } from '../../orchestration/message-hub.js';
import type { ChannelBridgeManager } from '../../bridges/manager.js';
import type { AskManager } from '../../orchestration/ask/ask-manager.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { OrchestrationConfigV1 } from '../../orchestration/orchestration-config.js';
import { attachEventForwarding } from './event-forwarding.js';
import { registerAllRoutes } from '../routes/index.js';
import type { RegisterAllRoutesDeps } from '../routes/index.js';
import { extractAgentStatusFromRuntimeView } from '../../core/agent-runtime-status.js';
import {
  asString,
  formatDispatchResultContent,
  inferAgentRoleLabel,
} from './event-forwarding-helpers.js';
import { createChannelBridgeHubRoute } from './channel-bridge-hub-route.js';
import { loadOrchestrationConfig } from '../../orchestration/orchestration-config.js';
import type { AgentDispatchRequest } from './agent-runtime/types.js';
import { getActiveReviewPolicy } from '../orchestration/review-policy.js';

export async function runPostInit(deps: {
  hub: MessageHub;
  channelBridgeManager: ChannelBridgeManager;
  askManager: AskManager;
  eventBus: any;
  sessionManager: SessionManager;
  dispatchTaskToAgent: (input: AgentDispatchRequest) => Promise<unknown>;
  broadcast: (message: unknown) => void;
  agentStatusSubscriber: any;
  applyOrchestrationConfig: (config: OrchestrationConfigV1) => Promise<{
    applied: number;
    agents: string[];
    profileId: string;
  }>;
  generalAgentId: string;
  setLoopEventEmitter: (emitter: any) => void;
  runtimeInstructionBus: any;
  app: any;
  registerAllRoutesDeps: RegisterAllRoutesDeps;
}): Promise<void> {
  // Register all routes
  registerAllRoutes(deps.app, deps.registerAllRoutesDeps);

  const forwarding = attachEventForwarding({
    eventBus: deps.eventBus,
    broadcast: deps.broadcast,
    sessionManager: deps.sessionManager,
    agentStatusSubscriber: deps.agentStatusSubscriber,
    runtimeInstructionBus: deps.runtimeInstructionBus,
    inferAgentRoleLabel,
    formatDispatchResultContent,
    asString,
    generalAgentId: deps.generalAgentId,
    dispatchTaskToAgent: deps.dispatchTaskToAgent,
    resolveReviewPolicy: () => getActiveReviewPolicy(),
    isAgentBusy: (agentId: string) => {
      try {
        const runtimeDeps = deps.registerAllRoutesDeps.getAgentRuntimeDeps();
        const agentRuntimeBlock = runtimeDeps?.agentRuntimeBlock;
        if (!agentRuntimeBlock || typeof agentRuntimeBlock.execute !== 'function') return true;
        const result = agentRuntimeBlock.execute('runtime_view', {}) as unknown;
        if (typeof (result as Promise<unknown>)?.then === 'function') {
          return (result as Promise<unknown>)
            .then((view) => {
              const busyState = extractAgentStatusFromRuntimeView(view, agentId);
              return busyState.busy !== false;
            })
            .catch(() => true);
        }
        const busyState = extractAgentStatusFromRuntimeView(result, agentId);
        return busyState.busy !== false;
      } catch {
        return true;
      }
    },
  });
  deps.setLoopEventEmitter(forwarding.emitLoopEventToEventBus);

  deps.hub.addRoute({
    id: 'channel-bridge-hub-route',
    pattern: (message: unknown): boolean => {
      const msg = message as Record<string, unknown>;
      return !!(msg.type && typeof msg.type === 'string' && msg.type.startsWith('channel.'));
    },
   handler: createChannelBridgeHubRoute({
     channelBridgeManager: deps.channelBridgeManager,
     sessionManager: deps.sessionManager,
     askManager: deps.askManager,
     dispatchTaskToAgent: deps.dispatchTaskToAgent,
     directSendToModule: (moduleId, message) => deps.hub.sendToModule(moduleId, message),
     eventBus: deps.eventBus,
     agentStatusSubscriber: deps.agentStatusSubscriber,
      runtime: {},
   }),
    blocking: true,
    priority: 10,
    moduleId: 'channel-bridge-hub',
  });

  logger.module('server-postinit').info('MessageHub channel route registered (dynamic mode forced)');

  const loadedOrchestrationConfig = loadOrchestrationConfig();
  const applied = await deps.applyOrchestrationConfig(loadedOrchestrationConfig.config);
  logger.module('server-postinit').info('Orchestration config applied:', {
   path: loadedOrchestrationConfig.path,
    created: loadedOrchestrationConfig.created,
    appliedAgents: applied.agents,
  });
}
