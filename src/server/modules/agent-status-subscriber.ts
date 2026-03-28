/**
 * Agent Status Subscriber
 *
 * 订阅 Agent 运行时事件，实时推送状态更新到通信通道
 * 替代轮询机制，降低资源占用
 *
 * 分层订阅策略：
 * - 主 Agent（当前编排者）：详细、高频、完整信息
 * - 子 Agent（被派发任务）：粗糙、低频、关键状态变化
 *
 * 这个原则递归应用：
 * - System Agent 层级：System Agent 详细，其派发的子 Agent 粗糙
 * - Project Agent 层级：Project Agent 详细，其派发的子 Agent 粗糙
 */

import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { RuntimeEvent, ToolErrorEvent, SystemErrorEvent } from '../../runtime/events.js';
import type { ChannelBridgeEnvelope } from '../../bridges/envelope.js';
import type { PushSettings } from '../../bridges/types.js';
import {
  type SubscriptionLevel,
  type AgentSubscriptionConfig,
  type SessionEnvelopeMapping,
  type TaskContext,
  type AgentInfo,
  type WrappedStatusUpdate,
  KEY_STATE_CHANGES,
} from './agent-status-subscriber-types.js';
import { wrapStatusUpdate } from './agent-status-subscriber-helpers.js';
import { logger } from '../../core/logger.js';
import { sendStatusUpdate, startCleanup, buildMailboxProgressSnapshot } from './agent-status-subscriber-runtime.js';
import {
  handleToolCall as handleToolCallEvent,
  handleToolResult as handleToolResultEvent,
  handleToolError as handleToolErrorEvent,
  handleSystemError as handleSystemErrorEvent,
  handleDispatch as handleDispatchEvent,
  handleWaitingForUser as handleWaitingForUserEvent,
  handleStepCompleted as handleStepCompletedEvent,
  flushStepBuffer as flushStepBufferEvent,
  type HandlerContext,
} from './agent-status-subscriber-handlers.js';
import {
  applyProgressDeliveryPolicy,
  normalizeProgressDeliveryPolicy,
} from '../../common/progress-delivery-policy.js';
import { buildContextUsageLine, normalizeContextUsageSnapshot } from './progress-monitor-utils.js';

/**
 * 默认订阅的事件类型列表
 * 可通过修改此列表来控制哪些事件会被实时推送到 channel
 */
const DEFAULT_SUBSCRIBED_EVENTS = [
  'agent_runtime_status',
  'agent_runtime_dispatch',
  'agent_step_completed',
  'tool_error',
  'system_error',
  'waiting_for_user',
  'tool_call',
  'tool_result',
] as const;

const log = logger.module('AgentStatusSubscriber');
const DEFAULT_REASONING_BODY_BUFFER_MS = 0;
const FALLBACK_PUSH_SETTINGS: PushSettings = {
  updateMode: 'both',
  reasoning: true,
  bodyUpdates: true,
  statusUpdate: true,
  toolCalls: true,
  stepUpdates: true,
  stepBatch: 1,
  progressUpdates: true,
};

function resolveReasoningBodyBufferMs(): number {
  const raw = process.env.FINGER_REASONING_BODY_BUFFER_MS;
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_REASONING_BODY_BUFFER_MS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_REASONING_BODY_BUFFER_MS;
  return parsed;
}

export type { SubscriptionLevel, AgentSubscriptionConfig, SessionEnvelopeMapping, TaskContext, AgentInfo, WrappedStatusUpdate };

export class AgentStatusSubscriber {
  private unsubscribe: (() => void) | null = null;
  private sessionEnvelopeMap = new Map<string, SessionEnvelopeMapping>();
  private sessionObserverMap = new Map<string, SessionEnvelopeMapping['envelope'][]>();
  private agentSubscriptions = new Map<string, AgentSubscriptionConfig>(); // agentId -> config
  private primaryAgentId: string | null = null; // 当前主 Agent（编排者）
  private readonly cleanupIntervalMs = 24 * 60 * 60 * 1000; // 24小时清理一次过期映射（避免长任务丢失更新）
  private _stopCleanup: (() => void) | null = null;

  // Step batching: per-session buffer for batch step updates
  private stepBuffer = new Map<string, Array<{ index: number; summary: string; timestamp: string }>>();
  private stepBatchDefault = 5;
  private finalReplyBySession = new Map<string, { normalized: string; at: number }>();
  private lastBodySentBySession = new Map<string, { normalized: string; at: number }>();
  private lastBodySentByRoute = new Map<string, { normalized: string; at: number }>();
  private lastProgressMailboxSummaryBySession = new Map<string, string>();
  private lastReasoningPushAtByRoute = new Map<string, number>();
  private readonly reasoningBodyBufferMs = resolveReasoningBodyBufferMs();

  private getHandlerContext(): HandlerContext {
    return {
      messageHub: this.messageHub,
      channelBridgeManager: this.channelBridgeManager,
      broadcast: this.broadcast,
      resolveEnvelopeMapping: (sessionId: string) => this.resolveEnvelopeMapping(sessionId),
      resolveEnvelopeMappings: (sessionId: string) => this.resolveEnvelopeMappings(sessionId),
      getAgentInfo: (agentId: string) => this.getAgentInfo(agentId),
      sendReasoningUpdate: (sessionId: string, agentId: string, reasoningText: string) =>
        this.sendReasoningUpdate(sessionId, agentId, reasoningText),
      stepBuffer: this.stepBuffer,
      stepBatchDefault: this.stepBatchDefault,
      primaryAgentId: this.primaryAgentId,
      registerChildAgent: (childAgentId: string, parentAgentId: string) => this.registerChildAgent(childAgentId, parentAgentId),
      registerChildSession: (childSessionId: string, envelope: SessionEnvelopeMapping[ 'envelope']) => this.registerChildSession(childSessionId, envelope),
      resolvePushSettings: (sessionId: string, channelId: string) => this.resolvePushSettings(sessionId, channelId),
    };
  }

