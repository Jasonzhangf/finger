/**
 * ChannelBridge MessageHub Route Handler
 *
 * 提供统一的 MessageHub 路由逻辑，用于 dynamic channel routing。
 */

import type { ChannelMessage } from '../../bridges/types.js';
import type { AgentDispatchRequest } from './agent-runtime/types.js';
import type { ChannelBridgeManager } from '../../bridges/manager.js';
import type { SessionManager } from '../../orchestration/session-manager.js';

export interface ChannelBridgeHubRouteDeps {
  channelBridgeManager: ChannelBridgeManager;
  sessionManager: SessionManager;
  dispatchTaskToAgent: (request: AgentDispatchRequest) => Promise<unknown>;
}

export function createChannelBridgeHubRoute(deps: ChannelBridgeHubRouteDeps) {
  const { channelBridgeManager, sessionManager, dispatchTaskToAgent } = deps;

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

    // 统一使用当前会话（session 切换仅通过 <##@session:switch@...##>）
    const currentSession = sessionManager.getCurrentSession();
    const sessionId = currentSession?.id || `qqbot-${channelMsg.senderId}`;
    if (!currentSession) {
      sessionManager.ensureSession(sessionId, process.cwd(), `channel:${channelMsg.channelId}`);
    }
    sessionManager.addMessage(sessionId, 'system', '已收到，正在处理中…', {
      type: 'dispatch',
      metadata: { channelId: channelMsg.channelId, messageId: channelMsg.id },
    });

    const sendReply = async (text: string) => {
      if (!text || !text.trim()) return;
      try {
        const sendResult = await channelBridgeManager.sendMessage(channelMsg.channelId, {
          to: target,
          text,
          replyTo: (channelMsg.metadata?.messageId as string) || channelMsg.id,
        });
        console.log('[Server] Hub route reply sent:', sendResult.messageId);
      } catch (sendErr) {
        console.error('[Server] Failed to send reply (hub route):', sendErr);
      }
    };

    // Dispatch to orchestrator
    try {
      const dispatchRequest: AgentDispatchRequest = {
        sourceAgentId: 'channel-bridge',
        targetAgentId: 'finger-orchestrator',
        task: { prompt: channelMsg.content },
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

      console.log('[Server] Hub route dispatching to orchestrator');
      const result = await dispatchTaskToAgent(dispatchRequest);

      if (result && typeof result === 'object' && 'ok' in result && result.ok && 'result' in result) {
        const replyText = typeof result.result === 'string'
          ? result.result
          : ((result.result as any)?.summary || '处理完成');
        await sendReply(replyText);
      } else if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        const errorText = `处理失败: ${(result as any).error || 'unknown error'}`;
        await sendReply(errorText);
      }
    } catch (err) {
      console.error('[Server] Hub route dispatch error:', err);
      const message = err instanceof Error ? err.message : String(err);
      await sendReply(`系统错误: ${message}`);
    }
  };
}
