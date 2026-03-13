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
import { parseSuperCommand } from '../middleware/super-command-parser.js';
import {
  handleCmdList,
  handleAgentList,
  handleAgentNew,
  handleAgentSwitch,
  handleAgentDelete,
  handleSystemCommand,
  handleProjectList,
  handleProjectSwitch,
  handleProviderList,
  handleProviderSwitch,
} from './messagehub-command-handler.js';
import { loadFingerConfig, getChannelAuth } from '../../core/config/channel-config.js';

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

    // Parse super commands
    const metadata = channelMsg.metadata as Record<string, unknown> | undefined;
    const commandSource = (
      (typeof metadata?.RawBody === 'string' && metadata.RawBody.trim())
      || (typeof metadata?.CommandBody === 'string' && metadata.CommandBody.trim())
      || (typeof metadata?.Body === 'string' && metadata.Body.trim())
      || (typeof metadata?.BodyForAgent === 'string' && metadata.BodyForAgent.trim())
      || channelMsg.content
    );
    const parsedCommand = parseSuperCommand(commandSource);
    if (parsedCommand.type === 'super_command' && parsedCommand.blocks && parsedCommand.blocks.length > 0) {
      const firstBlock = parsedCommand.blocks[0];
      console.log('[Server] Channel super command detected:', firstBlock.type);

      try {
        if (firstBlock.type === 'cmd_list') {
          const result = await handleCmdList();
          await sendReply(result, 'messagehub');
          return;
        }

        if (firstBlock.type === 'agent_list') {
          const result = await handleAgentList(sessionManager, firstBlock.path);
          await sendReply(result, 'messagehub');
          channelContextManager.updateContext(
            channelMsg.channelId,
            'business',
            'finger-orchestrator'
          );
          return;
        }

        if (firstBlock.type === 'agent_new') {
          const result = await handleAgentNew(sessionManager, firstBlock.path, eventBus);
          await sendReply(result, 'messagehub');
          channelContextManager.updateContext(
            channelMsg.channelId,
            'business',
            'finger-orchestrator'
          );
          return;
        }

        if (firstBlock.type === 'agent_switch' && firstBlock.sessionId) {
          const result = await handleAgentSwitch(sessionManager, firstBlock.sessionId, eventBus);
          await sendReply(result, 'messagehub');
          channelContextManager.updateContext(
            channelMsg.channelId,
            'business',
            'finger-orchestrator'
          );
          return;
        }

        if (firstBlock.type === 'agent_delete') {
          const result = await handleAgentDelete(sessionManager, firstBlock.sessionId!, eventBus);
          await sendReply(result, 'messagehub');
          channelContextManager.updateContext(
            channelMsg.channelId,
            'business',
            'finger-orchestrator'
          );
          return;
        }

      if (firstBlock.type === 'system') {
         // Check for <##@system:restart##> command
         if (firstBlock.content === 'restart') {
           await sendReply('系统重启指令已接收，正在安全重启 daemon...', 'messagehub');

           // Trigger graceful restart via process manager
           try {
             const daemon = (globalThis as any).__daemonInstance;
             // Using global daemon instance
             if (daemon && typeof daemon.restart === 'function') {
               await daemon.restart();
             } else {
               // Fallback: use safe restart endpoint
               await sendReply('⚠️ Daemon 实例不可用，请手动重启服务', 'messagehub');
             }
           } catch (err) {
             console.error('[Server] Daemon restart error:', err);
             await sendReply(`重启失败: ${err instanceof Error ? err.message : String(err)}`, 'messagehub');
           }
           return;
         }

         // Check for provider commands
         if (firstBlock.content === 'provider_list') {
           const result = await handleProviderList();
           await sendReply(result, 'messagehub');
           return;
         }

         if (firstBlock.content?.startsWith('provider_switch:')) {
           const providerId = firstBlock.content.replace('provider_switch:', '');
           const result = await handleProviderSwitch(providerId);
           await sendReply(result, 'messagehub');
           return;
         }

          // Update context for system agent (persistent until agent/project switch)
          const result = await handleSystemCommand(sessionManager, eventBus);
          channelContextManager.updateContext(
            channelMsg.channelId,
            'system',
            'finger-system-agent'
          );
          await sendReply(result, 'messagehub');
          return;
        }

        if (firstBlock.type === 'project_list') {
          const result = await handleProjectList(sessionManager);
          await sendReply(result, 'messagehub');
          return;
        }

        if (firstBlock.type === 'project_switch' && firstBlock.path) {
         const result = await handleProjectSwitch(sessionManager, firstBlock.path, eventBus);
          channelContextManager.updateContext(
            channelMsg.channelId,
            'business',
            'finger-orchestrator'
          );
          await sendReply(result, 'messagehub');
          return;
        }
      } catch (err) {
        console.error('[Server] Channel super command error:', err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        await sendReply(`命令执行失败: ${errorMessage}`, 'messagehub');
        return;
      }
    }

    // 解析命令时剥离 marker，传递给 agent 的内容不包含 <##...##>
    const cleanContent = (parsedCommand.type === 'super_command' && parsedCommand.effectiveContent)
      ? parsedCommand.effectiveContent
      : channelMsg.content;

    // Check channel policy
    const fingerConfig = await loadFingerConfig();
    const channelPolicy = getChannelAuth(fingerConfig, channelMsg.channelId);
    if (channelPolicy === 'mailbox') {
      console.log('[Server] Channel policy is mailbox, creating pending entry');
      // TODO: Implement mailbox entry creation
      await sendReply('消息已加入队列等待处理');
      return;
    }

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

   // Dispatch to orchestrator
   try {
      const targetAgentId = channelContextManager.getTargetAgent(channelMsg.channelId, parsedCommand);

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

      console.log('[Server] Hub route dispatching to orchestrator');
      const result = await dispatchTaskToAgent(dispatchRequest);

      const dispatchTargetAgentId = dispatchRequest.targetAgentId;
      if (result && typeof result === 'object' && 'ok' in result && result.ok && 'result' in result) {
        const replyText = typeof result.result === 'string'
          ? result.result
          : ((result.result as any)?.summary || '处理完成');
        await sendReply(replyText, dispatchTargetAgentId);
      } else if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        const errorText = `处理失败: ${(result as any).error || 'unknown error'}`;
        await sendReply(errorText, dispatchTargetAgentId);
      }
    } catch (err) {
      console.error('[Server] Hub route dispatch error:', err);
      const message = err instanceof Error ? err.message : String(err);
      await sendReply(`系统错误: ${message}`);
    }
  };
}