 constructor(
   private eventBus: UnifiedEventBus,
   private deps: AgentRuntimeDeps,
   private messageHub?: import('../../orchestration/message-hub.js').MessageHub,
   private channelBridgeManager?: import('../../bridges/manager.js').ChannelBridgeManager,
    private broadcast?: (message: unknown) => void,
 ) {}

  private buildRouteKey(sessionId: string, mapping: SessionEnvelopeMapping): string {
    const envelope = mapping.envelope;
    return [
      sessionId,
      envelope.channel,
      envelope.envelopeId,
      envelope.userId ?? '',
      envelope.groupId ?? '',
    ].join(':');
  }

  private buildDeliveryRouteKey(channelId: string, userId?: string, groupId?: string): string {
    return [channelId.trim(), (groupId ?? '').trim(), (userId ?? '').trim()].join('::');
  }

  private async waitReasoningBufferIfNeeded(sessionId: string, mapping: SessionEnvelopeMapping): Promise<void> {
    if (this.reasoningBodyBufferMs <= 0) return;
    if (mapping.envelope.channel !== 'qqbot') return;

    const routeKey = this.buildRouteKey(sessionId, mapping);
    const lastReasoningAt = this.lastReasoningPushAtByRoute.get(routeKey);
    if (!lastReasoningAt) return;

    const elapsed = Date.now() - lastReasoningAt;
    const waitMs = this.reasoningBodyBufferMs - elapsed;
    if (waitMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  private cleanupRouteStateBySession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.lastReasoningPushAtByRoute.keys()) {
      if (key.startsWith(prefix)) {
        this.lastReasoningPushAtByRoute.delete(key);
      }
    }
  }

  private resolveContextWithFallback(sessionId: string): Record<string, unknown> {
    const visited = new Set<string>();
    let currentSessionId = sessionId;
    while (currentSessionId && !visited.has(currentSessionId)) {
      visited.add(currentSessionId);
      const session = this.deps.sessionManager.getSession(currentSessionId);
      const context = (session?.context && typeof session.context === 'object')
        ? (session.context as Record<string, unknown>)
        : {};
      const hasInteractive = context.progressDelivery !== undefined || context.progress_delivery !== undefined;
      const hasScheduled = context.scheduledProgressDelivery !== undefined || context.scheduled_progress_delivery !== undefined;
      if (hasInteractive || hasScheduled) {
        return context;
      }
      const nextSessionId = typeof context.rootSessionId === 'string' && context.rootSessionId.trim().length > 0
        ? context.rootSessionId.trim()
        : typeof context.parentSessionId === 'string' && context.parentSessionId.trim().length > 0
          ? context.parentSessionId.trim()
          : '';
      if (!nextSessionId) break;
      currentSessionId = nextSessionId;
    }
    const session = this.deps.sessionManager.getSession(sessionId);
    return (session?.context && typeof session.context === 'object')
      ? (session.context as Record<string, unknown>)
      : {};
  }

  private resolvePushSettings(sessionId: string, channelId: string): PushSettings {
    const base = this.channelBridgeManager
      ? this.channelBridgeManager.getPushSettings(channelId)
      : FALLBACK_PUSH_SETTINGS;
    const context = this.resolveContextWithFallback(sessionId);
    const policy = normalizeProgressDeliveryPolicy(
      context.progressDelivery
      ?? context.progress_delivery
      ?? context.scheduledProgressDelivery
      ?? context.scheduled_progress_delivery,
    );
    return applyProgressDeliveryPolicy(base, policy);
  }

  /**
   * 启动订阅
   */
  start(): void {
    if (this.unsubscribe) {
      log.warn('[AgentStatusSubscriber] Already started');
      return;
    }
    log.info(`[AgentStatusSubscriber] Starting... subscribing to: ${DEFAULT_SUBSCRIBED_EVENTS.join(", ")}`);

    this.unsubscribe = this.eventBus.subscribeMultiple(
      [...DEFAULT_SUBSCRIBED_EVENTS],
      (event: RuntimeEvent) => {
        this.handleEvent(event).catch(err => {
          log.error('[AgentStatusSubscriber] Error handling event:', err);
        });
      }
    );

    // 启动定期清理
    this._stopCleanup = startCleanup(this.sessionEnvelopeMap, this.cleanupIntervalMs);

    log.info('[AgentStatusSubscriber] Started');
  }

