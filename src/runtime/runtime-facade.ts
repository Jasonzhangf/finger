/**
 * RuntimeFacade - 统一运行时门面
 * 提供给基础子 Agent 使用的统一接口
 */

import type { WebSocket } from 'ws';
import { readProjectState, getDefaultEnabledAgents } from "./project-state.js";
import path from 'path';
import { FINGER_PATHS, ensureDir } from '../core/finger-paths.js';
import { UnifiedEventBus } from './event-bus.js';
import { ToolRegistry } from './tool-registry.js';
import type { RuntimeEvent } from './events.js';
import type { Attachment } from '../bridges/types.js';
import { AgentToolAccessControl, type AgentToolPolicy } from './agent-tool-access.js';
import { applyRoleToolPolicy, type RoleToolPolicyPresetMap } from './agent-tool-role-policy.js';
import {
  ToolAuthorizationManager,
  type AuthorizationIssueOptions,
  type ToolAuthorizationGrant,
} from './tool-authorization.js';
import { executeContextLedgerMemory } from './context-ledger-memory.js';
import {
  TopicShiftDetector,
  decideContextRebuild,
  extractTopicShiftControl,
  isHeartbeatSession,
  isCronTask,
} from './topic-shift-detector.js';
import { executeContextRebuild, extractPromptFromPayload, estimateMessageTokens, compressCurrentHistory } from './context-rebuild-executor.js';
import { createRustKernelCompactionError } from './kernel-owned-compaction.js';
import { SessionControlPlaneStore } from './session-control-plane.js';
import { SYSTEM_PROJECT_PATH } from '../agents/finger-system-agent/index.js';
import {
  buildToolResolutionCandidates,
  normalizeToolAliasLookupKey,
} from './tool-compat-aliases.js';

import { logger } from '../core/logger.js';
import type { Session, SessionMessage, ISessionManager } from '../orchestration/session-types.js';

// 进度报告
export interface ProgressReport {
  overall: number;
  activeAgents: string[];
  pending: number;
  completed: number;
  failed: number;
}

// ─── Session alias for backward compatibility ─────────────────────────────
/** @deprecated Use Session from session-types.ts directly */
export type SessionInfo = Session;

// ─── Extended ISessionManager for runtime-specific needs ─────────────────────────────
export interface IRuntimeSessionManager extends ISessionManager {
  // Inherited from ISessionManager, no additional methods needed
  // This is just a type alias to make the intent clearer
}

// ─── Legacy ISessionManager interface (deprecated) ─────────────────────────────
/** @deprecated Use ISessionManager from session-types.ts */
export interface ISessionManagerLegacy {
  createSession(projectPath: string, name?: string): Session | Promise<Session>;
  getSession(sessionId: string): Session | undefined;
  getCurrentSession(): Session | null;
  setCurrentSession(sessionId: string): boolean;
  listSessions(): Session[];
  addMessage(sessionId: string, role: string, content: string, metadata?: { attachments?: Attachment[] }): Promise<{ id: string; timestamp: string } | null>;
  getMessages(
    sessionId: string,
    limit?: number,
  ): Array<{
    id: string;
    role: string;
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
    attachments?: Attachment[];
  }>;
  deleteSession(sessionId: string): boolean;
  pauseSession?(sessionId: string): boolean;
  resumeSession?(sessionId: string): boolean;
  updateContext?(sessionId: string, context: Record<string, unknown>): boolean;
  compressContext?(sessionId: string, options?: { summarizer?: unknown; force?: boolean }): Promise<string>;
  getCompressionStatus?(sessionId: string): { compressed: boolean; summary?: string; originalCount?: number };
  isPaused?(sessionId: string): boolean;
  /** Append turn digest with tags when finish_reason=stop */
  appendDigest?(sessionId: string, message: {
    id: string;
    role: string;
    content: string;
    timestamp: string;
  }, tags: string[], agentId?: string, mode?: string): Promise<void>;
  syncProjectionFromLedger?(sessionId: string, options?: {
    agentId?: string;
    mode?: string;
    source?: string;
  }): Promise<{
    applied: boolean;
    reason: string;
    messageCount?: number;
    latestCompactIndex?: number;
    totalTokens?: number;
  }>;
}

export interface AgentProviderRuntimeConfig {
  type: string;
  model?: string;
  options?: Record<string, unknown>;
}

export interface AgentSessionRuntimeConfig {
  bindingScope?: 'finger' | 'finger+agent';
  resume?: boolean;
  provider?: string;
  agentId?: string;
  mapPath?: string;
}

export interface AgentIflowGovernanceRuntimeConfig {
  allowedTools?: string[];
  disallowedTools?: string[];
  approvalMode?: 'default' | 'autoEdit' | 'yolo' | 'plan';
  injectCapabilities?: boolean;
  capabilityIds?: string[];
  commandNamespace?: string;
}

export interface AgentGovernanceRuntimeConfig {
  iflow?: AgentIflowGovernanceRuntimeConfig;
}

export interface AgentRuntimeConfig {
  id: string;
  name?: string;
  role?: string;
  provider?: AgentProviderRuntimeConfig;
  session?: AgentSessionRuntimeConfig;
  governance?: AgentGovernanceRuntimeConfig;
  prompts?: {
    system?: string;
    developer?: string;
  };
  model?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const log = logger.module('RuntimeFacade');
const autoDigestStopStateBySession = new Map<string, { lastAttemptAt: number; lastTurnId?: string }>();
const autoDigestStopInFlightBySession = new Map<string, Promise<boolean>>();

export class RuntimeFacade {
  // Topic shift detector per session
  private readonly topicShiftDetectors = new Map<string, TopicShiftDetector>();
  // Last response metadata per session (for topic shift detection)
  private readonly lastResponseMetadata = new Map<string, Record<string, unknown>>();
  private currentSessionId: string | null = null;
  private readonly agentSessionBindings = new Map<string, string>();
  private readonly sessionControlPlaneStore = new SessionControlPlaneStore();
  private readonly toolAccessControl = new AgentToolAccessControl();
  private readonly toolAuthorization = new ToolAuthorizationManager();
  private roleToolPolicyPresets: RoleToolPolicyPresetMap = {};
  private readonly agentRuntimeConfigs = new Map<string, AgentRuntimeConfig>();

