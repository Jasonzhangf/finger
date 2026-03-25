/**
 * ChannelBridge MessageHub Route Handler
 *
 * 提供统一的 MessageHub 路由逻辑，用于 dynamic channel routing。
 */

import type { ChannelMessage } from '../../bridges/types.js';
import type { AgentDispatchRequest } from './agent-runtime/types.js';
import { existsSync } from 'node:fs';
import type { ChannelBridgeManager } from '../../bridges/manager.js';
import type { AskManager } from '../../orchestration/ask/ask-manager.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import { ChannelContextManager } from '../../orchestration/channel-context-manager.js';
import { getCommandHub, parseCommands } from '../../blocks/command-hub/index.js';
import { loadFingerConfig, getChannelAuth } from '../../core/config/channel-config.js';
import { logger } from '../../core/logger.js';
import { SYSTEM_AGENT_CONFIG } from '../../agents/finger-system-agent/index.js';
import type { AgentStatusSubscriber } from './agent-status-subscriber.js';
import { SYSTEM_PROJECT_PATH } from '../../agents/finger-system-agent/index.js';

// 消息去重：防止同一条消息被重复处理（QQ Bot 偶发重复推送）
const processedMessages = new Map<string, number>();
const DEDUP_TTL_MS = 60_000;

function toKernelHistoryItems(
  history: Array<{ role: string; content: string }>,
): Array<Record<string, unknown>> {
  return history
    .filter((item) => typeof item.content === 'string' && item.content.trim().length > 0)
    .map((item) => {
      const role = item.role === 'assistant' ? 'assistant' : 'user';
      return {
        role,
        content: [
          {
            type: role === 'assistant' ? 'output_text' : 'input_text',
            text: item.content,
          },
        ],
      };
    });
}

