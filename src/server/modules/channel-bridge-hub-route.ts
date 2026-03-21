/**
 * ChannelBridge MessageHub Route Handler
 *
 * 提供统一的 MessageHub 路由逻辑，用于 dynamic channel routing。
 */

import type { ChannelMessage } from '../../bridges/types.js';
import type { AgentDispatchRequest } from './agent-runtime/types.js';
import type { ChannelBridgeManager } from '../../bridges/manager.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import { ChannelContextManager } from '../../orchestration/channel-context-manager.js';
import { getCommandHub, parseCommands } from '../../blocks/command-hub/index.js';
import { loadFingerConfig, getChannelAuth, getChannelAuthorizationMode } from '../../core/config/channel-config.js';
import { CommandType } from '../../blocks/command-hub/types.js';
import { logger } from '../../core/logger.js';
import { SYSTEM_AGENT_CONFIG } from '../../agents/finger-system-agent/index.js';
import type { AgentStatusSubscriber } from './agent-status-subscriber.js';

// 消息去重：防止同一条消息被重复处理（QQ Bot 偶发重复推送）
const processedMessages = new Map<string, number>();
const DEDUP_TTL_MS = 60_000;

function isDuplicateMessage(msgId: string): boolean {
  const now = Date.now();
  if (processedMessages.has(msgId)) {
    const existing = processedMessages.get(msgId)!;
    if (now - existing < DEDUP_TTL_MS) {
      log.debug('Duplicate message detected, skipping', { msgId });
      return true;
    }
  }
  processedMessages.set(msgId, now);
  // 清理过期条目
  if (processedMessages.size > 500) {
    for (const [id, ts] of processedMessages) {
      if (now - ts > DEDUP_TTL_MS) processedMessages.delete(id);
    }
  }
  return false;
}

const log = logger.module('ChannelBridgeHubRoute');

import type { AuthorizationMode } from '../../runtime/tool-authorization-context.js';
export interface ChannelBridgeHubRouteDeps {
  channelBridgeManager: ChannelBridgeManager;
  sessionManager: SessionManager;
  dispatchTaskToAgent: (request: AgentDispatchRequest) => Promise<unknown>;
  eventBus: UnifiedEventBus;
  agentStatusSubscriber?: AgentStatusSubscriber;
  runtime: { setAgentAuthorizationMode: (agentId: string, mode: AuthorizationMode, channelId?: string) => void };
}

