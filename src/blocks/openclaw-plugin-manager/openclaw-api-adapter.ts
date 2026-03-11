import type { OpenClawGateBlock, OpenClawTool } from '../openclaw-gate/index.js';
import type { OpenClawPluginDefinition, PluginLogger, PluginRuntimeApi } from './types.js';
import { OpenClawBridgeAdapter } from '../../bridges/openclaw-adapter.js';

export type OpenClawRegisterChannelInput = {
  plugin: {
    id: string;
    meta?: {
      label?: string;
      selectionLabel?: string;
      blurb?: string;
      docsPath?: string;
      docsLabel?: string;
      order?: number;
    };
    capabilities?: Record<string, unknown>;
    configSchema?: {
      schema?: Record<string, unknown>;
    } | Record<string, unknown>;
  };
};

export type OpenClawGatewayMethodHandler = (payload: {
  params?: Record<string, unknown>;
  context?: Record<string, unknown>;
  respond: (ok: boolean, result?: unknown, error?: unknown) => void;
}) => unknown | Promise<unknown>;

export type OpenClawCompatRuntimeApi = PluginRuntimeApi & {
  registerGatewayMethod: (method: string, handler: OpenClawGatewayMethodHandler) => void;
  pluginConfig?: Record<string, unknown>;
  runtime?: { config?: Record<string, unknown> };
};

export type ChannelPluginHandler = {
  sendText?: (params: { to: string; text: string; accountId?: string; replyToId?: string; cfg?: unknown }) => Promise<{ messageId?: string; error?: string; channel?: string }>;
  sendMedia?: (params: { to: string; text: string; mediaUrl: string; accountId?: string; replyToId?: string; cfg?: unknown }) => Promise<{ messageId?: string; error?: string; channel?: string }>;
  startAccount?: (ctx: unknown) => Promise<void>;
  normalizeTarget?: (target: string) => { ok: boolean; to?: string; error?: string };
};

const channelHandlers = new Map<string, ChannelPluginHandler>();

export function getChannelHandler(channelId: string): ChannelPluginHandler | undefined {
  return channelHandlers.get(channelId);
}

export function registerChannelHandler(channelId: string, handler: ChannelPluginHandler): void {
  channelHandlers.set(channelId, handler);

  // 自动注册为 Bridge Module
  registerAsBridgeModule(channelId, handler);
}

function registerAsBridgeModule(channelId: string, handler: ChannelPluginHandler): void {
  // 同步注册 bridge 模块，避免异步导致的时序问题
  try {
    // 动态同步导入
    const managerModule = require('../../bridges/manager.js');
    const manager = managerModule.getChannelBridgeManager();
    if (manager) {
      manager.registerBridgeModule({
        id: `openclaw-${channelId}`,
        channelId,
        factory: (config: any, callbacks: any) => {
          return new OpenClawBridgeAdapter(config, callbacks);
        },
      });
    }
  } catch {
    // Manager not initialized yet, store for later registration
    const pendingHandlers = (globalThis as any).__pendingChannelHandlers = (globalThis as any).__pendingChannelHandlers || new Map();
    pendingHandlers.set(channelId, handler);
  }
}