  private async sendTextUpdate(
    sessionId: string,
    agentId: string,
    text: string,
    setting: 'reasoning' | 'bodyUpdates',
    label: 'reasoning' | 'body',
    prefix: string,
  ): Promise<void> {
    const mappings = this.resolveEnvelopeMappings(sessionId);
    if (mappings.length === 0) return; // heartbeat/system task不用回推通道
    if (!this.messageHub) {
      log.warn(`[AgentStatusSubscriber] No messageHub available for ${label} update`);
      return;
    }
    const deduped = new Map<string, SessionEnvelopeMapping>();
    for (const mapping of mappings) {
      const targetKey = `${mapping.envelope.channel}::${mapping.envelope.groupId ?? ''}::${mapping.envelope.userId ?? ''}`;
      deduped.set(targetKey, mapping);
    }

    for (const mapping of deduped.values()) {
      const pushSettings = this.resolvePushSettings(sessionId, mapping.envelope.channel);
      if (!pushSettings[setting]) continue;

      const outputId = 'channel-bridge-' + mapping.envelope.channel;
      const originalEnvelope: ChannelBridgeEnvelope = {
        id: mapping.envelope.envelopeId,
        channelId: mapping.envelope.channel,
        accountId: 'default',
        type: mapping.envelope.groupId ? 'group' : 'direct',
        senderId: mapping.envelope.userId || 'unknown',
        senderName: 'user',
        content: '',
        timestamp: Date.now(),
        metadata: {
          messageId: mapping.envelope.envelopeId,
          ...(mapping.envelope.groupId ? { groupId: mapping.envelope.groupId } : {}),
        },
      };

      if (label === 'body') {
        await this.waitReasoningBufferIfNeeded(sessionId, mapping);
      }

      const payloadText = label === 'body'
        ? this.normalizeBodyForChannel(text, mapping.envelope.channel)
        : text;
      const chunks = label === 'body'
        ? this.chunkBodyForChannel(payloadText, mapping.envelope.channel)
        : [payloadText];

      for (let i = 0; i < chunks.length; i += 1) {
        const content = `${prefix}${chunks[i]}`;
        const message = {
          channelId: mapping.envelope.channel,
          target: mapping.envelope.groupId ? `group:${mapping.envelope.groupId}` : (mapping.envelope.userId || 'unknown'),
          content,
          originalEnvelope,
          [label]: {
            sessionId,
            agentId,
            chunkIndex: i + 1,
            chunkTotal: chunks.length,
          },
        };

        await this.messageHub.routeToOutput(outputId, message);
        if (i < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }
      if (label === 'reasoning') {
        this.lastReasoningPushAtByRoute.set(this.buildRouteKey(sessionId, mapping), Date.now());
      }
      log.debug(`[AgentStatusSubscriber] Sent ${label} update via MessageHub: ${outputId}`);
    }
  }

  async sendReasoningUpdate(sessionId: string, agentId: string, reasoningText: string): Promise<void> {
    const text = reasoningText.trim();
    if (!text) return;
    await this.sendTextUpdate(sessionId, agentId, text, 'reasoning', 'reasoning', '思考：');
  }

  async sendBodyUpdate(sessionId: string, agentId: string, bodyText: string): Promise<void> {
    const text = this.normalizeLinkDigestBody(bodyText).trim();
    if (!text) return;
    const pureLinkDigest = this.isPureLinkDigest(text);
    const normalizedBody = this.normalizeBodyForDedup(text);

    // If the same final reply has already been sent through the main reply
    // chain for this session, skip additional body push to avoid duplicates.
    const finalReply = this.finalReplyBySession.get(sessionId);
    if (finalReply) {
      const ageMs = Date.now() - finalReply.at;
      if (ageMs <= 10_000 && finalReply.normalized === normalizedBody) {
        this.finalReplyBySession.delete(sessionId);
        return;
      }
      if (ageMs > 10_000) {
        this.finalReplyBySession.delete(sessionId);
      }
    }

    // Dedup: skip if the same body was already sent for this session.
    // Prevents duplicate pushes when identical body text arrives multiple times.
    const dedupKey = `${sessionId}:${normalizedBody.slice(0, 200)}`;
    if ((this as any)._lastBodyDedupKey === dedupKey) {
      return;
    }
    (this as any)._lastBodyDedupKey = dedupKey;

    // Pre-mark body sent before actual channel IO to close race:
    // directSendToModule may try to send final reply concurrently.
    // Marking first allows route-level dedup to suppress duplicate direct replies.
    const sentAt = Date.now();
    this.lastBodySentBySession.set(sessionId, {
      normalized: normalizedBody,
      at: sentAt,
    });
    const preMappings = this.resolveEnvelopeMappings(sessionId);
    for (const mapping of preMappings) {
      const routeKey = this.buildDeliveryRouteKey(
        mapping.envelope.channel,
        mapping.envelope.userId,
        mapping.envelope.groupId,
      );
      this.lastBodySentByRoute.set(routeKey, {
        normalized: normalizedBody,
        at: sentAt,
      });
    }

    await this.sendTextUpdate(
      sessionId,
      agentId,
      text,
      'bodyUpdates',
      'body',
      pureLinkDigest ? '' : '正文：',
    );
  }

  markFinalReplySent(sessionId: string, replyText: string): void {
    const text = replyText.trim();
    if (!text) return;
    this.finalReplyBySession.set(sessionId, {
      normalized: this.normalizeBodyForDedup(text),
      at: Date.now(),
    });
  }

  clearFinalReplySent(sessionId: string): void {
    this.finalReplyBySession.delete(sessionId);
  }

  wasBodyUpdateRecentlySent(sessionId: string, text: string, windowMs = 12_000): boolean {
    const normalized = this.normalizeBodyForDedup(text);
    if (!normalized) return false;
    const recent = this.lastBodySentBySession.get(sessionId);
    if (!recent) return false;
    const ageMs = Date.now() - recent.at;
    if (ageMs > windowMs) {
      this.lastBodySentBySession.delete(sessionId);
      return false;
    }
    return recent.normalized === normalized;
  }

  wasBodyUpdateRecentlySentForRoute(
    route: { channelId: string; userId?: string; groupId?: string },
    text: string,
    windowMs = 12_000,
  ): boolean {
    const normalized = this.normalizeBodyForDedup(text);
    if (!normalized) return false;
    const routeKey = this.buildDeliveryRouteKey(route.channelId, route.userId, route.groupId);
    const recent = this.lastBodySentByRoute.get(routeKey);
    if (!recent) return false;
    const ageMs = Date.now() - recent.at;
    if (ageMs > windowMs) {
      this.lastBodySentByRoute.delete(routeKey);
      return false;
    }
    return recent.normalized === normalized;
  }

  wasAnyBodyUpdateRecentlySentForRoute(
    route: { channelId: string; userId?: string; groupId?: string },
    windowMs = 12_000,
  ): boolean {
    const routeKey = this.buildDeliveryRouteKey(route.channelId, route.userId, route.groupId);
    const recent = this.lastBodySentByRoute.get(routeKey);
    if (!recent) return false;
    const ageMs = Date.now() - recent.at;
    if (ageMs > windowMs) {
      this.lastBodySentByRoute.delete(routeKey);
      return false;
    }
    return true;
  }

  private normalizeBodyForDedup(text: string): string {
    return text
      .trim()
      .replace(/^正文\s*[：:]\s*/u, '')
      .replace(/^\[[^\]]+\]\s*/u, '')
      .trim();
  }

