import type { OpenClawGateBlock, OpenClawTool } from '../openclaw-gate/index.js';
import type { OpenClawPluginDefinition, PluginLogger, PluginRuntimeApi } from './types.js';
import { OpenClawBridgeAdapter } from '../../bridges/openclaw-adapter.js';
import { loadUserSettings } from '../../core/user-settings.js';
import { logger } from '../../core/logger.js';
import { createConsoleLikeLogger } from '../../core/logger/console-like.js';
import type { ChannelAttachment } from '../../bridges/types.js';

const clog = createConsoleLikeLogger('OpenclawApiAdapter');

const log = logger.module('OpenclawApiAdapter');

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
  registerCli?: (options: unknown) => void;
  registerAuthProfile?: (name: string, profile: unknown) => void;
  pluginConfig?: Record<string, unknown>;
  runtime?: {
    config?: Record<string, unknown>;
    auth?: {
      listProfiles?: () => string[];
      resolveProfile?: (profileName: string) => Record<string, unknown> | null;
    };
  };
};

export type ChannelPluginHandler = {
  sendText?: (params: { to: string; text: string; accountId?: string; replyToId?: string; cfg?: unknown }) => Promise<{ messageId?: string; error?: string; channel?: string }>;
  sendMedia?: (params: { to: string; text: string; mediaUrl: string; accountId?: string; replyToId?: string; cfg?: unknown; attachments?: ChannelAttachment[] }) => Promise<{ messageId?: string; error?: string; channel?: string }>;
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

  const runtimeAuthProfiles = new Map<string, Record<string, unknown>>();

  function mapUserSettingsToOpenClawAuthProfiles(): Record<string, Record<string, unknown>> {
    const settings = loadUserSettings();
    const providers = settings?.aiProviders?.providers;
    if (!providers || typeof providers !== 'object') return {};

    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, provider] of Object.entries(providers as Record<string, any>)) {
      if (!provider?.enabled) continue;

      // 用户已按要求：provider model 统一 gpt-5.4，no provider wrapper
      // auth 使用 user-settings 的 env_key 对应环境变量值
      const envKey = typeof provider.env_key === 'string' ? provider.env_key : '';
      const apiKey = envKey ? process.env[envKey] : undefined;
      if (!apiKey) continue;

      const baseUrl = typeof provider.base_url === 'string' ? provider.base_url : undefined;
      out[name] = {
        provider: name,
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      };
    }

    return out;
  }

  function listAuthProfiles(): string[] {
    const merged = {
      ...mapUserSettingsToOpenClawAuthProfiles(),
      ...Object.fromEntries(runtimeAuthProfiles.entries()),
    };
    return Object.keys(merged);
  }

  function resolveAuthProfile(profileName: string): Record<string, unknown> | null {
    const merged = {
      ...mapUserSettingsToOpenClawAuthProfiles(),
      ...Object.fromEntries(runtimeAuthProfiles.entries()),
    };
    return merged[profileName] || null;
  }

  return {
    runtime: {
      config: pluginConfig,
      auth: {
        listProfiles: listAuthProfiles,
        resolveProfile: resolveAuthProfile,
      },
      channel: {
        activity: {
          record: (event: { channel: string; accountId: string; direction: string }) => {
            logger.info?.(`[channel.activity] ${event.channel}:${event.accountId} ${event.direction}`);
          },
        },
       routing: {
         resolveAgentRoute: (params: { cfg: unknown; channel: string; accountId: string; peer: { kind: string; id: string } }) => {
           // Default route to orchestrator
           return { agentId: 'finger-project-agent' };
         },
       },
       session: {
         resolveStorePath: (baseStore: unknown, options?: { agentId?: string }) => {
           return String(baseStore || '');
         },
         recordInboundSession: async (params: {
           storePath: string;
           sessionKey?: string;
           ctx: Record<string, unknown>;
           updateLastRoute?: { sessionKey?: string; channel: string; to: string; accountId: string };
           onRecordError?: (err: Error) => void;
         }) => {
           logger.debug?.(`[session.recordInboundSession] Recorded session: ${params.sessionKey}`);
         },
       },
       media: {
         saveMediaBuffer: async (params: { buffer: Buffer; filename: string; mimeType?: string }) => {
           // TODO: Implement media saving to temp directory
           logger.debug?.(`[media.saveMediaBuffer] Saving media: ${params.filename}`);
           return null; // Return null for now, as we don't implement actual saving
         },
       },
       commands: {
         resolveSenderCommandAuthorization: async (params: unknown) => {
           // Default: allow all commands
           return { senderAllowedForCommands: true, commandAuthorized: true };
         },
       },
       reply: {
         resolveEnvelopeFormatOptions: (cfg: unknown) => ({}),
         formatInboundEnvelope: (params: unknown) => params,
         finalizeInboundContext: (params: unknown) => params,
         resolveEffectiveMessagesConfig: (cfg: unknown, agentId: string) => ({}),

        // Human delay configuration
        resolveHumanDelayConfig: (cfg: unknown, agentId?: string) => ({
          minMs: 500,
          maxMs: 2000,
          enabled: true,
        }),

        // Reply dispatcher - bridges messages to Finger agent
        createReplyDispatcherWithTyping: (params: {
           humanDelay: { minMs: number; maxMs: number; enabled: boolean };
           typingCallbacks: { start: () => Promise<void>; stop: () => Promise<void>; onStartError?: (err: Error) => void; onStopError?: (err: Error) => void; keepaliveIntervalMs?: number };
           deliver: (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) => Promise<void>;
           onError: (err: Error, info: { kind: string }) => void;
         }) => {
           return {
             dispatcher: {
               deliver: params.deliver,
               humanDelay: params.humanDelay,
             },
             replyOptions: {},
             markDispatchIdle: () => {},
           };
         },

        withReplyDispatcher: async (params: {
           dispatcher: unknown;
           run: () => Promise<void>;
         }) => {
           await params.run();
         },

         // Core method: dispatch reply from config - bridges to Finger agent
        dispatchReplyFromConfig: async (params: {
           ctx: Record<string, unknown>;
           cfg: unknown;
           dispatcher: unknown;
           replyOptions: Record<string, unknown>;
         }) => {
           const ctx = params.ctx as Record<string, unknown>;
           const dispatcher = params.dispatcher as { deliver: (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) => Promise<void> };
           const deliver = dispatcher.deliver;
           
           // Extract message content
           const content = String(
             ctx?.Body
               ?? ctx?.CommandBody
               ?? ctx?.RawBody
               ?? ctx?.content
               ?? ''
           );
           
           const senderId = String(ctx?.From ?? ctx?.SenderId ?? ctx?.senderId ?? '');
           const peerId = String(ctx?.To ?? ctx?.PeerId ?? ctx?.peerId ?? '');
           const messageId = String(ctx?.MessageId ?? ctx?.MessageSid ?? ctx?.messageId ?? '');
           const contextToken = String(ctx?.ContextToken ?? ctx?.contextToken ?? '');
           
           logger.info?.(`[reply.dispatchReplyFromConfig] content="${content.slice(0, 50)}" from=${senderId}`);
           
           if (!content.trim()) {
             logger.warn?.('[reply.dispatchReplyFromConfig] Empty content, skip');
             return;
           }
           
           // Bridge to Finger agent
           try {
             const { getChannelBridgeManager } = await import('../../bridges/manager.js');
             const manager = getChannelBridgeManager();
             const inboundChannelId = String(ctx?.OriginatingChannel ?? ctx?.channelId ?? 'openclaw-weixin');
             const bridge = manager.getBridge(inboundChannelId) as any;
             
             if (bridge && bridge.callbacks_) {
               const message = {
                 id: messageId || `weixin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                 channelId: inboundChannelId,
                 accountId: String(ctx?.AccountId ?? 'default'),
                 type: 'direct',
                 senderId,
                 senderName: String(ctx?.SenderName ?? ''),
                 content,
                 timestamp: Date.now(),
                 metadata: {
                   messageId,
                   contextToken,
                   peerId,
                   ...ctx,
                 },
               };
               
               // Route to Finger agent
               await bridge.callbacks_.onMessage(message);
             } else {
               logger.error?.(`[reply.dispatchReplyFromConfig] Bridge not found for channel: ${inboundChannelId}`);
               // Send error notice via deliver
               await deliver({ text: '抱歉，系统暂时无法处理您的消息。' });
             }
           } catch (err) {
             logger.error?.(`[reply.dispatchReplyFromConfig] Error: ${err}`);
             try {
               await deliver({ text: '抱歉，处理您的消息时发生错误。' });
             } catch (deliverErr) {
               logger.error?.(`[reply.dispatchReplyFromConfig] Failed to deliver error notice: ${deliverErr}`);
             }
           }
         },

         dispatchReplyWithBufferedBlockDispatcher: async (params: { ctx: Record<string, unknown>; cfg: unknown; dispatcherOptions?: { responsePrefix?: string; deliver?: (payload: { text?: string }, info: { kind: 'tool' | 'block' }) => Promise<void> } }) => {
           // Bridge message to Finger and handle reply
           const ctx = params.ctx as Record<string, unknown>;
           clog.log('[channel.reply] dispatchReply called with ctx keys:', Object.keys(ctx || {}).join(', '));
           const content = String(
            ctx?.RawBody
               ?? ctx?.CommandBody
               ?? ctx?.Body
               ?? ctx?.content
               ?? ''
           );
           clog.log('[channel.reply] Extracted content:', content.slice(0, 100));
           const senderId = String(ctx?.SenderId ?? ctx?.senderId ?? '');
           const senderName = String(ctx?.SenderName ?? ctx?.senderName ?? '');
           const peerId = String(ctx?.From ?? ctx?.peerId ?? '');
           const peerKind = String(ctx?.ChatType ?? ctx?.peerKind ?? 'direct');
           const messageId = String(ctx?.MessageSid ?? ctx?.messageId ?? '');
           const groupId = String(
             ctx?.QQGroupOpenid
               ?? ctx?.QQChannelId
               ?? ctx?.QQGuildId
               ?? ctx?.groupId
               ?? ''
           );

           logger.info?.(`[channel.reply] dispatchReply called - content: "${content.slice(0, 50)}", senderId: ${senderId}, peerKind: ${peerKind}`);

            if (!content.trim()) {
              logger.warn?.('[channel.reply] Empty content, skip dispatch');
              return;
            }

            // 立即回应“处理中”，避免阻塞导致超时
            const deliver = params.dispatcherOptions?.deliver;
            if (deliver) {
              const responsePrefix = typeof params.dispatcherOptions?.responsePrefix === 'string'
                ? params.dispatcherOptions?.responsePrefix.trim()
                : '';
              const ackText = responsePrefix
                ? `${responsePrefix}\n收到，处理中…`
                : '收到，处理中…';
              try {
                // 不等待链路执行完成，先回执
                await deliver({ text: ackText }, { kind: 'block' });
              } catch (err) {
                logger.warn?.(`[channel.reply] Failed to deliver ack: ${err}`);
              }
            }

            // Get bridge manager and dispatch
            try {
              const { getChannelBridgeManager } = await import('../../bridges/manager.js');
              const manager = getChannelBridgeManager();
              const inboundChannelId = String(
                ctx?.OriginatingChannel
                  ?? ctx?.channelId
                  ?? 'qqbot'
              );
              const bridge = manager.getBridge(inboundChannelId) as any;
              logger.info?.(`[channel.reply] Bridge lookup - channel=${inboundChannelId}, manager: ${!!manager}, bridge: ${!!bridge}, callbacks: ${!!(bridge && bridge.callbacks_)}`);
              if (bridge && bridge.callbacks_) {
               const message = {
                 // 使用原始QQ消息ID作为唯一标识，fallback到自生成ID
                 id: messageId || `qqbot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                 channelId: inboundChannelId,
                 accountId: 'default',
                 type: peerKind === 'group' ? 'group' : 'direct',
                 senderId,
                 senderName,
                 content,
                 timestamp: Date.now(),
                 metadata: {
                   messageId, // 始终保留原始QQ消息ID
                   ...ctx,
                   peerId,
                   groupId: groupId || undefined,
                 },
               };
               logger.info?.(`[channel.reply] Bridging message: ${message.id} from ${senderId}`);

                // Call onMessage to route to agent (actual reply is handled by server routing)
                // 不等待结果，避免阻塞输入线程
                void bridge.callbacks_.onMessage(message).catch((err: unknown) => {
                  logger.error?.(`[channel.reply] Bridge onMessage failed: ${err}`);
                });
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
    registerCli: (_registerCliOptions: unknown) => {
      logger.debug?.(`Plugin ${pluginId} requested registerCli (not yet supported in Finger)`);
    },
    registerAuthProfile: (name: string, profile: unknown) => {
      const key = typeof name === 'string' ? name.trim() : '';
      if (!key) return;
      if (!profile || typeof profile !== 'object') return;
      runtimeAuthProfiles.set(key, profile as Record<string, unknown>);
      logger.info?.(`Registered auth profile ${key} for plugin ${pluginId}`);
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
