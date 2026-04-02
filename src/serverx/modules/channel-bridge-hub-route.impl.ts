/**
 * ChannelBridge MessageHub Route Handler
 *
 * 提供统一的 MessageHub 路由逻辑，用于 dynamic channel routing。
 */

import type { ChannelAttachment, ChannelMessage } from '../../bridges/types.js';
import type { AgentDispatchRequest } from '../../server/modules/agent-runtime/types.js';
import type { ChannelBridgeManager } from '../../bridges/manager.js';
import type { AskManager } from '../../orchestration/ask/ask-manager.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import { ChannelContextManager } from '../../orchestration/channel-context-manager.js';
import { CommandType, getCommandHub, parseCommands } from '../../blocks/command-hub/index.js';
import { loadFingerConfig, getChannelAuth } from '../../core/config/channel-config.js';
import { logger } from '../../core/logger.js';
import { SYSTEM_AGENT_CONFIG } from '../../agents/finger-system-agent/index.js';
import type { AgentStatusSubscriber } from '../../server/modules/agent-status-subscriber.js';
import { SYSTEM_PROJECT_PATH } from '../../agents/finger-system-agent/index.js';
import {
  addAgentPrefix,
  isAttachmentMarkerText,
  isDuplicateMessage,
  looksLikeCurrentTurnMediaRequest,
  resolveSessionForChannelTarget,
  sanitizePromptForInjectedImages,
  splitInboundAttachmentsByWhitelist,
  toKernelHistoryItems,
  toKernelInputItemsFromAttachments,
} from '../../server/modules/channel-bridge-hub-route-helpers.js';
import { triggerChannelLinkAutoDetail } from '../../server/modules/channel-link-auto-detail.js';

const log = logger.module('ChannelBridgeHubRoute');

export interface ChannelBridgeHubRouteDeps {
  channelBridgeManager: ChannelBridgeManager;
  sessionManager: SessionManager;
  askManager: AskManager;
  dispatchTaskToAgent: (request: AgentDispatchRequest) => Promise<unknown>;
  directSendToModule?: (moduleId: string, message: unknown) => Promise<unknown>;
  eventBus: UnifiedEventBus;
  agentStatusSubscriber?: AgentStatusSubscriber;
  runtime: Record<string, unknown>;
}