export function createOpenClawRuntimeApi(params: {
  pluginId: string;
  gate: OpenClawGateBlock;
  logger: PluginLogger;
  pluginConfig?: Record<string, unknown>;
}): OpenClawCompatRuntimeApi {
  const { pluginId, gate, logger, pluginConfig } = params;

  return {
    runtime: {
      config: pluginConfig,
      channel: {
        activity: {
          record: (event: { channel: string; accountId: string; direction: string }) => {
            logger.info?.(`[channel.activity] ${event.channel}:${event.accountId} ${event.direction}`);
          },
        },
        routing: {
          resolveAgentRoute: (params: { cfg: unknown; channel: string; accountId: string; peer: { kind: string; id: string } }) => {
            // Default route to orchestrator
            return { agentId: 'finger-orchestrator' };
          },
        },
        reply: {
          resolveEnvelopeFormatOptions: (cfg: unknown) => ({}),
          formatInboundEnvelope: (params: unknown) => params,
          finalizeInboundContext: (params: unknown) => params,
          resolveEffectiveMessagesConfig: (cfg: unknown, agentId: string) => ({}),
          dispatchReplyWithBufferedBlockDispatcher: async (params: { ctx: Record<string, unknown>; cfg: unknown; dispatcherOptions?: { responsePrefix?: string; deliver?: (payload: { text?: string }, info: { kind: 'tool' | 'block' }) => Promise<void> } }) => {
            // Bridge message to Finger and handle reply
            const ctx = params.ctx as Record<string, unknown>;
            const content = (ctx?.content as string) || '';
            const senderId = (ctx?.senderId as string) || '';
            const peerId = (ctx?.peerId as string) || '';
            const peerKind = (ctx?.peerKind as string) || 'direct';
            const deliver = params.dispatcherOptions?.deliver;

            logger.info?.(`[channel.reply] dispatchReply called - content: "${content.slice(0, 50)}", senderId: ${senderId}, peerKind: ${peerKind}`);

            // Get bridge manager and dispatch
            try {
              const { getChannelBridgeManager } = await import('../../bridges/manager.js');
              const manager = getChannelBridgeManager();
              const bridge = manager.getBridge('qqbot') as any;
              if (bridge && bridge.callbacks_) {
                const message = {
                  id: `qqbot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  channelId: 'qqbot',
                  accountId: 'default',
                  type: peerKind === 'group' ? 'group' : 'direct',
                  senderId,
                  content,
                  timestamp: Date.now(),
                  metadata: ctx,
                };
                logger.info?.(`[channel.reply] Bridging message: ${message.id} from ${senderId}`);
                
                // Call onMessage to route to agent
                await bridge.callbacks_.onMessage(message);
                
                // For now, send a simple acknowledgment via deliver
                if (deliver) {
                  await deliver({ text: '消息已收到，Finger 正在处理...' }, { kind: 'block' });
                  logger.info?.(`[channel.reply] Sent acknowledgment via deliver`);
                }
              } else {
                logger.error?.(`[channel.reply] Bridge or callbacks not found`);
              }
            } catch (err) {
              logger.error?.(`[channel.reply] Failed to bridge message: ${err}`);
            }
          },
        },
      },
    },
    logger,
    config: pluginConfig,
    pluginConfig,
    registerChannel: (registration: unknown) => {
      const channel = normalizeChannelRegistration(registration);
      if (!channel) {
        logger.warn(`Ignored invalid channel registration for plugin ${pluginId}`);
        return;
      }

      // Store channel plugin handler - extract from outbound/gateway/messaging
      // registration structure: { plugin: ChannelPlugin } or ChannelPlugin directly
      const regRecord = registration as Record<string, unknown>;
      const channelPlugin = (regRecord.plugin ?? registration) as Record<string, unknown>;

      const handler: ChannelPluginHandler = {};

      // Extract outbound methods (sendText, sendMedia)
      const outbound = channelPlugin.outbound as Record<string, unknown> | undefined;
      if (outbound) {
        if (typeof outbound.sendText === 'function') {
          handler.sendText = outbound.sendText as ChannelPluginHandler['sendText'];
        }
        if (typeof outbound.sendMedia === 'function') {
          handler.sendMedia = outbound.sendMedia as ChannelPluginHandler['sendMedia'];
        }
      }

      // Extract gateway methods (startAccount for QQ gateway)
      const gateway = channelPlugin.gateway as Record<string, unknown> | undefined;
      if (gateway && typeof gateway.startAccount === 'function') {
        handler.startAccount = gateway.startAccount as ChannelPluginHandler['startAccount'];
      }

      // Extract messaging methods (normalizeTarget)
      const messaging = channelPlugin.messaging as Record<string, unknown> | undefined;
      if (messaging && typeof messaging.normalizeTarget === 'function') {
        handler.normalizeTarget = messaging.normalizeTarget as ChannelPluginHandler['normalizeTarget'];
      }

      // Always register handler (even if empty, for tracking)
      registerChannelHandler(channel.id, handler);
      logger.info(`Stored channel handler for ${channel.id} (sendText: ${!!handler.sendText}, sendMedia: ${!!handler.sendMedia}, startAccount: ${!!handler.startAccount})`);

      const schema = extractSchema(channel);
      const tool: OpenClawTool = {
        id: `channel.${channel.id}`,
        name: channel.meta?.label || channel.id,
        description: channel.meta?.blurb || `OpenClaw channel ${channel.id}`,
        inputSchema: schema,
        outputSchema: { type: 'object' },
      };
      gate.addTool(pluginId, tool);
      logger.info(`Registered OpenClaw channel ${channel.id} for plugin ${pluginId}`);
    },
    registerGatewayMethod: (method: string, _handler: unknown) => {
      const normalizedMethod = typeof method === 'string' ? method.trim() : '';
      if (!normalizedMethod) {
        logger.warn(`Ignored empty gateway method for plugin ${pluginId}`);
        return;
      }
      const tool: OpenClawTool = {
        id: `gateway.${normalizedMethod.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
        name: normalizedMethod,
        description: `OpenClaw gateway method ${normalizedMethod}`,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };
      gate.addTool(pluginId, tool);
      logger.info(`Registered OpenClaw gateway method ${normalizedMethod} for plugin ${pluginId}`);
    },
    registerTool: (tool: unknown) => {
      const normalizedTool = normalizeTool(tool);
      if (!normalizedTool) {
        logger.warn(`Ignored invalid tool registration for plugin ${pluginId}`);
        return;
      }
      gate.addTool(pluginId, normalizedTool);
      logger.info(`Registered OpenClaw tool ${normalizedTool.id} for plugin ${pluginId}`);
    },
    registerHook: (_hook: unknown) => {
      logger.info(`Registered OpenClaw hook for plugin ${pluginId}`);
    },
    registerService: (_service: unknown) => {
      logger.info(`Registered OpenClaw service for plugin ${pluginId}`);
    },
  };
}

export function normalizePluginDefinition(moduleValue: unknown): OpenClawPluginDefinition | null {
  if (!moduleValue || typeof moduleValue !== 'object') return null;
  const candidate = moduleValue as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0) return null;
  return candidate as unknown as OpenClawPluginDefinition;
}

function normalizeChannelRegistration(registration: unknown): OpenClawRegisterChannelInput['plugin'] | null {
  if (!registration || typeof registration !== 'object') return null;
  const record = registration as Record<string, unknown>;
  const plugin = (record.plugin ?? record) as Record<string, unknown>;
  if (!plugin || typeof plugin.id !== 'string' || plugin.id.trim().length === 0) return null;
  return plugin as unknown as OpenClawRegisterChannelInput['plugin'];
}

function extractSchema(channel: OpenClawRegisterChannelInput['plugin']): Record<string, unknown> {
  const configSchema = channel.configSchema;
  if (configSchema && typeof configSchema === 'object') {
    const wrapped = configSchema as Record<string, unknown>;
    const schema = wrapped.schema;
    if (schema && typeof schema === 'object') return schema as Record<string, unknown>;
    return wrapped;
  }
  return { type: 'object' };
}

function normalizeTool(tool: unknown): OpenClawTool | null {
  if (!tool || typeof tool !== 'object') return null;
  const record = tool as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.trim().length === 0) return null;
  return {
    id: record.id,
    name: typeof record.name === 'string' ? record.name : record.id,
    description: typeof record.description === 'string' ? record.description : record.id,
    inputSchema: isRecord(record.inputSchema) ? record.inputSchema : { type: 'object' },
    outputSchema: isRecord(record.outputSchema) ? record.outputSchema : { type: 'object' },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
