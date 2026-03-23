import type { MessageHub } from '../../orchestration/message-hub.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { Mailbox } from '../mailbox.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { SessionWorkspaceManager } from '../modules/session-workspaces.js';
import type { ChannelBridgeManager } from '../../bridges/manager.js';
import type { ChannelAttachment } from '../../bridges/types.js';

export interface MessageRouteDeps {
  hub: MessageHub;
  mailbox: Mailbox;
  runtime: RuntimeFacade;
  toolRegistry: ToolRegistry;
  channelBridgeManager: ChannelBridgeManager;
  sessionManager: SessionManager;
  eventBus: import('../../runtime/event-bus.js').UnifiedEventBus;
  sessionWorkspaces: SessionWorkspaceManager;
  broadcast: (message: Record<string, unknown>) => void;
  writeMessageErrorSample: (payload: Record<string, unknown>) => void;
  blockingTimeoutMs: number;
  blockingMaxRetries: number;
  blockingRetryBaseMs: number;
  allowDirectAgentRoute: boolean;
  primaryOrchestratorTarget: string;
  primaryOrchestratorAgentId: string;
  primaryOrchestratorGatewayId: string;
  legacyOrchestratorAgentId: string;
  legacyOrchestratorGatewayId: string;
}

export interface DisplayChannelRequest {
  channelId: string;
  to: string;
  replyTo?: string;
  prefix?: string;
  attachments?: ChannelAttachment[];
}