export function createChannelBridgeHubRoute(deps: ChannelBridgeHubRouteDeps) {
  const {
    channelBridgeManager,
    sessionManager,
    askManager,
    dispatchTaskToAgent,
    directSendToModule,
    eventBus,
    agentStatusSubscriber,
  } = deps;
  log.info('[ChannelBridgeHubRoute] agentStatusSubscriber available:', { available: !!agentStatusSubscriber });
  const channelContextManager = ChannelContextManager.getInstance();
  const ASYNC_USER_ASK_CHANNELS = new Set(['qqbot', 'weixin']);

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

    const routedAgentId = channelContextManager.getTargetAgent(channelMsg.channelId, {
      type: 'normal',
      targetAgent: ''
    });
    const targetAgentId = routedAgentId || SYSTEM_AGENT_CONFIG.id;
    const channelContext = channelContextManager.getContext(channelMsg.channelId);

    const { sessionId: fixedSessionId, projectPath: sessionProjectPath } = resolveSessionForChannelTarget({
      sessionManager,
      channelContextManager,
      targetAgentId,
      channelId: channelMsg.channelId,
      channelContext,
    });
    const runtimeSetCurrentSession = (deps.runtime as { setCurrentSession?: (sessionId: string) => boolean }).setCurrentSession;
    if (typeof runtimeSetCurrentSession === 'function') {
      const switched = runtimeSetCurrentSession.call(deps.runtime, fixedSessionId);
      if (!switched) {
        log.warn('Failed to switch runtime current session for channel message', {
          sessionId: fixedSessionId,
          channelId: channelMsg.channelId,
        });
      }
    }
    const runtimeBindAgentSession = (deps.runtime as { bindAgentSession?: (agentId: string, sessionId: string) => void }).bindAgentSession;
    if (typeof runtimeBindAgentSession === 'function') {
      runtimeBindAgentSession.call(deps.runtime, targetAgentId, fixedSessionId);
    }
    sessionManager.updateContext(fixedSessionId, {
      channelId: channelMsg.channelId,
      channelUserId: channelMsg.senderId,
      ...(channelMsg.type === 'group' && typeof channelMsg.metadata?.groupId === 'string'
        ? { channelGroupId: channelMsg.metadata.groupId }
        : {}),
      lastChannelMessageId: channelMsg.id,
    });
    const sessionContext = sessionManager.getSession(fixedSessionId)?.context;
    if (sessionContext && typeof sessionContext === 'object') {
      const ctx = sessionContext as Record<string, unknown>;
      if (ctx.progressDeliveryTransient === true) {
        sessionManager.updateContext(fixedSessionId, {
          progressDelivery: null,
          progressDeliveryTransient: false,
          progressDeliveryUpdatedAt: null,
        });
      }
    }

    const sendReply = async (text: string, agentId?: string) => {
      if (!text || !text.trim()) return;
      const routeRef = {
        channelId: channelMsg.channelId,
        userId: channelMsg.senderId,
        groupId: channelMsg.type === 'group' && typeof channelMsg.metadata?.groupId === 'string'
          ? channelMsg.metadata.groupId
          : undefined,
      };
      const routeDedupHit = agentStatusSubscriber?.wasBodyUpdateRecentlySentForRoute(
        routeRef,
        text,
      );
      const sessionDedupHit = agentStatusSubscriber?.wasBodyUpdateRecentlySent(fixedSessionId, text);
      const routeRecentBodyHit = agentStatusSubscriber?.wasAnyBodyUpdateRecentlySentForRoute(routeRef);
      if (routeDedupHit || sessionDedupHit || routeRecentBodyHit) {
        log.info('Skip direct sendReply because same body update was already pushed', {
          sessionId: fixedSessionId,
          channelId: channelMsg.channelId,
          targetAgentId: agentId,
          routeDedupHit: Boolean(routeDedupHit),
          sessionDedupHit: Boolean(sessionDedupHit),
          routeRecentBodyHit: Boolean(routeRecentBodyHit),
        });
        return;
      }
      try {
        // Pre-mark final reply before channel IO so concurrent bodyUpdates can
        // dedup against this reply and avoid double delivery.
        if (agentStatusSubscriber) {
          agentStatusSubscriber.markFinalReplySent(fixedSessionId, text);
        }
        const replyWithPrefix = addAgentPrefix(text, agentId);
        const sendResult = await channelBridgeManager.sendMessage(channelMsg.channelId, {
          to: target,
          text: replyWithPrefix,
          replyTo: (channelMsg.metadata?.messageId as string) || channelMsg.id,
        });
        log.info('Hub route reply sent', { messageId: sendResult.messageId });
      } catch (sendErr) {
        if (agentStatusSubscriber) {
          agentStatusSubscriber.clearFinalReplySent(fixedSessionId);
        }
        log.error('Failed to send reply (hub route)', sendErr instanceof Error ? sendErr : undefined);
      }

    };

    if (ASYNC_USER_ASK_CHANNELS.has(channelMsg.channelId)) {
      const askScope = {
        channelId: channelMsg.channelId,
        userId: channelMsg.senderId,
        ...(channelMsg.type === 'group' && typeof channelMsg.metadata?.groupId === 'string'
          ? { groupId: channelMsg.metadata.groupId }
          : {}),
      };
      const pendingAsk = askManager.listPending(askScope)[0];
      const askResolution = pendingAsk
        ? askManager.resolveByRequestId(pendingAsk.requestId, channelMsg.content)
        : null;

      if (askResolution) {
        const askSessionId = pendingAsk?.sessionId ?? fixedSessionId;
        void sessionManager.addMessage(askSessionId, 'user', channelMsg.content, {
          type: 'text',
          metadata: {
            channelId: channelMsg.channelId,
            senderId: channelMsg.senderId,
            senderName: channelMsg.senderName,
            messageId: channelMsg.id,
            askRequestId: askResolution.requestId,
            askResponse: true,
          },
        });
        await sendReply('已收到你的回复，继续处理中…', targetAgentId);
        return;
      }
    }

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
        updateContext: (
          id: string,
          mode: 'business' | 'system',
          agentId: string,
          projectContext?: { projectId?: string; projectPath?: string; projectAlias?: string },
        ) => {
          channelContextManager.updateContext(id, mode, agentId, undefined, projectContext);
        }
      };

      const result = await commandHub.execute(command, ctx);
      const hasFollowupContent = parsed.effectiveContent.trim().length > 0;
      const shouldContinueAfterSwitch = result.success
        && hasFollowupContent
        && (command.type === CommandType.AGENT || command.type === CommandType.SYSTEM);
      if (!shouldContinueAfterSwitch) {
        await sendReply(result.output || result.error || 'CommandHub 执行失败', 'messagehub');
        return;
      }
      log.info('Command switch applied, continuing with effective content in same turn', {
        commandType: command.type,
        channelId: channelMsg.channelId,
      });
    }

    // 解析命令时剥离 marker，传递给 agent 的内容不包含 <##...##>
    const cleanContent = parsed.effectiveContent || channelMsg.content;

    // 处理附件（白名单）：当前仅允许 image。其他类型直接拒绝本轮输入，避免污染推理会话。
    let enrichedContent = cleanContent;
    let kernelInputItems: Array<Record<string, unknown>> = [];
    const rawAttachments = Array.isArray(channelMsg.attachments) ? channelMsg.attachments : [];
    const { accepted: channelAttachments, rejected: rejectedAttachments } = splitInboundAttachmentsByWhitelist(rawAttachments);
    if (rejectedAttachments.length > 0) {
      const rejectedTypes = Array.from(new Set(rejectedAttachments
        .map((attachment) => (typeof attachment?.type === 'string' ? attachment.type : 'unknown'))
        .filter((type) => type.length > 0)));
      log.warn('Ignored unsupported inbound channel attachments by whitelist', {
        channelId: channelMsg.channelId,
        messageId: channelMsg.id,
        senderId: channelMsg.senderId,
        rejectedTypes,
        rejectedCount: rejectedAttachments.length,
      });
      // Jason 规则：不支持附件仅剥离，不丢弃整条输入。
      // 继续处理文本与支持的附件（当前支持 image）。
    }
    let missingCurrentMediaAttachment = false;
    if (channelAttachments.length > 0) {
      const imageAttachments = channelAttachments.filter((a: any) => a.type === 'image' && a.url);
      if (imageAttachments.length > 0) {
        kernelInputItems = toKernelInputItemsFromAttachments(channelMsg);
        log.info('Message contains image attachments', {
          count: imageAttachments.length,
          urls: imageAttachments.map((a: any) => a.url),
          kernelInputItemCount: kernelInputItems.length,
        });
        if (kernelInputItems.length > 0) {
          enrichedContent = sanitizePromptForInjectedImages(enrichedContent);
        }
        // 媒体轮只保留用户文本本身，不注入本地路径/额外流程提示。
        if (!enrichedContent || enrichedContent.trim().length === 0 || isAttachmentMarkerText(enrichedContent)) {
          enrichedContent = '请描述这张图片的内容。';
        }
      }
    } else if (looksLikeCurrentTurnMediaRequest(enrichedContent)) {
      missingCurrentMediaAttachment = true;
      enrichedContent = [
        '【附件状态】当前这条消息未携带附件。',
        '请不要基于历史图片/文件作答；如需识别附件，请先提示用户重新发送当前附件。',
        '',
        enrichedContent,
      ].join('\n');
      log.warn('Current turn looks like media request but has no attachments', {
        channelId: channelMsg.channelId,
        messageId: channelMsg.id,
        senderId: channelMsg.senderId,
      });
    }

    // Check channel policy / channel automation config
    const fingerConfig = await loadFingerConfig();
    void triggerChannelLinkAutoDetail({
      channelId: channelMsg.channelId,
      messageId: channelMsg.id,
      content: cleanContent,
      fingerConfig,
    }).catch((error) => {
      log.error('channel link auto-detail trigger failed', error instanceof Error ? error : undefined, {
        channelId: channelMsg.channelId,
        messageId: channelMsg.id,
      });
    });
    const channelPolicy = getChannelAuth(fingerConfig, channelMsg.channelId);
    if (channelPolicy === 'mailbox') {
      log.info('Channel policy is mailbox, creating pending entry');
      await sendReply('消息已加入队列等待处理');
      return;
    }

    const currentSession = sessionManager.getSession(fixedSessionId);

    if (!currentSession) {
      // System session already created by getOrCreateSystemSession()
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
    // Auto-reply handled by event-forwarding
    // // Auto-reply removed - handled by event-forwarding turn_start reasoning pulse
    // User will see progress updates via update_progress tool or reasoning events

    // Dispatch to current agent
    // Progress handled by ProgressMonitor
    try {
      // Build stable history snapshot for kernel from SessionManager (SSOT)
      const history = sessionManager.getMessages(fixedSessionId, 50);
      const kernelApiHistory = toKernelHistoryItems(history);
      const contextLedgerRootDir = `${sessionProjectPath}/sessions`;
      const sharedMetadata = {
        role: 'user',
        source: 'channel',
        channelId: channelMsg.channelId,
        senderId: channelMsg.senderId,
        senderName: channelMsg.senderName,
        messageId: channelMsg.id,
        type: channelMsg.type,
        contextLedgerRootDir,
        ...(channelContext?.projectAlias ? { projectAlias: channelContext.projectAlias } : {}),
        ...(channelContext?.projectPath ? { projectPath: channelContext.projectPath } : {}),
        ...(channelContext?.projectId ? { projectId: channelContext.projectId } : {}),
        ...(kernelInputItems.length > 0 ? { inputItems: kernelInputItems } : {}),
        ...(channelAttachments.length > 0 ? { attachments: channelAttachments } : {}),
        // 附件轮（含图片/文件）或“当前轮疑似媒体请求但无附件”场景，禁止注入旧 kernelApiHistory，避免沿用上一轮内容。
        ...(channelAttachments.length === 0 && !missingCurrentMediaAttachment && kernelApiHistory.length > 0 ? { kernelApiHistory } : {}),
      };

      if (kernelInputItems.length > 0) {
        log.info('Prepared kernel image inputItems for multimodal turn', {
          sessionId: fixedSessionId,
          targetAgentId,
          itemCount: kernelInputItems.length,
          itemTypes: kernelInputItems.map((i) => i.type),
        });
      }

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

      let result: unknown;
      if (typeof directSendToModule === 'function') {
        // User/channel inbound should go straight to target agent module for in-turn
        // prompt-merge semantics (same as pending_input queue), not via runtime dispatch.
        log.info('Hub route sending direct user input to agent module', {
          targetAgentId,
          sessionId: fixedSessionId,
          channelId: channelMsg.channelId,
        });
        result = await directSendToModule(targetAgentId, {
          prompt: enrichedContent,
          sessionId: fixedSessionId,
          metadata: sharedMetadata,
        });
      } else {
        log.warn('Direct user input path unavailable, falling back to runtime dispatch', {
          targetAgentId,
          sessionId: fixedSessionId,
          channelId: channelMsg.channelId,
        });
        const dispatchRequest: AgentDispatchRequest = {
          sourceAgentId: 'channel-bridge',
          targetAgentId,
          task: { prompt: enrichedContent },
          sessionId: fixedSessionId,
          metadata: sharedMetadata,
          blocking: true,
          queueOnBusy: true,
          // User channel input must eventually be merged and consumed by the target agent.
          // Disable queue timeout fallback-to-mailbox here to avoid "busy timeout" drops.
          maxQueueWaitMs: 0,
        };
        log.info('Hub route dispatching to agent', { targetAgentId });
        // Progress is handled by ProgressMonitor - do not duplicate here
        result = await dispatchTaskToAgent(dispatchRequest);
      }

      log.info('Hub route dispatch result', {
        hasResult: !!result,
        resultType: typeof result,
        ok: typeof result === 'object' && result !== null && 'ok' in result ? (result as any).ok : undefined,
        success: typeof result === 'object' && result !== null && 'success' in result ? (result as any).success : undefined,
      });

      const dispatchFailed = (() => {
        if (!result || typeof result !== 'object') return false;
        const typed = result as Record<string, unknown>;
        if ('ok' in typed && typed.ok === false) return true;
        if ('success' in typed && typed.success === false) return true;
        if (typeof typed.status === 'string' && typed.status.toLowerCase() === 'failed') return true;
        return false;
      })();
      if (!dispatchFailed) {
        // 延后写盘：仅在请求成功发往目标模块后才持久化用户输入。
        // 若本轮输入在发送前/发送中失败，则不写盘，避免下次恢复污染会话。
        void sessionManager.addMessage(fixedSessionId, 'user', enrichedContent, {
          agentId: targetAgentId,
          type: 'text',
          metadata: {
            channelId: channelMsg.channelId,
            senderId: channelMsg.senderId,
            senderName: channelMsg.senderName,
            messageId: channelMsg.id,
            ...(channelAttachments.length > 0
              ? { hasAttachments: true, attachmentCount: channelAttachments.length }
              : {}),
          },
        });
      } else {
        log.warn('Skip persisting user turn because dispatch failed', {
          sessionId: fixedSessionId,
          channelId: channelMsg.channelId,
          messageId: channelMsg.id,
          targetAgentId,
        });
      }

      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok && 'result' in result) {
          const replyText = typeof result.result === 'string'
            ? result.result
            : ((result.result as any)?.summary || '处理完成');
          await sendReply(replyText, targetAgentId);
          return;
        }
        const errorText = typeof (result as any).error === 'string'
          ? (result as any).error
          : '任务派发失败';
        log.warn('Hub route dispatch failed, replying with error', {
          targetAgentId,
          error: errorText,
        });
        await sendReply(`处理失败：${errorText}`, targetAgentId);
        return;
      }

      if (result && typeof result === 'object' && 'success' in result) {
        if ((result as any).success) {
          const replyText = typeof (result as any).response === 'string'
            ? (result as any).response
            : ((result as any)?.summary || '处理完成');
          // 避免重复发送：
          // - directSendToModule 路径下，正文增量会通过 event-forwarding -> bodyUpdates 推送
          // - 若这里再次 sendReply，同一条 <qqimg> 内容会重复发送图片
          if (targetAgentId === SYSTEM_AGENT_CONFIG.id && /<qqimg>[\s\S]*?<\/qqimg>/i.test(replyText)) {
            log.info('Skip direct sendReply for qqimg-rich response to avoid duplicate image delivery', {
              targetAgentId,
              sessionId: fixedSessionId,
            });
            return;
          }
          await sendReply(replyText, targetAgentId);
          return;
        }
        const errorText = typeof (result as any).error === 'string'
          ? (result as any).error
          : '处理失败';
        log.warn('Hub route direct send failed, replying with error', {
          targetAgentId,
          error: errorText,
        });
        await sendReply(`处理失败：${errorText}`, targetAgentId);
        return;
      }

      if (typeof result === 'string' && result.trim().length > 0) {
        await sendReply(result, targetAgentId);
      }
    } catch (err) {
      log.error('Hub route dispatch error', err instanceof Error ? err : undefined);
      await sendReply('处理失败，请稍后再试', 'messagehub');
    } finally {
      // 会话级 channel observers 由 turn_complete / turn_error 统一收敛。
    }
  };
}