export function createChannelBridgeHubRoute(deps: ChannelBridgeHubRouteDeps) {
  const { channelBridgeManager, sessionManager, dispatchTaskToAgent, eventBus, agentStatusSubscriber } = deps;
  log.info('[ChannelBridgeHubRoute] agentStatusSubscriber available:', { available: !!agentStatusSubscriber });
  const channelContextManager = ChannelContextManager.getInstance();

  function formatLocalTimestamp(date: Date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    const offset = -date.getTimezoneOffset();
    const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const offsetMinutes = String(Math.abs(offset) % 60).padStart(2, '0');
    const offsetSign = offset >= 0 ? '+' : '-';
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms} ${offsetSign}${offsetHours}:${offsetMinutes}`;
  }

  function addAgentPrefix(content: string, agentId?: string): string {
    const timestamp = formatLocalTimestamp();
    const agentName = agentId?.replace(/^finger-/, '').replace(/-/g, ' ') || 'orchestrator';
    return `[${agentName}] [${timestamp}] ${content}`;
  }

  return async (message: unknown): Promise<void> => {
    const msg = message as Record<string, unknown>;
    const channelMsg = msg.payload as ChannelMessage;

    if (channelMsg?.id && isDuplicateMessage(channelMsg.id)) {
      return;
    }

    log.info('Processing channel message via MessageHub', {
      channelId: channelMsg.channelId,
      msgId: channelMsg.id,
    });

    const target = channelMsg.type === 'group' && channelMsg.metadata?.groupId
      ? `group:${channelMsg.metadata.groupId}`
      : channelMsg.senderId;

    // 生成稳定的 sessionId（避免渠道来源影响 session）
    const stableSessionId = (() => {
      if (channelMsg.type === 'group' && channelMsg.metadata?.groupId) {
        return `group-${channelMsg.metadata.groupId}`;
      }
      return `user-${channelMsg.senderId}`;
    })();

    // sendReply closure - resolveSessionId will be set after target agent is determined
    let resolveSessionId: () => string = () => stableSessionId;
    const setReplySessionId = (sid: string) => { resolveSessionId = () => sid; };

    const sendReply = async (text: string, agentId?: string) => {
      if (!text || !text.trim()) return;
      try {
        const replyWithPrefix = addAgentPrefix(text, agentId);
        const sendResult = await channelBridgeManager.sendMessage(channelMsg.channelId, {
          to: target,
          text: replyWithPrefix,
          replyTo: (channelMsg.metadata?.messageId as string) || channelMsg.id,
        });
        log.info('Hub route reply sent', { messageId: sendResult.messageId });

        // 将回复写入 session（保证 WebUI 可见）
        const replySessionId = resolveSessionId();
        sessionManager.addMessage(replySessionId, 'assistant', replyWithPrefix, {
          type: 'text',
          agentId: agentId || 'system',
          metadata: {
            channelId: channelMsg.channelId,
            messageId: channelMsg.id,
          },
        });
      } catch (sendErr) {
        log.error('Failed to send reply (hub route)', sendErr instanceof Error ? sendErr : undefined);
      }
    };

    // Parse command
    const metadata = channelMsg.metadata as Record<string, unknown> | undefined;
    const commandSource = (
      (typeof metadata?.RawBody === 'string' && metadata.RawBody.trim())
      || (typeof metadata?.CommandBody === 'string' && metadata.CommandBody.trim())
      || (typeof metadata?.Body === 'string' && metadata.Body.trim())
      || (typeof metadata?.BodyForAgent === 'string' && metadata.BodyForAgent.trim())
      || channelMsg.content
    );

    const parsed = parseCommands(commandSource);
    if (parsed.commands.length > 0) {
      const commandHub = getCommandHub();
      const command = parsed.commands[0];

      const ctx = {
        channelId: channelMsg.channelId,
        sessionManager,
        eventBus,
        configPath: `${process.env.HOME || ''}/.finger/config/config.json`,
        updateContext: (id: string, mode: 'business' | 'system', agentId: string) => {
          channelContextManager.updateContext(id, mode, agentId);
        }
      };

      const result = await commandHub.execute(command, ctx);
      await sendReply(result.output || result.error || 'CommandHub 执行失败', 'messagehub');
      return;
    }

    // 解析命令时剥离 marker，传递给 agent 的内容不包含 <##...##>
    const cleanContent = parsed.effectiveContent || channelMsg.content;

    // 处理附件（图片等）：如果消息包含图片附件，附加到 prompt 中
    let enrichedContent = cleanContent;
    if (channelMsg.attachments && Array.isArray(channelMsg.attachments) && channelMsg.attachments.length > 0) {
      const imageAttachments = channelMsg.attachments.filter(
        (a: any) => a.type === 'image' && a.url
      );
      if (imageAttachments.length > 0) {
        const imageDescs = imageAttachments.map((a: any, i: number) =>
          `[图片${i + 1}: ${a.filename || a.url}]`
        ).join('\n');
        enrichedContent = imageDescs + '\n' + cleanContent;
        log.info('Message contains image attachments', {
          count: imageAttachments.length,
          urls: imageAttachments.map((a: any) => a.url),
        });
      }
    }

    // Check channel policy
    const fingerConfig = await loadFingerConfig();
    const channelPolicy = getChannelAuth(fingerConfig, channelMsg.channelId);
    const channelAuthorizationMode = getChannelAuthorizationMode(fingerConfig, channelMsg.channelId);
    if (channelPolicy === 'mailbox') {
      log.info('Channel policy is mailbox, creating pending entry');
      await sendReply('消息已加入队列等待处理');
      return;
    }

    // 为 QQBot 使用固定 session（每次都使用同一个，避免不停开新 session）
    // 当派发给 System Agent 时，使用系统 session
    const targetAgentId = channelContextManager.getTargetAgent(channelMsg.channelId, {
      type: 'normal',
      targetAgent: ''
    });
    // 记录当前渠道授权策略（供工具调用时使用）
    deps.runtime.setAgentAuthorizationMode(targetAgentId, channelAuthorizationMode, channelMsg.channelId);
    const isSystemAgentTarget = targetAgentId === SYSTEM_AGENT_CONFIG.id;
    const fixedSessionId = isSystemAgentTarget
      ? sessionManager.getOrCreateSystemSession().id
      : stableSessionId;
    setReplySessionId(fixedSessionId);
    const currentSession = sessionManager.getSession(fixedSessionId);

    if (!currentSession) {
      if (isSystemAgentTarget) {
        // System session already created by getOrCreateSystemSession()
      } else {
        sessionManager.ensureSession(fixedSessionId, process.cwd(), `channel:${channelMsg.channelId}`);
      }
      log.info('[ChannelBridgeHubRoute] Created new QQBot session', {
        sessionId: fixedSessionId,
        channelId: channelMsg.channelId,
        senderId: channelMsg.senderId
      });
    } else {
      log.debug('[ChannelBridgeHubRoute] Reusing existing QQBot session', {
        sessionId: fixedSessionId
      });
    }
    sessionManager.addMessage(fixedSessionId, 'system', '已收到，正在处理中…', {
      type: 'dispatch',
      metadata: { channelId: channelMsg.channelId, messageId: channelMsg.id },
    });

    // 将用户原始输入以 'user' 角色写入 session（保证 WebUI 可见）
    sessionManager.addMessage(fixedSessionId, 'user', enrichedContent, {
      type: 'text',
      metadata: {
        channelId: channelMsg.channelId,
        senderId: channelMsg.senderId,
        senderName: channelMsg.senderName,
        messageId: channelMsg.id,
      },
    });

    // Dispatch to current agent
    try {
      const dispatchRequest: AgentDispatchRequest = {
        sourceAgentId: 'channel-bridge',
        targetAgentId,
        task: { prompt: enrichedContent },
        sessionId: fixedSessionId,
        metadata: {
          source: 'channel',
          channelId: channelMsg.channelId,
          senderId: channelMsg.senderId,
          senderName: channelMsg.senderName,
          messageId: channelMsg.id,
          type: channelMsg.type,
        },
        blocking: true,
        queueOnBusy: true,
        maxQueueWaitMs: 180000,
      };

      // 注册 session-envelope 映射（用于 Agent Status Subscriber）
      if (agentStatusSubscriber) {
        agentStatusSubscriber.registerSession(fixedSessionId, {
          channel: channelMsg.channelId,
          envelopeId: channelMsg.id,
          userId: channelMsg.senderId,
          groupId: channelMsg.type === 'group' ? (channelMsg.metadata?.groupId as string) : undefined,
        });
        log.info('[ChannelBridgeHubRoute] Registered session for status updates', {
          sessionId: fixedSessionId,
          targetAgentId,
        });
      }

      log.info('Hub route dispatching to agent', { targetAgentId });
      const result = await dispatchTaskToAgent(dispatchRequest);

      log.info('Hub route dispatch result', {
        hasResult: !!result,
        resultType: typeof result,
        ok: typeof result === 'object' && result !== null && 'ok' in result ? (result as any).ok : undefined,
      });


      if (result && typeof result === 'object' && 'ok' in result && result.ok && 'result' in result) {
        const replyText = typeof result.result === 'string'
          ? result.result
          : ((result.result as any)?.summary || '处理完成');
        await sendReply(replyText, targetAgentId);
      }
    } catch (err) {
      log.error('Hub route dispatch error', err instanceof Error ? err : undefined);
      await sendReply('处理失败，请稍后再试', 'messagehub');
    } finally {
      // 延迟清理 session 映射（给状态更新发送留出时间）
      if (agentStatusSubscriber) {
        setTimeout(() => {
          agentStatusSubscriber.unregisterSession(fixedSessionId);
          log.info('[ChannelBridgeHubRoute] Unregistered session', { sessionId: fixedSessionId });
        }, 30_000); // 30秒后清理
      }
    }
  };
}