  constructor(
    private eventBus: UnifiedEventBus,
    private sessionManager: ISessionManager,
    private toolRegistry: ToolRegistry,
  private wsClients?: Set<WebSocket>,
  ) {
    // 如果提供了 wsClients，注册到 eventBus
    if (wsClients) {
      // eventBus 将在发送时直接检查 wsClients
    }
  }

  private isEphemeralDispatchSessionId(sessionId: string): boolean {
    // Only treat runtime-generated transient dispatch ids as ephemeral:
    // dispatch-<timestamp-or-number>-...
    // Keep deterministic project-scoped session ids (e.g. dispatch-finger-project-agent-*)
    // bindable so worker/session routing can persist correctly.
    return /^dispatch-\d/i.test(sessionId.trim());
  }

  private isSystemAgent(agentId: string): boolean {
    return agentId.trim() === 'finger-system-agent';
  }

  private isSessionAllowedForAgent(agentId: string, session: SessionInfo): boolean {
    const normalizedAgentId = agentId.trim();
    const context = (session.context && typeof session.context === 'object')
      ? (session.context as Record<string, unknown>)
      : {};
    const ownerAgentId = typeof context.ownerAgentId === 'string' ? context.ownerAgentId.trim() : '';
    const memoryOwnerWorkerId = typeof context.memoryOwnerWorkerId === 'string'
      ? context.memoryOwnerWorkerId.trim()
      : '';
    const sessionTier = typeof context.sessionTier === 'string' ? context.sessionTier.trim().toLowerCase() : '';
    const isSystemSession = session.projectPath === SYSTEM_PROJECT_PATH
      || sessionTier === 'system'
      || ownerAgentId === 'finger-system-agent'
      || memoryOwnerWorkerId === 'finger-system-agent'
      || session.id.startsWith('system-');

    if (memoryOwnerWorkerId && memoryOwnerWorkerId !== normalizedAgentId) {
      return false;
    }
    if (ownerAgentId && ownerAgentId !== normalizedAgentId) {
      return false;
    }
    if (this.isSystemAgent(normalizedAgentId)) {
      return isSystemSession;
    }
    return !isSystemSession;
  }

  private isBindableSessionId(agentId: string, sessionId: string): boolean {
    const normalized = sessionId.trim();
    if (normalized.length === 0) return false;
    if (normalized === 'default') return false;
    if (this.isEphemeralDispatchSessionId(normalized)) return false;
    const session = this.sessionManager.getSession(normalized);
    if (!session) return false;
    return this.isSessionAllowedForAgent(agentId, session);
  }

  /**
   * Sanitize tool error messages to prevent LLM from hallucinating tool calls.
   * Replaces provider error messages like "Tool xxx does not exist" with
   * actionable guidance to avoid retry loops.
   */
  private sanitizeToolError(toolName: string, rawError: string): string {
    // Detect provider-side "tool does not exist" errors
    if (/Tool\s+[a-zA-Z0-9_.-]+\s+does(?:\s+not)?\s+exist/i.test(rawError)) {
      return `工具 '${toolName}' 不在当前可用工具列表中。请使用 agent.capabilities 查看当前可用工具。`;
    }
    return rawError;
  }

  private sanitizeToolSessionCandidate(
    agentId: string,
    candidate: string | null | undefined,
    source: string,
    options?: { suppressWarn?: boolean },
  ): string | null {
    if (!candidate) return null;
    const normalized = candidate.trim();
    if (!normalized) return null;
    if (this.isBindableSessionId(agentId, normalized)) return normalized;
    if (!options?.suppressWarn) {
      log.warn('Ignored invalid tool session candidate', {
        agentId,
        source,
        sessionId: normalized,
        reason: this.isEphemeralDispatchSessionId(normalized)
          ? 'ephemeral_dispatch_id_forbidden'
          : 'session_not_found_or_agent_scope_forbidden',
      });
    }
    return null;
  }