  /**
   * 对新闻类大段链接正文进行硬规范化，确保客户端可解析：
   * - 仅保留 Markdown 链接 [标题](URL)
   * - 一行一个链接（禁止前缀/列表符号）
   * - 自动去重（按 URL）
   * 仅在检测到大量链接时生效，避免影响普通对话正文。
   */
  private normalizeLinkDigestBody(text: string): string {
    const source = text.trim();
    if (!source) return source;
    const pairs = this.extractLinkDigestPairs(source);
    if (pairs.length < 3) return source;

    // Strict digest format: one markdown link per line, no extra text.
    return pairs
      .map((pair) => `[${pair.title}](${pair.url})`)
      .join('\n');
  }

  private isPureLinkDigest(text: string): boolean {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return false;
    const markdownLinkCount = lines.filter((line) => /^\[[^\]\n]{1,220}\]\(https?:\/\/[^)\s]+\)$/u.test(line)).length;
    const urlLineCount = lines.filter((line) => /^https?:\/\/\S+$/u.test(line)).length;
    // Accept either strict markdown link lines, or plain URL-only lines.
    // Require all non-empty lines to be link-like to avoid suppressing "正文：" for normal text.
    return (
      (markdownLinkCount >= 3 && markdownLinkCount === lines.length)
      || (urlLineCount >= 3 && urlLineCount === lines.length)
    );
  }

  private normalizeBodyForChannel(text: string, channelId: string): string {
    const source = text.trim();
    if (!source) return source;
    // QQ/Weixin plain text rendering is more stable with URL on its own line.
    // Convert digest markdown links to:
    // 标题
    // URL
    if (channelId !== 'qqbot' && channelId !== 'openclaw-weixin') {
      return source;
    }
    const pairs = this.extractLinkDigestPairs(source);
    if (pairs.length < 3) return source;
    return pairs
      .map((pair) => `${pair.title}\n${pair.url}`)
      .join('\n\n');
  }

  private chunkBodyForChannel(text: string, channelId: string): string[] {
    if (channelId !== 'qqbot' && channelId !== 'openclaw-weixin') {
      return [text];
    }

    const blocks = text
      .split(/\n\s*\n/u)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (blocks.length <= 5) return [text];

    const digestLikeBlocks = blocks.filter((block) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
      if (lines.length < 2) return false;
      const urlLine = lines[lines.length - 1];
      return /^https?:\/\/\S+$/u.test(urlLine);
    });
    // Only chunk when it clearly looks like a title+url digest.
    if (digestLikeBlocks.length < Math.max(5, Math.floor(blocks.length * 0.8))) {
      return [text];
    }

    const chunks: string[] = [];
    const chunkSize = 5;
    for (let i = 0; i < blocks.length; i += chunkSize) {
      chunks.push(blocks.slice(i, i + chunkSize).join('\n\n'));
    }
    return chunks;
  }

  private extractLinkDigestPairs(text: string): Array<{ title: string; url: string }> {
    const regex = /\[([^\]\n]{1,220})\]\((https?:\/\/[^)\s]+)\)/gu;
    const seen = new Set<string>();
    const pairs: Array<{ title: string; url: string }> = [];
    for (const match of text.matchAll(regex)) {
      const title = (match[1] ?? '').trim();
      const url = (match[2] ?? '').trim();
      if (!title || !url) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      pairs.push({ title, url });
    }
    return pairs;
  }

  /**
   * 停止订阅
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this._stopCleanup?.();
    this._stopCleanup = null;
    log.info('[AgentStatusSubscriber] Stopped');
  }

  /**
   * 设置主 Agent（编排者）
   */
  setPrimaryAgent(agentId: string): void {
    this.primaryAgentId = agentId;

    // 更新订阅配置：主 Agent 为详细订阅
    this.agentSubscriptions.set(agentId, {
      agentId,
      level: 'detailed',
    });

    log.info(`[AgentStatusSubscriber] Set primary agent: ${agentId}`);
  }

  /**
   * 注册子 Agent（被派发的任务）
   */
  registerChildAgent(childAgentId: string, parentAgentId: string): void {
    this.agentSubscriptions.set(childAgentId, {
      agentId: childAgentId,
      level: 'summary', // 子 Agent 使用粗糙订阅
      parentAgentId,
    });

    log.info(`[AgentStatusSubscriber] Registered child agent: ${childAgentId} (parent: ${parentAgentId})`);
  }

  /**
   * 注销 Agent
   */

  /**
   * 注册子会话的 envelope 映射
   * 当 dispatch 创建子 agent 时，将子 agent 的 sessionId 映射到父会话的 channel envelope
   * 这样子 agent 的 tool_call/tool_result 等事件可以直接找到 envelope 进行推送
   */
  registerChildSession(childSessionId: string, envelope: SessionEnvelopeMapping['envelope']): void {
    if (this.sessionEnvelopeMap.has(childSessionId)) {
      log.debug(`[AgentStatusSubscriber] Child session ${childSessionId} already registered`);
      return;
    }
    this.sessionEnvelopeMap.set(childSessionId, {
      sessionId: childSessionId,
      envelope,
      timestamp: Date.now(),
    });
    log.info(`[AgentStatusSubscriber] Registered child session envelope: ${childSessionId} -> ${envelope.channel}`);
  }

  unregisterAgent(agentId: string): void {
    this.agentSubscriptions.delete(agentId);

    if (this.primaryAgentId === agentId) {
      this.primaryAgentId = null;
    }
  }

  /**
   * 注册 sessionId 与 envelope 的映射
   */
  registerSession(sessionId: string, envelope: SessionEnvelopeMapping['envelope']): void {
    log.info(`[AgentStatusSubscriber] Registering session ${sessionId}`);
    const existing = this.sessionEnvelopeMap.get(sessionId);
    if (!existing) {
      this.sessionEnvelopeMap.set(sessionId, {
        sessionId,
        envelope,
        timestamp: Date.now(),
      });
      return;
    }

    existing.timestamp = Date.now();
    if (this.sameEnvelope(existing.envelope, envelope)) {
      return;
    }
    if (this.sameDeliveryRoute(existing.envelope, envelope)) {
      existing.envelope = envelope;
      return;
    }

    const observers = this.sessionObserverMap.get(sessionId) ?? [];
    const sameRouteIndex = observers.findIndex((item) => this.sameDeliveryRoute(item, envelope));
    if (sameRouteIndex >= 0) {
      observers[sameRouteIndex] = envelope;
      this.sessionObserverMap.set(sessionId, observers);
      return;
    }
    if (!observers.some((item) => this.sameEnvelope(item, envelope))) {
      observers.push(envelope);
      this.sessionObserverMap.set(sessionId, observers);
      log.info(`[AgentStatusSubscriber] Registered additional session observer: ${sessionId} -> ${envelope.channel}`);
    }
  }

  /**
   * 注销 sessionId
   */
  unregisterSession(sessionId: string): void {
    this.sessionEnvelopeMap.delete(sessionId);
    this.sessionObserverMap.delete(sessionId);
    this.cleanupRouteStateBySession(sessionId);
  }

  clearSessionObservers(sessionId: string): void {
    this.sessionEnvelopeMap.delete(sessionId);
    this.sessionObserverMap.delete(sessionId);
    this.lastProgressMailboxSummaryBySession.delete(sessionId);
    this.cleanupRouteStateBySession(sessionId);
  }

  /**
   * 解析 sessionId 对应的 envelope 映射（支持 runtime 子会话回退到 root/parent）
   */
  private resolveEnvelopeMapping(sessionId: string): SessionEnvelopeMapping | null {
    const direct = this.sessionEnvelopeMap.get(sessionId);
    if (direct) return direct;

    // fallback: default/system session -> real system session mapping
    if (sessionId === 'default' || sessionId === 'system-default-session') {
      const currentSession = this.deps.sessionManager.getCurrentSession?.();
      if (currentSession?.id) {
        const currentMapping = this.sessionEnvelopeMap.get(currentSession.id);
        if (currentMapping) {
          return {
            sessionId,
            envelope: currentMapping.envelope,
            timestamp: Date.now(),
          };
        }
      }

      const getSystemSession = (this.deps.sessionManager as any).getOrCreateSystemSession;
      if (typeof getSystemSession === 'function') {
        const systemSession = getSystemSession.call(this.deps.sessionManager);
        const systemMapping = systemSession ? this.sessionEnvelopeMap.get(systemSession.id) : null;
        if (systemMapping) {
          return {
            sessionId,
            envelope: systemMapping.envelope,
            timestamp: Date.now(),
          };
        }
      }
    }

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) return null;

    // daemon 重启后，内存映射会丢失；从 session.context 恢复通道路由信息
    // 可让 mailbox/heartbeat 等后台触发任务继续向原 channel 推送进度。
    const sessionContext = (session.context && typeof session.context === 'object')
      ? (session.context as Record<string, unknown>)
      : {};
    const contextChannelId = typeof sessionContext.channelId === 'string'
      ? sessionContext.channelId.trim()
      : '';
    const contextUserId = typeof sessionContext.channelUserId === 'string'
      ? sessionContext.channelUserId.trim()
      : '';
    const contextGroupId = typeof sessionContext.channelGroupId === 'string'
      ? sessionContext.channelGroupId.trim()
      : undefined;
    const contextMessageId = typeof sessionContext.lastChannelMessageId === 'string'
      ? sessionContext.lastChannelMessageId.trim()
      : '';

    if (contextChannelId && contextUserId) {
      const recovered: SessionEnvelopeMapping = {
        sessionId,
        envelope: {
          channel: contextChannelId,
          envelopeId: contextMessageId,
          userId: contextUserId,
          ...(contextGroupId ? { groupId: contextGroupId } : {}),
        },
        timestamp: Date.now(),
      };
      this.sessionEnvelopeMap.set(sessionId, recovered);
      log.info('[AgentStatusSubscriber] Recovered session envelope from session.context', {
        sessionId,
        channel: contextChannelId,
        hasMessageId: contextMessageId.length > 0,
      });
      return recovered;
    }

    const context = sessionContext;
    const parentSessionId = typeof context.parentSessionId === 'string' ? context.parentSessionId : '';
    const rootSessionId = typeof context.rootSessionId === 'string' ? context.rootSessionId : '';
    const fallbackId = rootSessionId || parentSessionId;
    if (!fallbackId) return null;

    const fallback = this.sessionEnvelopeMap.get(fallbackId);
    if (!fallback) return null;

    // 缓存 runtime session 的映射，避免重复回退
    const mapped: SessionEnvelopeMapping = {
      sessionId,
      envelope: fallback.envelope,
      timestamp: Date.now(),
    };
    this.sessionEnvelopeMap.set(sessionId, mapped);
    return mapped;
  }

  private resolveEnvelopeMappings(sessionId: string): SessionEnvelopeMapping[] {
    const primary = this.resolveEnvelopeMapping(sessionId);
    if (!primary) return [];

    const observers = this.sessionObserverMap.get(sessionId) ?? [];
    if (observers.length === 0) return [primary];

    const mappings: SessionEnvelopeMapping[] = [primary];
    for (const envelope of observers) {
      mappings.push({
        sessionId,
        envelope,
        timestamp: primary.timestamp,
      });
    }
    return mappings;
  }

  private sameEnvelope(
    left: SessionEnvelopeMapping['envelope'],
    right: SessionEnvelopeMapping['envelope'],
  ): boolean {
    return left.channel === right.channel
      && left.envelopeId === right.envelopeId
      && left.userId === right.userId
      && left.groupId === right.groupId;
  }

  private sameDeliveryRoute(
    left: SessionEnvelopeMapping['envelope'],
    right: SessionEnvelopeMapping['envelope'],
  ): boolean {
    return left.channel === right.channel
      && left.userId === right.userId
      && left.groupId === right.groupId;
  }

  async finalizeChannelTurn(sessionId: string, finalReply?: string, agentId?: string, finishReason?: string): Promise<void> {
    const primary = this.resolveEnvelopeMapping(sessionId);
    if (!primary) return;

    const observers = this.sessionObserverMap.get(sessionId) ?? [];
    const allEnvelopes = [primary.envelope, ...observers];
    const dedupedEnvelopes = new Map<string, SessionEnvelopeMapping['envelope']>();
    for (const envelope of allEnvelopes) {
      const key = `${envelope.channel}::${envelope.groupId ?? ''}::${envelope.userId ?? ''}`;
      dedupedEnvelopes.set(key, envelope);
    }

    const deliverText = async (envelopes: SessionEnvelopeMapping['envelope'][], content: string): Promise<void> => {
      if (!this.messageHub || !content.trim()) return;
      for (const envelope of envelopes) {
        const outputId = 'channel-bridge-' + envelope.channel;
        const originalEnvelope: ChannelBridgeEnvelope = {
          id: envelope.envelopeId,
          channelId: envelope.channel,
          accountId: 'default',
          type: envelope.groupId ? 'group' : 'direct',
          senderId: envelope.userId || 'unknown',
          senderName: 'user',
          content: '',
          timestamp: Date.now(),
          metadata: {
            messageId: envelope.envelopeId,
            ...(envelope.groupId ? { groupId: envelope.groupId } : {}),
          },
        };
        await this.messageHub.routeToOutput(outputId, {
          channelId: envelope.channel,
          target: envelope.groupId ? `group:${envelope.groupId}` : (envelope.userId || 'unknown'),
          content,
          originalEnvelope,
        });
      }
    };

    if (finalReply && finalReply.trim().length > 0 && observers.length > 0 && this.messageHub) {
      const timestamp = new Date();
      const year = timestamp.getFullYear();
      const month = String(timestamp.getMonth() + 1).padStart(2, '0');
      const day = String(timestamp.getDate()).padStart(2, '0');
      const hours = String(timestamp.getHours()).padStart(2, '0');
      const minutes = String(timestamp.getMinutes()).padStart(2, '0');
      const seconds = String(timestamp.getSeconds()).padStart(2, '0');
      const ms = String(timestamp.getMilliseconds()).padStart(3, '0');
      const offset = -timestamp.getTimezoneOffset();
      const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
      const offsetMinutes = String(Math.abs(offset) % 60).padStart(2, '0');
      const offsetSign = offset >= 0 ? '+' : '-';
      const formattedTimestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms} ${offsetSign}${offsetHours}:${offsetMinutes}`;
      const agentName = agentId?.replace(/^finger-/, '').replace(/-/g, ' ') || 'system agent';
      const content = `[${agentName}] [${formattedTimestamp}] ${finalReply.trim()}`;
      await deliverText(observers, content);
    }

    if (finishReason === 'stop') {
      const noticeTargets = Array.from(dedupedEnvelopes.values())
        .filter((envelope) => envelope.channel === 'qqbot' || envelope.channel === 'openclaw-weixin');
      if (noticeTargets.length > 0) {
        await deliverText(noticeTargets, '本轮推理已结束。');
      }
    }

    this.clearSessionObservers(sessionId);
  }

  /**
   * 处理事件
   */
  private async handleEvent(event: RuntimeEvent): Promise<void> {
    const ctx = this.getHandlerContext();
    if (event.type === 'agent_runtime_dispatch') {
      await handleDispatchEvent(event, ctx);
    } else if (event.type === 'agent_runtime_status') {
      await this.handleStatus(event);
    } else if (event.type === 'agent_step_completed') {
      await handleStepCompletedEvent(event, ctx);
    } else if (event.type === 'tool_call') {
      await handleToolCallEvent(event, ctx);
    } else if (event.type === 'tool_result') {
      await handleToolResultEvent(event, ctx);
    } else if (event.type === 'tool_error') {
      await handleToolErrorEvent(event as ToolErrorEvent, ctx);
    } else if (event.type === 'system_error') {
      await handleSystemErrorEvent(event as SystemErrorEvent, ctx);
    } else if (event.type === 'waiting_for_user') {
      await handleWaitingForUserEvent(event, ctx);
    }
  }

  private async flushStepBuffer(sessionId: string, mapping: SessionEnvelopeMapping): Promise<void> {
    await flushStepBufferEvent(sessionId, mapping, this.getHandlerContext());
  }

  /**
   * 处理 status 事件
   */
  private async handleStatus(event: RuntimeEvent): Promise<void> {
    const payload = event.payload as {
      scope: string;
      status: string;
      agentId?: string;
      summary?: string;
    };

    const agentId = payload.agentId || (event as any).agentId;
    if (!agentId) {
      log.warn('[AgentStatusSubscriber] No agentId in event');
      return;
    }

    // 获取订阅配置
    const config = this.agentSubscriptions.get(agentId);
    const level = config?.level || 'summary'; // 默认粗糙订阅

    // 如果是粗糙订阅，只处理关键状态变化
    if (level === 'summary' && !KEY_STATE_CHANGES.includes(payload.status)) {
      log.debug(`[AgentStatusSubscriber] Skipping non-key status for ${agentId}: ${payload.status}`);
      return;
    }

    // 获取 Agent 信息
    const agentInfo = await this.getAgentInfo(agentId);

    // 构建任务上下文
    const taskContext: TaskContext = {
      taskId: (event as any).dispatchId,
      targetAgentId: agentId,
      sourceAgentId: config?.parentAgentId || (event as any).sourceAgentId,
      taskDescription: payload.summary,
    };

    // 包装状态更新
    const wrappedUpdate = wrapStatusUpdate(event, payload, agentInfo, taskContext, level);

    // 查找对应的 session
    const sessionId = event.sessionId;
    const mappings = this.resolveEnvelopeMappings(sessionId)
      .filter((mapping) => this.resolvePushSettings(sessionId, mapping.envelope.channel).statusUpdate);

    if (mappings.length === 0) {
      log.debug(`[AgentStatusSubscriber] No envelope mapping for session ${sessionId}`);
      return;
    }

    for (const mapping of mappings) {
      mapping.timestamp = Date.now();
    }

    // 发送状态更新到通信通道 (QQBot)
    if (this.messageHub) { await sendStatusUpdate(mappings.map((item) => item.envelope), wrappedUpdate, this.messageHub, this.channelBridgeManager); };

    // 同时广播到 WebUI
    if (this.broadcast) {
      this.broadcast({
        type: 'agent_status',
        sessionId,
        agentId,
        timestamp: event.timestamp,
        payload: {
          status: payload.status,
          summary: payload.summary,
          agentName: agentInfo.agentName,
          agentRole: agentInfo.agentRole,
        },
      });
    }

    // 终态时先刷新剩余 steps buffer
    if (payload.status === 'completed' || payload.status === 'failed') {
      const remainingBuffer = this.stepBuffer.get(sessionId);
      if (remainingBuffer && remainingBuffer.length > 0) {
        await this.flushStepBuffer(sessionId, mappings[0]);
      }

      const session = this.deps.sessionManager.getSession(sessionId);
      const context = (session?.context && typeof session.context === 'object')
        ? (session.context as Record<string, unknown>)
        : {};
      const cleanupContext: Record<string, unknown> = {};
      if (context.progressDeliveryTransient === true) {
        cleanupContext.progressDelivery = null;
        cleanupContext.progressDeliveryTransient = false;
        cleanupContext.progressDeliveryUpdatedAt = null;
      }
      if (context.scheduledProgressDeliveryTransient === true) {
        cleanupContext.scheduledProgressDelivery = null;
        cleanupContext.scheduledProgressDeliveryTransient = false;
      }
      if (Object.keys(cleanupContext).length > 0) {
        this.deps.sessionManager.updateContext(sessionId, cleanupContext);
      }
    }

    // NOTE:
    // 不要在终态自动注销 session -> envelope 映射。
    // 原因：子 agent 派发链路里，completed/failed 状态之后仍可能继续产出
    // reasoning/body/progress 增量（同 session 或 runtime child session 回退）。
    // 若这里提前 unregister，会导致后续正文/思考/进度全部丢失。
    //
    // 映射回收交给:
    // 1) 定时清理（24h）
    // 2) 显式会话生命周期结束流程（如未来补充）
  }

  /**
   * 推送进度报告到通道（由 ProgressMonitor 调用）
   */
  async sendProgressUpdate(report: {
    sessionId: string;
    agentId: string;
    summary: string;
    progress: {
      status: string;
      toolCallsCount: number;
      modelRoundsCount: number;
      elapsedMs: number;
      contextUsagePercent?: number;
      estimatedTokensInContextWindow?: number;
      maxInputTokens?: number;
    };
  }): Promise<void> {
    const mappings = this.resolveEnvelopeMappings(report.sessionId);
    if (mappings.length === 0) return;
    if (!this.messageHub) return;

    const progressMappings = mappings.filter((mapping) => {
      const pushSettings = this.resolvePushSettings(report.sessionId, mapping.envelope.channel);
      return pushSettings.statusUpdate && pushSettings.updateMode !== 'command' && pushSettings.progressUpdates;
    });
    if (progressMappings.length === 0) return;

    const mailboxTargetAgent = typeof report.agentId === 'string' && report.agentId.trim().length > 0 && report.agentId !== 'unknown'
      ? report.agentId
      : (this.primaryAgentId || 'finger-system-agent');
    const mailboxSnapshot = buildMailboxProgressSnapshot(mailboxTargetAgent, this.primaryAgentId || 'finger-system-agent');
    const mailboxHasSignal = !!mailboxSnapshot
      && (mailboxSnapshot.counts.unread > 0 || mailboxSnapshot.counts.pending > 0 || mailboxSnapshot.counts.processing > 0);
    const mailboxSummaryText = mailboxHasSignal ? mailboxSnapshot?.summaryText : undefined;
    const lastMailboxSummary = this.lastProgressMailboxSummaryBySession.get(report.sessionId);
    const includeMailboxSummary = typeof mailboxSummaryText === 'string'
      && mailboxSummaryText.length > 0
      && mailboxSummaryText !== lastMailboxSummary;
    if (includeMailboxSummary && mailboxSummaryText) {
      this.lastProgressMailboxSummaryBySession.set(report.sessionId, mailboxSummaryText);
    }
    const mailboxSummary = includeMailboxSummary && mailboxSummaryText
      ? `📬 ${mailboxSummaryText}`
      : undefined;
    const contextSnapshot = normalizeContextUsageSnapshot({
      contextUsagePercent: report.progress.contextUsagePercent,
      estimatedTokensInContextWindow: report.progress.estimatedTokensInContextWindow,
      maxInputTokens: report.progress.maxInputTokens,
    });
    const contextSummary = buildContextUsageLine(contextSnapshot);
    const normalizedReportSummary = report.summary ?? '';
    const appendContextSummary = contextSummary && !normalizedReportSummary.includes(contextSummary)
      ? contextSummary
      : undefined;
    const summary = [report.summary, appendContextSummary, mailboxSummary]
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .join('\n');
    if (!summary) return;

    const wrappedUpdate: WrappedStatusUpdate = {
      type: 'agent_status',
      eventId: `progress-${Date.now()}`,
      timestamp: new Date().toISOString(),
      sessionId: report.sessionId,
      agent: { agentId: report.agentId },
      task: { taskDescription: report.summary },
      status: {
        state: report.progress.status === 'completed' ? 'completed'
          : report.progress.status === 'failed' ? 'failed'
          : 'running',
        summary,
        details: {
          toolCalls: report.progress.toolCallsCount,
          modelRounds: report.progress.modelRoundsCount,
          elapsedMs: report.progress.elapsedMs,
          ...(typeof report.progress.contextUsagePercent === 'number'
            ? { contextUsagePercent: report.progress.contextUsagePercent }
            : {}),
          ...(typeof report.progress.estimatedTokensInContextWindow === 'number'
            ? { estimatedTokensInContextWindow: report.progress.estimatedTokensInContextWindow }
            : {}),
          maxInputTokens: contextSnapshot.maxInputTokens,
          ...(mailboxHasSignal && mailboxSnapshot
            ? {
                mailboxStatus: {
                  target: mailboxSnapshot.target,
                  counts: mailboxSnapshot.counts,
                  recentUnread: mailboxSnapshot.recentUnread,
                },
              }
            : {}),
        },
      },
      display: {
        title: '📊 进度更新',
        // avoid duplication: summary is already rendered as status.summary
        subtitle: undefined,
        icon: '🔄',
        level: 'detailed',
      },
    };

    await sendStatusUpdate(progressMappings.map((item) => item.envelope), wrappedUpdate, this.messageHub, this.channelBridgeManager);
  }

  /**
   * 获取 Agent 信息
   */
  private async getAgentInfo(agentId: string): Promise<AgentInfo> {
    try {
      const catalog = await this.deps.agentRuntimeBlock.execute('catalog', { layer: 'summary' });
      const agents = Array.isArray((catalog as any).agents) ? (catalog as any).agents : [];
      const agent = agents.find((a: any) => a.id === agentId);

      if (agent) {
        return { agentId: agent.id, agentName: agent.name, agentRole: agent.type };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.warn(`[AgentStatusSubscriber] Failed to get agent info for :`, { error: errorMessage });
    }

    return { agentId };
  }

}
export default AgentStatusSubscriber;
