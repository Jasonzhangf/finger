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
import { loadFingerConfig, getChannelAuth } from '../../core/config/channel-config.js';
import { CommandType } from '../../blocks/command-hub/types.js';

export interface ChannelBridgeHubRouteDeps {
  channelBridgeManager: ChannelBridgeManager;
  sessionManager: SessionManager;
  dispatchTaskToAgent: (request: AgentDispatchRequest) => Promise<unknown>;
  eventBus: UnifiedEventBus;
}

export function createChannelBridgeHubRoute(deps: ChannelBridgeHubRouteDeps) {
  const { channelBridgeManager, sessionManager, dispatchTaskToAgent, eventBus } = deps;
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

    console.log('[Server] Processing channel message via MessageHub', {
      channelId: channelMsg.channelId,
      msgId: channelMsg.id,
    });

    const target = channelMsg.type === 'group' && channelMsg.metadata?.groupId
      ? `group:${channelMsg.metadata.groupId}`
      : channelMsg.senderId;

    const sendReply = async (text: string, agentId?: string) => {
      if (!text || !text.trim()) return;
      try {
        const replyWithPrefix = addAgentPrefix(text, agentId);
        const sendResult = await channelBridgeManager.sendMessage(channelMsg.channelId, {
          to: target,
          text: replyWithPrefix,
          replyTo: (channelMsg.metadata?.messageId as string) || channelMsg.id,
        });
        console.log('[Server] Hub route reply sent:', sendResult.messageId);
      } catch (sendErr) {
        console.error('[Server] Failed to send reply (hub route):', sendErr);
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

    // Check channel policy
    const fingerConfig = await loadFingerConfig();
    const channelPolicy = getChannelAuth(fingerConfig, channelMsg.channelId);
    if (channelPolicy === 'mailbox') {
      console.log('[Server] Channel policy is mailbox, creating pending entry');
      await sendReply('消息已加入队列等待处理');
      return;
    }

    // 统一使用当前会话
    const currentSession = sessionManager.getCurrentSession();
    const sessionId = currentSession?.id || `qqbot-${channelMsg.senderId}`;
    if (!currentSession) {
      sessionManager.ensureSession(sessionId, process.cwd(), `channel:${channelMsg.channelId}`);
    }
    sessionManager.addMessage(sessionId, 'system', '已收到，正在处理中…', {
      type: 'dispatch',
      metadata: { channelId: channelMsg.channelId, messageId: channelMsg.id },
    });

    // Dispatch to current agent
    try {
      const targetAgentId = channelContextManager.getTargetAgent(channelMsg.channelId, {
        type: 'normal',
        targetAgent: ''
      });

      const dispatchRequest: AgentDispatchRequest = {
        sourceAgentId: 'channel-bridge',
        targetAgentId,
        task: { prompt: cleanContent },
        sessionId,
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

      console.log('[Server] Hub route dispatching to agent:', targetAgentId);
      const result = await dispatchTaskToAgent(dispatchRequest);

      if (result && typeof result === 'object' && 'ok' in result && result.ok && 'result' in result) {
        const replyText = typeof result.result === 'string'
          ? result.result
          : ((result.result as any)?.summary || '处理完成');
        await sendReply(replyText, targetAgentId);
      }
    } catch (err) {
      console.error('[Server] Hub route dispatch error:', err);
      await sendReply('处理失败，请稍后再试', 'messagehub');
    }
  };
}