  private resolvePersistedAgentSessionBinding(agentId: string): string | null {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) return null;
    try {
      const records = this.sessionControlPlaneStore.list({ agentId: normalizedAgentId, provider: 'finger' });
      for (const record of records) {
        const candidate = this.sanitizeToolSessionCandidate(
          normalizedAgentId,
          record.fingerSessionId,
          'callTool.persistedAgentBinding',
          { suppressWarn: true },
        );
        if (candidate) return candidate;
      }
    } catch (error) {
      log.warn('Failed to resolve persisted agent-session binding', {
        agentId: normalizedAgentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  // ==================== Session 管理 ====================

  /**
   * 创建会话
   */
  async createSession(projectPath: string, name?: string): Promise<SessionInfo> {
    const result = this.sessionManager.createSession(projectPath, name);
    const session = result instanceof Promise ? await result : result;
    this.currentSessionId = session.id;
    this.eventBus.enablePersistence(session.id, ensureDir(FINGER_PATHS.runtime.eventsDir));

    await this.eventBus.emit({
      type: 'session_created',
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      payload: {
        name: session.name,
        projectPath: session.projectPath,
        messageCount: 0,
      },
    });

    const projectState = readProjectState(projectPath);
    const enabledAgents = projectState?.enabledAgents ?? getDefaultEnabledAgents();
    void enabledAgents;
    // TODO: Auto-start orchestrator and other enabled agents based on project state.

    return session;
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessionManager.getSession(sessionId);
  }

  /**
   * 获取当前会话
   */
  getCurrentSession(): SessionInfo | null {
    return this.sessionManager.getCurrentSession();
  }

  /**
   * 设置当前会话
   */
  setCurrentSession(sessionId: string): boolean {
    if (this.isEphemeralDispatchSessionId(sessionId)) {
      log.warn('Rejected runtime current-session switch to ephemeral dispatch id', { sessionId });
      return false;
    }
    if (!this.sessionManager.getSession(sessionId)) {
      log.warn('Rejected runtime current-session switch to non-existent session', { sessionId });
      return false;
    }
    const result = this.sessionManager.setCurrentSession(sessionId);
    if (result) {
      this.currentSessionId = sessionId;
      this.eventBus.enablePersistence(sessionId, ensureDir(FINGER_PATHS.runtime.eventsDir));
    }
    return result;
  }

  /**
   * 列出所有会话
   */
  listSessions(): SessionInfo[] {
    return this.sessionManager.listSessions();
  }

  /**
   * Merge partial context fields into a session context and persist.
   */
  updateSessionContext(sessionId: string, context: Record<string, unknown>): boolean {
    if (typeof this.sessionManager.updateContext !== 'function') return false;
    return this.sessionManager.updateContext(sessionId, context);
  }

  /**
   * 获取会话消息（Ledger 动态视图）
   */
  getMessages(
    sessionId: string,
    limit?: number,
  ): Array<{
    id: string;
    role: string;
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
    attachments?: Attachment[];
  }> {
    return this.sessionManager.getMessages(sessionId, limit);
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): boolean {
    const result = this.sessionManager.deleteSession(sessionId);
    if (result) {
      // C1: 清理 TopicShiftDetector 和 lastResponseMetadata 避免内存泄漏
      this.topicShiftDetectors.delete(sessionId);
      this.lastResponseMetadata.delete(sessionId);
    }
    if (result && this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
    return result;
  }

  // ==================== 消息管理 ====================

  /**
   * 发送用户消息
   */
  async sendMessage(
    sessionId: string,
    content: string,
    attachments?: Attachment[],
  ): Promise<{ messageId: string }> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const message = await this.sessionManager.addMessage(sessionId, 'user', content, { attachments });
    if (!message) {
      throw new Error(`Failed to append message to session ${sessionId}`);
    }

    await this.eventBus.emit({
      type: 'user_message',
      sessionId,
      timestamp: message.timestamp,
      payload: {
        messageId: message.id,
        content,
        attachments,
      },
    });

    return { messageId: message.id };
  }

  /**
   * 添加助手消息块 (流式)
   */
  emitAssistantChunk(sessionId: string, agentId: string, messageId: string, content: string): void {
    void this.eventBus.emit({
      type: 'assistant_chunk',
      sessionId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: {
        messageId,
        content,
      },
    });
  }

  /**
   * 添加助手消息完成
   */
  emitAssistantComplete(sessionId: string, agentId: string, messageId: string, content: string, stopReason?: string): void {
    const session = this.sessionManager.getSession(sessionId);
    const context = session?.context as Record<string, unknown> | undefined;
    if (context && context.sessionTier === 'runtime') {
      void this.sessionManager.addMessage(sessionId, 'assistant', content);
    }
    void this.eventBus.emit({
      type: 'assistant_complete',
      sessionId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: {
        messageId,
        content,
        stopReason,
      },
    });
  }

  // ==================== 工具调用 ====================

  private resolveToolAliasForAgent(agentId: string, requestedToolName: string): string {
    const requested = requestedToolName.trim();
    if (requested.length === 0) return requested;

    // Fast path: exact tool already granted.
    if (this.toolAccessControl.canUse(agentId, requested).allowed) {
      return requested;
    }

    // Compatibility aliasing for unstable model tool names.
    // Keep this deterministic and fail-closed: only remap when alias target
    // is both granted for this agent and currently available in tool registry.
    const aliasCandidates = buildToolResolutionCandidates(requested)
      .map((item) => item.trim())
      .filter((item, index, list) => item.length > 0 && item !== requested && list.indexOf(item) === index);
    if (aliasCandidates.length > 0) {
      for (const candidate of aliasCandidates) {
        if (!this.toolAccessControl.canUse(agentId, candidate).allowed) continue;
        if (!this.toolRegistry.isAvailable(candidate)) continue;
        log.warn('Normalized tool alias for agent', {
          agentId,
          requestedToolName: requested,
          resolvedToolName: candidate,
        });
        return candidate;
      }
    }

    const fuzzyMatched = this.resolveToolByFuzzyAlias(agentId, requested);
    if (fuzzyMatched) {
      log.warn('Normalized tool alias for agent via fuzzy matching', {
        agentId,
        requestedToolName: requested,
        resolvedToolName: fuzzyMatched,
      });
      return fuzzyMatched;
    }

    return requested;
  }

  private resolveToolByFuzzyAlias(agentId: string, requestedToolName: string): string | null {
    const requested = requestedToolName.trim();
    if (!requested) return null;
    const requestedKey = normalizeToolAliasLookupKey(requested);
    if (!requestedKey) return null;

    const policy = this.toolAccessControl.getPolicy(agentId);
    const whitelist = Array.isArray(policy.whitelist) ? policy.whitelist : [];
    if (whitelist.length === 0) return null;

    const candidates = whitelist
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .filter((name) => this.toolRegistry.isAvailable(name))
      .filter((name, index, list) => list.indexOf(name) === index);
    if (candidates.length === 0) return null;

    const matched = candidates.filter((candidate) => normalizeToolAliasLookupKey(candidate) === requestedKey);
    if (matched.length === 0) return null;
    if (matched.length === 1) return matched[0] ?? null;

    const requestedSeparators = collectToolNameSeparators(requested);
    const ranked = [...matched].sort((left, right) => {
      const leftScore = computeSeparatorScore(left, requestedSeparators);
      const rightScore = computeSeparatorScore(right, requestedSeparators);
      if (leftScore !== rightScore) return rightScore - leftScore;
      return left.localeCompare(right);
    });
    return ranked[0] ?? null;
  }

  /**
   * 调用工具
   */
  async callTool(
    agentId: string,
    toolName: string,
    input: unknown,
    options: { authorizationToken?: string; sessionId?: string; traceId?: string } = {},
  ): Promise<unknown> {
    const startTime = Date.now();
    const inputObj = input as Record<string, unknown> | undefined;
    const inputMetadata = inputObj && typeof inputObj === 'object' && 'metadata' in inputObj
      ? (inputObj.metadata as Record<string, unknown> | undefined)
      : undefined;
    const traceId = options.traceId ?? (
      inputMetadata && typeof inputMetadata === 'object' && 'traceId' in inputMetadata
        ? String(inputMetadata.traceId)
        : undefined
    );
    const requestedToolName = toolName.trim();
    const resolvedToolName = this.resolveToolAliasForAgent(agentId, requestedToolName);
    const toolId = `${agentId}-${resolvedToolName}-${startTime}`;
    const optionSessionId = this.sanitizeToolSessionCandidate(
      agentId,
      typeof options.sessionId === 'string' ? options.sessionId : null,
      'callTool.options.sessionId',
    );
    const boundSessionId = this.sanitizeToolSessionCandidate(
      agentId,
      this.agentSessionBindings.get(agentId) ?? null,
      'callTool.boundAgentSession',
    );
    const persistedSessionId = this.resolvePersistedAgentSessionBinding(agentId);
    const sessionId = optionSessionId
      ?? boundSessionId
      ?? persistedSessionId
      ?? 'default';
    if (sessionId !== 'default') {
      this.agentSessionBindings.set(agentId, sessionId);
    }

    const access = this.toolAccessControl.canUse(agentId, resolvedToolName);
    if (!access.allowed) {
      this.eventBus.emit({
        type: 'tool_error',
        toolId,
        toolName: resolvedToolName,
        agentId,
        sessionId,
        timestamp: new Date().toISOString(),
        payload: { error: access.reason, duration: 0 },
      });
      return {
        __tool_access_denied: true,
        error: access.reason,
        toolName: resolvedToolName,
        requestedToolName,
        agentId,
        suggestion: '工具访问被拒绝。请检查权限配置或联系管理员。',
      };
    }

    // 检查策略
    const policy = this.toolRegistry.getPolicy(resolvedToolName);
    if (policy === 'deny') {
      return {
        __tool_policy_denied: true,
        error: `Tool ${resolvedToolName} is not allowed by policy`,
        toolName: resolvedToolName,
        requestedToolName,
        agentId,
        suggestion: '工具被策略禁止。请检查 channels.json 中的工具策略配置。',
      };
    }

    if (this.toolAuthorization.isToolRequired(resolvedToolName)) {
      let token = options.authorizationToken;
      if (!token || token.trim().length === 0) {
        const grant = this.toolAuthorization.issue(agentId, resolvedToolName, 'system-auto', {
          ttlMs: 60_000,
          maxUses: 1,
        });
        token = grant.token;
      }

      const auth = this.toolAuthorization.verifyAndConsume(token, agentId, resolvedToolName);
    if (!auth.allowed) {
      this.eventBus.emit({
        type: 'tool_error',
        toolId,
        toolName: resolvedToolName,
        agentId,
        sessionId,
        timestamp: new Date().toISOString(),
        payload: { error: auth.reason, duration: 0 },
      });
      return {
        __authorization_required: true,
        error: auth.reason,
        toolName: resolvedToolName,
        requestedToolName,
        agentId,
        suggestion: '需要用户授权才能执行此命令。调用 permission.check 检查权限，或让用户回复授权码 <##auth:approvalId##>',
      };
    }
    }

    // 发送 tool_call 事件
    log.info('[RuntimeFacade] Tool call start', {
      toolId,
      toolName: resolvedToolName,
      agentId,
      sessionId,
      traceId,
    });
    await this.eventBus.emit({
      type: 'tool_call',
      toolId,
      toolName: resolvedToolName,
      agentId,
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { input, ...(traceId ? { traceId } : {}) },
    });

    try {
      const executionInput = (
        resolvedToolName === 'context_builder.rebuild'
        && typeof input === 'object'
        && input !== null
        && !Array.isArray(input)
      )
        ? await(async () => {
            const payload = { ...(input as Record<string, unknown>) };
            const runtimeContextRaw = (
              typeof payload._runtime_context === 'object'
              && payload._runtime_context !== null
              && !Array.isArray(payload._runtime_context)
            )
              ? (payload._runtime_context as Record<string, unknown>)
              : {};
            
            // === Context Rebuild Decision ===
            // 核心原则：最近 3 轮永远保留在 session_messages（current），不依赖索引
            // Rebuild 只补充历史上下文（ledger 搜索），作为 supplement
            const ALWAYS_KEEP_RECENT_ROUNDS = 3;
            const rawMessages = this.sessionManager.getMessages(sessionId, ALWAYS_KEEP_RECENT_ROUNDS);
            // 压缩原始消息为轻量级 Digest（去掉大体积的 tool_output）
            const recentDigests = rawMessages.length > 0
              ? [compressCurrentHistory(rawMessages)]
              : [];
            runtimeContextRaw.session_messages = recentDigests;
            runtimeContextRaw.working_set_mode = 'recent_digest_plus_rebuild';

            const rebuildSession = this.sessionManager.getSession(sessionId);
            const rebuildMessages = this.sessionManager.getMessages(sessionId, 0);
            const currentTokens = rebuildMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
            const maxTokens = 8000;
            
            // Get last response metadata for topic shift detection
            const lastMeta = this.lastResponseMetadata.get(sessionId);
            const control = extractTopicShiftControl(lastMeta);
            
            // Get or create TopicShiftDetector for this session
            let detector = this.topicShiftDetectors.get(sessionId);
            if (!detector) {
              detector = new TopicShiftDetector();
              this.topicShiftDetectors.set(sessionId, detector);
            }
            
            // Determine source type from session context
            const rebuildSessionContext = (rebuildSession?.context && typeof rebuildSession.context === 'object')
              ? rebuildSession.context as Record<string, unknown>
              : undefined;
            const sourceType = (typeof rebuildSessionContext?.sourceType === 'string')
              ? rebuildSessionContext.sourceType
              : 'user';
            
            // Decide if context rebuild should be triggered
            const prompt = extractPromptFromPayload(payload);
            const decision = decideContextRebuild(
              sessionId,
              sourceType,
              prompt || '',
              currentTokens,
              maxTokens,
              control,
              detector,
            );
            
            // === Determine if heartbeat/cron task ===
            const isHeartbeatOrCron = isHeartbeatSession(sessionId) || sourceType === 'cron';
            
            // === 检查索引是否就绪 ===
            // 索引未完成 → 不触发 rebuild，只使用 recentDigests
            // 如果上下文超限触发 rebuild 但 index 未完成，返回特殊状态通知用户
            let indexReady = true;
            let indexWaitMs = 0;
            try {
              const fsPromises = await import('fs/promises');
              const lPath = path.join(FINGER_PATHS.sessions.dir, sessionId, agentId, 'main', 'context-ledger.jsonl');
              const ledgerStat = await fsPromises.stat(lPath).catch(() => null);
              if (ledgerStat) {
                // 如果 ledger 在最近 30 秒内被修改，认为索引可能未完成（留足时间）
                const threeSecondsAgo = Date.now() - 3000;
                if (ledgerStat.mtimeMs > threeSecondsAgo) {
                  indexReady = false;
                  indexWaitMs = Math.max(0, 3000 - (Date.now() - ledgerStat.mtimeMs));
                  log.info('[RuntimeFacade] Ledger recently modified, index may not be ready', {
                    sessionId,
                    ledgerMtime: ledgerStat.mtimeMs,
                    indexWaitMs,
                  });
                }
              }
            } catch (_e) {
              // ignore stat errors
            }
            
            // 如果上下文超限触发 rebuild 但 index 未完成，通知用户等待
            if (decision.reason === 'context_overflow' && !indexReady) {
              runtimeContextRaw.rebuild_status = 'waiting_for_index';
              runtimeContextRaw.rebuild_wait_ms = indexWaitMs;
              log.warn('[RuntimeFacade] Context overflow but index not ready, user should wait', {
                sessionId,
                currentTokens,
                maxTokens,
                indexWaitMs,
              });
            }
            
            // Execute context rebuild if decision is positive AND index is ready
            if (decision.shouldRebuild && indexReady) {
              log.info('[RuntimeFacade] Context rebuild triggered', {
                sessionId,
                agentId,
                reason: decision.reason,
                confidence: decision.confidence,
                isHeartbeatOrCron,
                indexReady,
              });
              
              const rebuildResult = await executeContextRebuild(
                sessionId,
                agentId,
                prompt || 'system heartbeat task',
                {
                  mode: 'embed',
                  topK: isHeartbeatSession(sessionId) ? 15 : 12,
                  excludeSystemPrompt: isHeartbeatSession(sessionId),
                  maxTokens: isHeartbeatSession(sessionId) ? 4000 : maxTokens,
                },
              );
              
              if (rebuildResult.ok && rebuildResult.rankedBlocks.length > 0) {
                runtimeContextRaw.rebuild_blocks = rebuildResult.rankedBlocks;
                runtimeContextRaw.rebuild_tokens = rebuildResult.tokensUsed;
                runtimeContextRaw.rebuild_latency_ms = rebuildResult.latencyMs;
                runtimeContextRaw.rebuild_status = 'ok';
              } else {
                // C2 Fallback: rebuild 失败时降级到 session messages
                log.warn('[RuntimeFacade] Context rebuild failed or empty, falling back', {
                  sessionId,
                  ok: rebuildResult.ok,
                  blocksCount: rebuildResult.rankedBlocks.length,
                  error: rebuildResult.error,
                });
                runtimeContextRaw.rebuild_blocks = [];
                runtimeContextRaw.rebuild_status = 'failed_fallback';
              }
            }
            
            const hasSessionMessages = Array.isArray(runtimeContextRaw.session_messages);
            if (!hasSessionMessages) {
              // Fallback: 已经在上面设置了 recentDigests，这里只做兜底
              runtimeContextRaw.session_messages = this.sessionManager.getMessages(sessionId, ALWAYS_KEEP_RECENT_ROUNDS);
            }
            if (typeof runtimeContextRaw.session_id !== 'string' || runtimeContextRaw.session_id.trim().length === 0) {
              runtimeContextRaw.session_id = sessionId;
            }
            if (typeof runtimeContextRaw.agent_id !== 'string' || runtimeContextRaw.agent_id.trim().length === 0) {
              runtimeContextRaw.agent_id = agentId;
            }
            payload._runtime_context = runtimeContextRaw;
            return payload;
          })()
        : input;

      const session = this.sessionManager.getSession(sessionId);
      const contextProjectPath = session?.projectPath;
      const sessionContext = (session?.context && typeof session.context === 'object')
        ? session.context as Record<string, unknown>
        : undefined;
      const contextChannelId = sessionContext && typeof sessionContext.channelId === 'string'
        ? sessionContext.channelId
        : undefined;

      const result = await this.toolRegistry.execute(resolvedToolName, executionInput, {
        agentId,
        sessionId,
        ...(typeof contextProjectPath === 'string' && contextProjectPath.trim().length > 0
          ? { cwd: contextProjectPath }
          : {}),
        ...(typeof contextChannelId === 'string' && contextChannelId.trim().length > 0
          ? { channelId: contextChannelId }
          : {}),
      });
      const duration = Date.now() - startTime;

      // 发送 tool_result 事件
      log.info('[RuntimeFacade] Tool call complete', {
        toolId,
        toolName: resolvedToolName,
        agentId,
        sessionId,
        duration,
        traceId,
      });
      await this.eventBus.emit({
        type: 'tool_result',
        toolId,
        toolName: resolvedToolName,
        agentId,
        sessionId,
        timestamp: new Date().toISOString(),
        payload: { input: executionInput, output: result, duration, ...(traceId ? { traceId } : {}) },
      });

      if (resolvedToolName === 'view_image') {
        await this.appendViewImageAttachmentEvent(sessionId, result);
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // 发送 tool_error 事件
      log.error('[RuntimeFacade] Tool call failed', error instanceof Error ? error : new Error(errorMessage), {
        toolId,
        toolName: resolvedToolName,
        agentId,
        sessionId,
        duration,
        traceId,
      });
      await this.eventBus.emit({
        type: 'tool_error',
        toolId,
        toolName: resolvedToolName,
        agentId,
        sessionId,
        timestamp: new Date().toISOString(),
        payload: { input, error: this.sanitizeToolError(resolvedToolName, errorMessage), duration, ...(traceId ? { traceId } : {}) },
      });

      throw error;
    }
  }

  /**
   * Bind an agent to a session as the preferred tool-execution context.
   * This avoids cross-turn/cross-agent session drift when tool requests do not carry sessionId.
   */
  bindAgentSession(agentId: string, sessionId: string): void {
    const normalizedAgentId = agentId.trim();
    const normalizedSessionId = sessionId.trim();
    if (normalizedAgentId.length === 0 || normalizedSessionId.length === 0) return;
    if (!this.isBindableSessionId(normalizedAgentId, normalizedSessionId)) {
      log.warn('Rejected agent-session binding', {
        agentId: normalizedAgentId,
        sessionId: normalizedSessionId,
        reason: this.isEphemeralDispatchSessionId(normalizedSessionId)
          ? 'ephemeral_dispatch_id_forbidden'
          : 'session_not_found_or_agent_scope_forbidden',
      });
      return;
    }
    this.agentSessionBindings.set(normalizedAgentId, normalizedSessionId);
    try {
      const provider = 'finger';
      const latest = this.sessionControlPlaneStore.list({ agentId: normalizedAgentId, provider })[0];
      const sameBinding = latest
        && latest.fingerSessionId === normalizedSessionId
        && latest.providerSessionId === normalizedSessionId;
      if (!sameBinding) {
        this.sessionControlPlaneStore.set(
          normalizedSessionId,
          normalizedAgentId,
          provider,
          normalizedSessionId,
          { source: 'runtime.bindAgentSession' },
        );
      }
    } catch (error) {
      log.warn('Failed to persist session control-plane binding', {
        agentId: normalizedAgentId,
        sessionId: normalizedSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Resolve the current preferred session binding for an agent.
   * Used by dispatch/session orchestration to keep agent runtime stable across turns/restarts.
   */
  getBoundSessionId(agentId: string): string | null {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) return null;
    const bound = this.sanitizeToolSessionCandidate(
      normalizedAgentId,
      this.agentSessionBindings.get(normalizedAgentId) ?? null,
      'runtime.getBoundSessionId.bound',
    );
    if (bound) return bound;
    const persisted = this.resolvePersistedAgentSessionBinding(normalizedAgentId);
    if (!persisted) return null;
    this.agentSessionBindings.set(normalizedAgentId, persisted);
    return persisted;
  }

  private async appendViewImageAttachmentEvent(sessionId: string, toolResult: unknown): Promise<void> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;

    const attachment = this.extractViewImageAttachment(toolResult);
    if (!attachment) return;

    const content = `[view_image] ${attachment.name}`;
    const message = await this.sessionManager.addMessage(sessionId, 'user', content, {
      attachments: [attachment],
    });
    if (!message) return;

    await this.eventBus.emit({
      type: 'user_message',
      sessionId,
      timestamp: message.timestamp,
      payload: {
        messageId: message.id,
        content,
        attachments: [attachment],
      },
    });
  }

  private extractViewImageAttachment(toolResult: unknown): Attachment | null {
    if (!isRecord(toolResult)) return null;
    if (toolResult.ok !== true) return null;
    if (typeof toolResult.path !== 'string' || toolResult.path.trim().length === 0) return null;
    if (typeof toolResult.mimeType !== 'string' || !toolResult.mimeType.startsWith('image/')) return null;

    const fullPath = toolResult.path.trim();
    const fileName = path.basename(fullPath);
    const attachment: Attachment = {
      id: `view-image-${Date.now()}`,
      name: fileName.length > 0 ? fileName : fullPath,
      type: 'image',
      url: fullPath,
      mimeType: typeof toolResult.mimeType === 'string' ? toolResult.mimeType : undefined,
    };
    if (typeof toolResult.sizeBytes === 'number' && Number.isFinite(toolResult.sizeBytes)) {
      attachment.size = Math.max(0, Math.floor(toolResult.sizeBytes));
    }
    return attachment;
  }

  /**
   * 注册工具
   */
  registerTool(tool: {
    name: string;
    description: string;
    inputSchema: unknown;
    handler: (input: unknown, context?: Record<string, unknown>) => Promise<unknown>;
    policy?: 'allow' | 'deny';
  }): void {
    this.toolRegistry.register({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: tool.handler,
      policy: tool.policy || 'allow',
    });
  }

  /**
   * 设置工具策略
   */
  setToolPolicy(toolName: string, policy: 'allow' | 'deny'): boolean {
    return this.toolRegistry.setPolicy(toolName, policy);
  }

  /**
   * 列出工具
   */
  listTools(): Array<{ name: string; description: string; policy: 'allow' | 'deny' }> {
    return this.toolRegistry.list();
  }

  /**
   * 授予 agent 工具白名单权限
   */
  grantToolToAgent(agentId: string, toolName: string): AgentToolPolicy {
    return this.toolAccessControl.grant(agentId, toolName);
  }

  /**
   * 撤销 agent 工具白名单权限
   */
  revokeToolFromAgent(agentId: string, toolName: string): AgentToolPolicy {
    return this.toolAccessControl.revoke(agentId, toolName);
  }

  /**
   * 设置 agent 工具白名单
   */
  setAgentToolWhitelist(agentId: string, toolNames: string[]): AgentToolPolicy {
    return this.toolAccessControl.setWhitelist(agentId, toolNames);
  }

  /**
   * 设置 agent 工具黑名单
   */
  setAgentToolBlacklist(agentId: string, toolNames: string[]): AgentToolPolicy {
    return this.toolAccessControl.setBlacklist(agentId, toolNames);
  }

  /**
   * 将单个工具加入 agent 黑名单
   */
  denyToolForAgent(agentId: string, toolName: string): AgentToolPolicy {
    return this.toolAccessControl.deny(agentId, toolName);
  }

  /**
   * 从 agent 黑名单移除单个工具
   */
  allowToolForAgent(agentId: string, toolName: string): AgentToolPolicy {
    return this.toolAccessControl.allow(agentId, toolName);
  }

  /**
   * 获取 agent 工具权限策略
   */
  getAgentToolPolicy(agentId: string): AgentToolPolicy {
    return this.toolAccessControl.getPolicy(agentId);
  }

  /**
   * 清空 agent 工具权限策略
   */
  clearAgentToolPolicy(agentId: string): void {
    this.toolAccessControl.clear(agentId);
  }

  /**
   * 设置 agent 运行时配置（provider/session/governance）
   */
  setAgentRuntimeConfig(agentId: string, config: AgentRuntimeConfig): AgentRuntimeConfig {
    const normalized: AgentRuntimeConfig = {
      ...config,
      id: agentId,
    };
    this.agentRuntimeConfigs.set(agentId, normalized);
    return normalized;
  }

  /**
   * 读取 agent 运行时配置
   */
  getAgentRuntimeConfig(agentId: string): AgentRuntimeConfig | null {
    return this.agentRuntimeConfigs.get(agentId) ?? null;
  }

  /**
   * 清空 agent 运行时配置
   */
  clearAgentRuntimeConfig(agentId: string): void {
    this.agentRuntimeConfigs.delete(agentId);
  }

  /**
   * 列出所有 agent 运行时配置
   */
  listAgentRuntimeConfigs(): AgentRuntimeConfig[] {
    return Array.from(this.agentRuntimeConfigs.values())
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * 根据角色模板设置工具策略
   */
  applyAgentRoleToolPolicy(agentId: string, role: string): AgentToolPolicy {
    return applyRoleToolPolicy(this.toolAccessControl, agentId, role, this.roleToolPolicyPresets);
  }

  /**
   * 设置角色策略模板（由配置文件驱动）
   */
  setRoleToolPolicyPresets(presets: RoleToolPolicyPresetMap): string[] {
    const next: RoleToolPolicyPresetMap = {};
    for (const [key, preset] of Object.entries(presets)) {
      const roleKey = key.trim().toLowerCase();
      if (roleKey.length === 0) continue;
      next[roleKey] = {
        role: preset.role,
        whitelist: [...preset.whitelist],
        blacklist: [...preset.blacklist],
      };
    }
    this.roleToolPolicyPresets = next;
    return Object.keys(this.roleToolPolicyPresets).sort();
  }

  /**
   * 返回可用角色策略名称
   */
  listRoleToolPolicyPresets(): string[] {
    return Object.keys(this.roleToolPolicyPresets).sort();
  }

  /**
   * 设置工具是否需要授权令牌
   */
  setToolAuthorizationRequired(toolName: string, required: boolean): void {
    this.toolAuthorization.setToolRequired(toolName, required);
  }

  /**
   * 为 agent + tool 签发一次性/多次授权令牌
   */
  issueToolAuthorization(
    agentId: string,
    toolName: string,
    issuedBy: string,
    options: AuthorizationIssueOptions = {},
  ): ToolAuthorizationGrant {
    return this.toolAuthorization.issue(agentId, toolName, issuedBy, options);
  }

  /**
   * 吊销授权令牌
   */
  revokeToolAuthorization(token: string): boolean {
    return this.toolAuthorization.revoke(token);
  }

  // ==================== 任务进度 ====================

  /**
   * 报告任务开始
   */
  emitTaskStarted(sessionId: string, taskId: string, title: string, agentId?: string): void {
    this.eventBus.emit({
      type: 'task_started',
      sessionId,
      taskId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: { title },
    });
  }

  /**
   * 报告任务进度
   */
  emitTaskProgress(sessionId: string, taskId: string, progress: number, message?: string, agentId?: string): void {
    this.eventBus.emit({
      type: 'task_progress',
      sessionId,
      taskId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: { progress, message },
    });
  }

  /**
   * 报告任务完成
   */
  emitTaskCompleted(sessionId: string, taskId: string, result?: unknown, agentId?: string): void {
    this.eventBus.emit({
      type: 'task_completed',
      sessionId,
      taskId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: { result },
    });
  }

  /**
   * 报告任务失败
   */
  emitTaskFailed(sessionId: string, taskId: string, error: string, agentId?: string): void {
    this.eventBus.emit({
      type: 'task_failed',
      sessionId,
      taskId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: { error },
    });
  }

  // ==================== 工作流进度 ====================

  /**
   * 报告工作流进度
   */
  reportProgress(sessionId: string, progress: ProgressReport): void {
    this.eventBus.emit({
      type: 'workflow_progress',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        overallProgress: progress.overall,
        activeAgents: progress.activeAgents,
        pendingTasks: progress.pending,
        completedTasks: progress.completed,
        failedTasks: progress.failed,
      },
    });
  }

  /**
   * 报告 Plan 更新
   */
  emitPlanUpdated(sessionId: string, planId: string, version: number, taskCount: number, completedCount: number): void {
    this.eventBus.emit({
      type: 'plan_updated',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        planId,
        version,
        taskCount,
        completedCount,
      },
    });
  }

  // ==================== 上下文压缩 ====================
  /**
   * 压缩上下文（使用确定性压缩，不需要 LLM）
   */
  async compressContext(sessionId: string, options?: { trigger?: "manual" | "auto"; contextUsagePercent?: number }): Promise<string> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    log.warn('RuntimeFacade.compressContext rejected: compaction is kernel-owned', {
      sessionId,
      trigger: options?.trigger === 'auto' ? 'auto' : 'manual',
      contextUsagePercent: options?.contextUsagePercent,
      ownerAgentId: typeof session.context?.ownerAgentId === 'string' ? session.context.ownerAgentId : undefined,
    });
    throw createRustKernelCompactionError();
  }

  /**
   * Append turn digest with tags when finish_reason=stop
   */
  async appendDigest(
    sessionId: string,
    message: { id: string; role: string; content: string; timestamp: string },
    tags: string[],
    agentId?: string,
    mode?: string,
  ): Promise<void> {
    const normalized = sessionId.trim();
    if (normalized.length === 0) {
      return;
    }
    if (typeof this.sessionManager.appendDigest !== "function") {
      return;
    }
    // Cast role to match ISessionManager.appendDigest signature
    const normalizedMessage = {
      role: message.role as SessionMessage['role'],
      content: message.content,
      timestamp: message.timestamp,
    };
    await this.sessionManager.appendDigest(normalized, normalizedMessage, tags, agentId, mode);
  }


  async maybeAutoCompact(sessionId: string, contextUsagePercent?: number, turnId?: string): Promise<boolean> {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) return false;
    if (typeof contextUsagePercent !== 'number' || !Number.isFinite(contextUsagePercent)) return false;
    log.info('Auto compact probe ignored: compaction is kernel-owned by Rust', {
      sessionId: normalizedSessionId,
      contextUsagePercent: Math.max(0, Math.floor(contextUsagePercent)),
      turnId: typeof turnId === 'string' && turnId.trim().length > 0 ? turnId.trim() : undefined,
    });
    return false;
  }

  async maybeAutoDigestOnStop(sessionId: string, turnId?: string): Promise<boolean> {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) return false;
    const existing = autoDigestStopInFlightBySession.get(normalizedSessionId);
    if (existing) return existing;

    const digestJob = (async () => {
      const now = Date.now();
      const normalizedTurnId = typeof turnId === 'string' && turnId.trim().length > 0
        ? turnId.trim()
        : undefined;
      const state = autoDigestStopStateBySession.get(normalizedSessionId);
      if (state && normalizedTurnId && state.lastTurnId === normalizedTurnId) return false;
      autoDigestStopStateBySession.set(normalizedSessionId, {
        lastAttemptAt: now,
        ...(normalizedTurnId ? { lastTurnId: normalizedTurnId } : {}),
      });

      const session = this.sessionManager.getSession(normalizedSessionId);
      if (!session) return false;
      const sessionContext = session.context ?? {};
      const ownerAgentId = typeof sessionContext.ownerAgentId === 'string' && sessionContext.ownerAgentId.trim().length > 0
        ? sessionContext.ownerAgentId.trim()
        : 'finger-project-agent';
      const mode = typeof sessionContext.sessionTier === 'string' && sessionContext.sessionTier.trim().length > 0
        ? sessionContext.sessionTier.trim()
        : 'main';

      try {
        const digestResult = await executeContextLedgerMemory({
          action: 'digest_incremental',
          session_id: normalizedSessionId,
          agent_id: ownerAgentId,
          mode,
          trigger: 'auto',
          _runtime_context: {
            session_id: normalizedSessionId,
            agent_id: ownerAgentId,
            mode,
          },
        });
        if (digestResult.action !== 'digest_incremental') return false;
        if (digestResult.no_new_entries === true || digestResult.task_digest_count <= 0) {
          log.info('Auto stop digest skipped (no new entries)', {
            sessionId: normalizedSessionId,
            turnId: normalizedTurnId,
            sourceSlotStart: digestResult.source_slot_start,
            sourceSlotEnd: digestResult.source_slot_end,
            previousCompactedSlotEnd: digestResult.previous_compacted_slot_end,
          });
          return false;
        }
        this.updateSessionContext(normalizedSessionId, {
          contextDigestLastSourceSlotStart: digestResult.source_slot_start,
          contextDigestLastSourceSlotEnd: digestResult.source_slot_end,
          contextDigestLastUpdatedAt: new Date().toISOString(),
        });
        if (typeof this.sessionManager.syncProjectionFromLedger === 'function') {
          const syncResult = await this.sessionManager.syncProjectionFromLedger(normalizedSessionId, {
            agentId: ownerAgentId,
            mode,
            source: 'runtime_auto_digest',
          });
          log.info('Auto stop digest projection sync completed', {
            sessionId: normalizedSessionId,
            turnId: normalizedTurnId,
            syncResult,
          });
        }
        log.info('Auto stop digest completed', {
          sessionId: normalizedSessionId,
          turnId: normalizedTurnId,
          taskDigestCount: digestResult.task_digest_count,
          sourceSlotStart: digestResult.source_slot_start,
          sourceSlotEnd: digestResult.source_slot_end,
          previousCompactedSlotEnd: digestResult.previous_compacted_slot_end,
        });
        return true;
      } catch (error) {
        log.warn('Auto stop digest failed', {
          sessionId: normalizedSessionId,
          turnId: normalizedTurnId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    })();

    autoDigestStopInFlightBySession.set(normalizedSessionId, digestJob);
    try {
      return await digestJob;
    } finally {
      autoDigestStopInFlightBySession.delete(normalizedSessionId);
    }
  }

  // ==================== 事件订阅 ====================

  /**
   * 订阅事件
   */
  subscribe(eventType: string, handler: (event: RuntimeEvent) => void): () => void {
    return this.eventBus.subscribe(eventType, handler);
  }

  /**
   * 获取事件历史
   */
  getEventHistory(sessionId?: string, limit?: number): RuntimeEvent[] {
    if (sessionId) {
      return this.eventBus.getSessionHistory(sessionId, limit);
    }
    return this.eventBus.getHistory(limit);
  }
}

function collectToolNameSeparators(toolName: string): Set<string> {
  const separators = new Set<string>();
  for (const char of toolName) {
    if (char === '.' || char === '_' || char === '-') separators.add(char);
  }
  return separators;
}

function computeSeparatorScore(candidate: string, preferredSeparators: Set<string>): number {
  if (preferredSeparators.size === 0) return 0;
  let score = 0;
  for (const separator of preferredSeparators) {
    if (candidate.includes(separator)) score += 1;
  }
  return score;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