function toKernelInputItemsFromAttachments(message: ChannelMessage): Array<Record<string, unknown>> {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const imageAttachments = attachments.filter((a) => a?.type === 'image' && typeof a.url === 'string' && a.url.trim().length > 0);
  if (imageAttachments.length === 0) return [];

  const items: Array<Record<string, unknown>> = [];
  for (const att of imageAttachments) {
    const rawUrl = att.url.trim();
    if (!rawUrl) continue;

    if (rawUrl.startsWith('data:image/')) {
      items.push({ type: 'image', image_url: rawUrl });
      continue;
    }

    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      items.push({ type: 'image', image_url: rawUrl });
      continue;
    }

    const localPath = rawUrl.startsWith('file://')
      ? (() => {
          try {
            return decodeURIComponent(rawUrl.replace(/^file:\/\//, ''));
          } catch {
            return rawUrl.replace(/^file:\/\//, '');
          }
        })()
      : rawUrl;
    if (existsSync(localPath)) {
      items.push({ type: 'local_image', path: localPath });
      continue;
    }

    // 最后兜底：当作 image_url 传给 kernel，由 provider/模型决定是否可访问
    items.push({ type: 'image', image_url: rawUrl });
  }

  return items;
}

function sanitizePromptForInjectedImages(content: string): string {
  if (!content || content.trim().length === 0) return content;
  const localImagePathPattern = /(?:file:\/\/)?(?:\/Users\/|\/home\/|[A-Za-z]:[\\/])[^\s<>"']+\.(?:png|jpe?g|gif|webp|bmp|svg|tiff?)/gi;
  return content.replace(localImagePathPattern, '[local-image]');
}

function extractLocalImagePathsFromKernelItems(items: Array<Record<string, unknown>>): string[] {
  const result: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.type !== 'local_image') continue;
    if (typeof item.path !== 'string') continue;
    const trimmed = item.path.trim();
    if (trimmed.length === 0) continue;
    result.push(trimmed);
  }
  return result;
}

function withInjectedImageHint(content: string, localImagePaths: string[] = []): string {
  const dedupedPaths = Array.from(new Set(localImagePaths.filter((path) => typeof path === 'string' && path.trim().length > 0)));
  const hintLines = [
    '【图像输入说明】图片已作为 input_image 注入本轮上下文，请先直接识别图片内容。',
    dedupedPaths.length > 0
      ? '本轮包含本地图片路径，必须先调用 view_image 查看后再回答，禁止猜测。'
      : '若模型反馈看不到图片（例如出现 [Image omitted]）或无法确认，请立即调用 view_image 查看本地图片后再回答，禁止猜测。',
    ...(dedupedPaths.length > 0
      ? [
          '可用本地图片路径：',
          ...dedupedPaths.map((path) => `- ${path}`),
        ]
      : []),
  ];
  const hint = hintLines.join('\n');
  if (!content || content.trim().length === 0) return hint;
  if (content.includes('【图像输入说明】')) {
    if (content.includes('若模型反馈看不到图片') && dedupedPaths.every((path) => content.includes(path))) {
      return content;
    }
    return `${content}\n\n${hint}`;
  }
  return `${content}\n\n${hint}`;
}

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

    const routedAgentId = channelContextManager.getTargetAgent(channelMsg.channelId, {
      type: 'normal',
      targetAgent: ''
    });
    // Channel ingress must always go through System Agent first.
    const targetAgentId = SYSTEM_AGENT_CONFIG.id;
    if (routedAgentId !== targetAgentId) {
      log.info('Channel target overridden to system agent', {
        channelId: channelMsg.channelId,
        routedAgentId,
        targetAgentId,
      });
    }
    const fixedSessionId = sessionManager.getOrCreateSystemSession().id;
    sessionManager.ensureSession(fixedSessionId, SYSTEM_PROJECT_PATH, `channel:${channelMsg.channelId}`);
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
    sessionManager.updateContext(fixedSessionId, {
      channelId: channelMsg.channelId,
      channelUserId: channelMsg.senderId,
      ...(channelMsg.type === 'group' && typeof channelMsg.metadata?.groupId === 'string'
        ? { channelGroupId: channelMsg.metadata.groupId }
        : {}),
      lastChannelMessageId: channelMsg.id,
    });

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
      } catch (sendErr) {
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

    // 处理附件（图片等）：构建真实图片 inputItems，禁止 mock 路径描述
    let enrichedContent = cleanContent;
    let kernelInputItems: Array<Record<string, unknown>> = [];
    if (channelMsg.attachments && Array.isArray(channelMsg.attachments) && channelMsg.attachments.length > 0) {
      const imageAttachments = channelMsg.attachments.filter(
        (a: any) => a.type === 'image' && a.url
      );
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
        // 避免把本地路径注入 prompt；仅保留用户文本或最小提示
        if (!enrichedContent || enrichedContent.trim().length === 0 || enrichedContent.trim() === '【附件消息】image') {
          enrichedContent = '请查看我发送的图片并回答。';
        }
        if (kernelInputItems.length > 0) {
          const localImagePaths = extractLocalImagePathsFromKernelItems(kernelInputItems);
          enrichedContent = withInjectedImageHint(enrichedContent, localImagePaths);
        }
      }
    }

    // Check channel policy
    const fingerConfig = await loadFingerConfig();
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
    void sessionManager.addMessage(fixedSessionId, 'system', '已收到，正在处理中…', {
      type: 'dispatch',
      metadata: { channelId: channelMsg.channelId, messageId: channelMsg.id },
    });

    // 将用户原始输入以 'user' 角色写入 session（保证 WebUI 可见）
    void sessionManager.addMessage(fixedSessionId, 'user', enrichedContent, {
      type: 'text',
      metadata: {
        channelId: channelMsg.channelId,
        senderId: channelMsg.senderId,
        senderName: channelMsg.senderName,
        messageId: channelMsg.id,
        // 附件不保存完整对象，只保留占位摘要（已在 enrichedContent 中）
        ...(Array.isArray(channelMsg.attachments) && channelMsg.attachments.length > 0
          ? { hasAttachments: true, attachmentCount: channelMsg.attachments.length }
          : {}),
      },
    });

    // Dispatch to current agent
    // Progress handled by ProgressMonitor
    try {
      // Build stable history snapshot for kernel from SessionManager (SSOT)
      const history = sessionManager.getMessages(fixedSessionId, 50);
      const kernelApiHistory = toKernelHistoryItems(history);
      const contextLedgerRootDir = SYSTEM_PROJECT_PATH.endsWith('/system')
        ? `${SYSTEM_PROJECT_PATH}/sessions`
        : `${SYSTEM_PROJECT_PATH}/sessions`;
      const sharedMetadata = {
        source: 'channel',
        channelId: channelMsg.channelId,
        senderId: channelMsg.senderId,
        senderName: channelMsg.senderName,
        messageId: channelMsg.id,
        type: channelMsg.type,
        contextLedgerRootDir,
        ...(kernelInputItems.length > 0 ? { inputItems: kernelInputItems } : {}),
        ...(kernelApiHistory.length > 0 ? { kernelApiHistory } : {}),
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
      if (targetAgentId === SYSTEM_AGENT_CONFIG.id) {
        if (typeof directSendToModule !== 'function') {
          throw new Error('system-agent direct input path unavailable (dispatch fallback disabled)');
        }
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
        const dispatchRequest: AgentDispatchRequest = {
          sourceAgentId: 'channel-bridge',
          targetAgentId,
          task: { prompt: enrichedContent },
          sessionId: fixedSessionId,
          metadata: sharedMetadata,
          blocking: true,
          queueOnBusy: true,
          maxQueueWaitMs: 180000,
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
      // 当前用户轮次结束后及时解绑 envelope，避免后续 heartbeat/mailbox 后台任务继续向同一用户外发噪音更新。
      if (agentStatusSubscriber) {
        agentStatusSubscriber.unregisterSession(fixedSessionId);
      }
    }
  };
}
