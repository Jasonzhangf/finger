import type { Session, SessionMessage } from '../chat/session-types.js';
import { composeTurnContextSlots } from './context-slots.js';
import { MemorySessionManager } from './memory-session-manager.js';
import {
  formatStructuredOutputIssues,
  normalizeStructuredJsonText,
  tryParseStructuredJson,
  validateStructuredOutput,
} from '../../common/structured-output.js';
import { CacheMemoryInterceptor } from './cache-memory-interceptor.js';
import { resolveResponsesOutputSchema } from '../chat-codex/response-output-schemas.js';
import {
  mergeHistory,
  parseUnifiedAgentInput,
  type UnifiedAgentInput,
  type UnifiedAgentOutput,
  type UnifiedAgentRoleProfile,
  type UnifiedHistoryItem,
} from './unified-agent-types.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { inferTagsAndTopic } from '../../common/tag-topic-inference.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { peekContextBuilderOnDemandView } from '../../runtime/context-builder-on-demand-state.js';
import {
  isProjectTaskStateActive,
  parseDelegatedProjectTaskRegistry,
  parseProjectTaskState,
  PROJECT_AGENT_ID,
} from '../../common/project-task-state.js';
import {
  isStopReasoningStopTool,
  resolveStopReasoningPolicy,
} from '../../common/stop-reasoning-policy.js';

export interface KernelRunContext {
  sessionId: string;
  systemPrompt?: string;
  history: UnifiedHistoryItem[];
  tools: string[] | import('../chat-codex/chat-codex-module.js').ChatCodexToolSpecification[];
  metadata?: Record<string, unknown>;
  mailboxSnapshot?: import('../../runtime/mailbox-snapshot.js').MailboxSnapshot;
}

export interface KernelRunnerResult {
  reply: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
}

export interface KernelAgentRunner {
  runTurn(text: string, inputItems?: KernelInputItem[], context?: KernelRunContext): Promise<KernelRunnerResult>;
}

/** Multimodal input item for image attachments. */
export type KernelInputItem =
  | { type: 'text'; text: string }
  | { type: 'image'; image_url: string }
  | { type: 'local_image'; path: string };

export interface KernelAgentBaseConfig {
  moduleId: string;
  provider: string;
  defaultSystemPrompt?: string;
  defaultSystemPromptResolver?: () => string | undefined;
  defaultRoleProfileId?: string;
  appendContextSlotsToSystemPrompt?: boolean;
  maxContextMessages: number;
  roleProfiles?: Record<string, UnifiedAgentRoleProfile>;
  messageHub?: import('../../orchestration/message-hub.js').MessageHub;
  /** Optional context history provider (e.g. ledger/context-builder pipeline). */
  contextHistoryProvider?: (sessionId: string, limit: number) => Promise<Array<{
    id?: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: string;
    metadata?: Record<string, unknown>;
  }> | null>;
}

interface PersistedThreadApiHistorySnapshot {
  threadKey: string;
  items: unknown[];
  updatedAt: string;
}

interface ResumeKernelTurnSnapshot {
  userGoal: string;
  systemPrompt?: string;
  inputItems?: KernelInputItem[];
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  metadata?: Record<string, unknown>;
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  options?: Record<string, unknown>;
}

const DEFAULT_KERNEL_AGENT_CONFIG: Omit<KernelAgentBaseConfig, 'moduleId'> = {
  provider: 'kernel',
  defaultSystemPrompt: undefined,
  defaultRoleProfileId: undefined,
  appendContextSlotsToSystemPrompt: true,
  maxContextMessages: 20,
  roleProfiles: {},
};

const DEFAULT_REVIEW_MAX_TURNS = 10;
const REVIEW_MODE = 'review';
const MAIN_MODE = 'main';
const REVIEW_READONLY_TOOLS = new Set([
  'exec_command',
  'view_image',
  'web_search',
  'context_ledger.memory',
]);

interface ReviewSettings {
  enabled: boolean;
  target: string;
  strictness: 'strict' | 'mainline';
  maxTurns: number;
}

interface ReviewVerdict {
  passed: boolean;
  feedback: string;
  score?: number;
}

const DEFAULT_STRUCTURED_OUTPUT_RETRY_MAX_ATTEMPTS = 1;

export class KernelAgentBase {
  private readonly config: KernelAgentBaseConfig;
  private readonly runner: KernelAgentRunner;
  private readonly sessionManager: MemorySessionManager;
  private readonly apiHistoryByThread = new Map<string, unknown[]>();
  private readonly lockedHistoryByThread = new Map<string, {
    history: SessionMessage[];
    contextHistoryMetadata?: Record<string, unknown>;
  }>();
  private readonly unfinishedTurnByThread = new Map<string, boolean>();
  private readonly externalSessionBindings = new Map<string, string>();
  private readonly cacheMemoryInterceptor: CacheMemoryInterceptor;
  private initialized = false;

  constructor(
    config: Partial<KernelAgentBaseConfig> & Pick<KernelAgentBaseConfig, 'moduleId'>,
    runner: KernelAgentRunner,
    sessionManager = new MemorySessionManager(),
  ) {
    this.config = {
      ...DEFAULT_KERNEL_AGENT_CONFIG,
      ...config,
      moduleId: config.moduleId,
    };
    this.runner = runner;
    this.sessionManager = sessionManager;
    this.cacheMemoryInterceptor = new CacheMemoryInterceptor({
      agentId: this.config.moduleId,
      projectPath: process.cwd(),
      messageHub: this.config.messageHub,
    });
  }

  async handle(message: unknown): Promise<UnifiedAgentOutput> {
    const startedAt = Date.now();
    const input = parseUnifiedAgentInput(message);
    let activeThreadKey: string | null = null;
    let activeHistoryForLock: SessionMessage[] | null = null;
    let activeHistoryMetadataForLock: Record<string, unknown> | undefined;

    if (!input) {
      return {
        success: false,
        error: 'No input text provided',
        module: this.config.moduleId,
        provider: this.config.provider,
        sessionId: 'unknown',
        latencyMs: Date.now() - startedAt,
      };
    }

    await this.ensureInitialized();

    const resumeSnapshotPath = this.resolveResumeKernelTurnSnapshotPath(input.metadata);
    const isRecoveryReplay = typeof resumeSnapshotPath === 'string' && resumeSnapshotPath.length > 0;

    // Intercept user request and write to CACHE.md
    if (!isRecoveryReplay) {
      await this.cacheMemoryInterceptor.interceptRequest(input);
    }

    try {
      const { session, responseSessionId } = await this.resolveSession(input);
      const clientPersist = input.metadata?.sessionPersistence === 'client'
        || input.metadata?.session_persistence === 'client'
        || input.metadata?.persistSession === false;
      if (input.sessionId && !clientPersist && !isRecoveryReplay) {
        await this.sessionManager.addMessage(session.id, {
          role: 'user',
          content: input.text,
          metadata: input.metadata,
        });
      }

      const roleProfile = this.resolveRoleProfile(input.roleProfile);
      const effectiveInputMetadata = this.injectProjectTaskContextSlots({
        inputMetadata: input.metadata,
        roleProfileId: roleProfile?.id,
      });
      const threadMode = this.resolveThreadMode(input.metadata);
      const runnerSessionId = responseSessionId || session.id;
      const threadKey = this.resolveThreadKey(runnerSessionId, threadMode);
      activeThreadKey = threadKey;
      const contextHistorySessionId = responseSessionId || input.sessionId || session.id;
      const resolvedHistory = await this.resolveHistoryForTurn({
        inputMetadata: effectiveInputMetadata,
        sessionId: session.id,
        contextHistorySessionId,
        threadKey,
        threadMode,
      });
      const contextHistoryMetadata = resolvedHistory.contextHistoryMetadata;
      const history = resolvedHistory.history;
      const mergedHistory = mergeHistory(history, input.history, this.config.maxContextMessages);
      activeHistoryForLock = mergedHistory;
      activeHistoryMetadataForLock = contextHistoryMetadata;
      await this.restoreApiHistoryForThreadIfNeeded(runnerSessionId, threadKey);
      const recoverySnapshot = resumeSnapshotPath
        ? await this.loadResumeKernelTurnSnapshot(resumeSnapshotPath)
        : null;
      const tools = this.resolveTools(input.tools, roleProfile, input.metadata);
      const stopReasoningPolicy = resolveStopReasoningPolicy(effectiveInputMetadata);
      const contextSlots = composeTurnContextSlots({
        cacheKey: session.id,
        userInput: input.text,
        history: toUnifiedHistory(mergedHistory),
        tools,
        metadata: effectiveInputMetadata,
      });
      const slotMetadata = contextSlots
        ? {
            contextSlotIds: contextSlots.slotIds,
            contextSlotTrimmedIds: contextSlots.trimmedSlotIds,
          }
        : undefined;
      const runtimeMetadata = this.buildRuntimeMetadata({
        inputMetadata: effectiveInputMetadata,
        roleProfileId: roleProfile?.id,
        mode: threadMode,
        threadKey,
        sessionId: runnerSessionId,
        slotMetadata,
        extra: contextHistoryMetadata,
        contextSlotsRendered:
          this.config.appendContextSlotsToSystemPrompt === false
            ? contextSlots?.rendered
            : undefined,
        stopReasoningPolicy,
      });
      const stopReasoningPrompt = this.buildStopReasoningPrompt({
        tools,
        metadata: runtimeMetadata,
      });
      const systemPrompt = this.appendPromptSections(
        this.buildSystemPrompt(
          roleProfile,
          this.config.appendContextSlotsToSystemPrompt === false ? undefined : contextSlots?.rendered,
        ),
        stopReasoningPrompt,
      );

      const inputItems = this.parseInputItems(input.metadata);
      const mailboxSnapshot = this.parseMailboxSnapshot(input.metadata?.mailboxSnapshot);
      const runnerContext = recoverySnapshot
        ? {
            sessionId: runnerSessionId,
            systemPrompt: recoverySnapshot.systemPrompt,
            history: recoverySnapshot.history ?? [],
            tools: recoverySnapshot.tools ?? tools,
            metadata: {
              ...(recoverySnapshot.metadata ?? {}),
              ...(input.metadata ?? {}),
              recoveryReplay: true,
              recoveryReplaySource: 'prompt_injection_snapshot',
            },
            prebuiltOptions: recoverySnapshot.options,
          }
        : {
        sessionId: runnerSessionId,
        systemPrompt,
        history: toUnifiedHistory(mergedHistory),
        tools,
        metadata: runtimeMetadata,
        ...(mailboxSnapshot ? { mailboxSnapshot } : {}),
      };
      let runResult = await this.runner.runTurn(
        recoverySnapshot?.userGoal ?? input.text,
        recoverySnapshot?.inputItems ?? inputItems,
        runnerContext,
      );

      this.captureApiHistory(runnerSessionId, threadKey, runResult.metadata);
      const pendingInputAccepted = runResult.metadata?.pendingInputAccepted === true;
      this.updateHistoryLockState({
        threadKey,
        history: mergedHistory,
        contextHistoryMetadata,
        runMetadata: runResult.metadata,
      });
      if (pendingInputAccepted) {
        return {
          success: true,
          response: runResult.reply?.trim() || '已加入当前执行队列，等待本轮合并处理。',
          module: this.config.moduleId,
          provider: this.config.provider,
          sessionId: responseSessionId,
          messageId: runResult.messageId,
          latencyMs: Date.now() - startedAt,
          metadata: {
            roleProfile: roleProfile?.id,
            tools,
            ...(slotMetadata ?? {}),
            ...(runResult.metadata ?? {}),
          },
        };
      }

      runResult = await this.applyExecutionNudgeIfNeeded({
        inputText: input.text,
        mode: threadMode,
        sessionId: runnerSessionId,
        systemPrompt,
        history: toUnifiedHistory(mergedHistory),
        tools,
        runtimeMetadata,
        threadKey,
        current: runResult,
      });

      runResult = await this.applyStructuredOutputRecoveryIfNeeded({
        inputText: input.text,
        sessionId: runnerSessionId,
        systemPrompt,
        history: toUnifiedHistory(mergedHistory),
        tools,
        inputMetadata: effectiveInputMetadata,
        runtimeMetadata,
        roleProfileId: roleProfile?.id ?? input.roleProfile,
        threadKey,
        current: runResult,
      });
      runResult = await this.applyStopReasoningGateIfNeeded({
        mode: threadMode,
        inputText: input.text,
        sessionId: runnerSessionId,
        systemPrompt,
        history: toUnifiedHistory(mergedHistory),
        tools,
        runtimeMetadata,
        threadKey,
        current: runResult,
      });
      this.updateHistoryLockState({
        threadKey,
        history: mergedHistory,
        contextHistoryMetadata,
        runMetadata: runResult.metadata,
      });

      // Kernel-level inline review loop is disabled.
      // Review must be executed by explicit reviewer agent nodes in orchestration flow.

      const reply = runResult.reply?.trim();
      if (!reply) {
        throw new Error('chat-codex got empty model reply');
      }

      let assistantMessage: SessionMessage | null = null;
      if (input.sessionId && !clientPersist) {
        const inferred = inferTagsAndTopic({
          texts: [input.text, reply],
          seedTags: [
            roleProfile?.id ?? '',
            this.config.moduleId,
            typeof input.metadata?.channelId === 'string' ? input.metadata.channelId : '',
          ].filter((item) => item.trim().length > 0),
          maxTags: 8,
        });
        assistantMessage = await this.sessionManager.addMessage(session.id, {
          role: 'assistant',
          content: reply,
          metadata: {
            roleProfile: roleProfile?.id,
            tools,
            ...(inferred.tags ? { tags: inferred.tags } : {}),
            ...(inferred.topic ? { topic: inferred.topic } : {}),
          },
        });
      }

      // Intercept assistant response and write to CACHE.md
      const output = {
        success: true,
        response: reply,
        module: this.config.moduleId,
        provider: this.config.provider,
        sessionId: responseSessionId,
        messageId: runResult.messageId ?? assistantMessage?.id,
        latencyMs: Date.now() - startedAt,
        metadata: {
          roleProfile: roleProfile?.id,
          tools,
          ...(slotMetadata ?? {}),
          ...(runResult.metadata ?? {}),
        },
      };
      
      await this.cacheMemoryInterceptor.interceptResponse(output, input);
      
      return output;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (activeThreadKey && activeHistoryForLock && activeHistoryForLock.length > 0) {
        this.lockedHistoryByThread.set(activeThreadKey, {
          history: cloneSessionMessages(activeHistoryForLock),
          ...(activeHistoryMetadataForLock ? { contextHistoryMetadata: { ...activeHistoryMetadataForLock } } : {}),
        });
        this.unfinishedTurnByThread.set(activeThreadKey, true);
      }

      // Ensure failure is recorded in session history so model has context on retry
      if (input.sessionId) {
        try {
          const { session } = await this.resolveSession(input);
          await this.sessionManager.addMessage(session.id, {
            role: 'assistant',
            content: `[执行失败] ${errorMessage}`,
            metadata: {
              error: true,
              finish_reason: 'error',
              roleProfile: input.roleProfile,
              tools: input.tools,
            },
          });
        } catch {
          // Best-effort: do not throw from failure recording
        }
      }

      // Record failure to CACHE.md for persistence
      await this.cacheMemoryInterceptor.interceptResponse(
        {
          success: false,
          error: errorMessage,
          module: this.config.moduleId,
          provider: this.config.provider,
          sessionId: input.sessionId ?? 'unknown',
          latencyMs: Date.now() - startedAt,
        },
        input,
      );

      return {
        success: false,
        error: errorMessage,
        module: this.config.moduleId,
        provider: this.config.provider,
        sessionId: input.sessionId ?? 'unknown',
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.sessionManager.initialize();
    this.initialized = true;
  }

  private async resolveSession(input: UnifiedAgentInput): Promise<{ session: Session; responseSessionId: string }> {
    if (input.createNewSession || !input.sessionId) {
      const created = await this.sessionManager.createSession({
        title: input.text.substring(0, 50) || '新对话',
        metadata: input.metadata,
      });
      const responseSessionId = input.sessionId ?? created.id;
      if (input.sessionId) {
        this.externalSessionBindings.set(input.sessionId, created.id);
      }
      return { session: created, responseSessionId };
    }

    const externalSessionId = input.sessionId;
    const mappedInternalSessionId = this.externalSessionBindings.get(externalSessionId) ?? externalSessionId;
    const existing = await this.sessionManager.getSession(mappedInternalSessionId);
    if (existing) {
      if (mappedInternalSessionId !== externalSessionId) {
        this.externalSessionBindings.set(externalSessionId, mappedInternalSessionId);
      }
      return { session: existing, responseSessionId: externalSessionId };
    }

    const created = await this.sessionManager.createSession({
      title: input.text.substring(0, 50) || '新对话',
      metadata: input.metadata,
    });
    this.externalSessionBindings.set(externalSessionId, created.id);
    return { session: created, responseSessionId: externalSessionId };
  }

  private resolveThreadKey(sessionId: string, mode: string): string {
    const normalizedMode = mode.trim().length > 0 ? mode.trim() : MAIN_MODE;
    return `${sessionId}:${normalizedMode}`;
  }

  private async resolveHistoryForTurn(params: {
    inputMetadata: Record<string, unknown> | undefined;
    sessionId: string;
    contextHistorySessionId: string;
    threadKey: string;
    threadMode: string;
  }): Promise<{
    history: SessionMessage[];
    contextHistoryMetadata?: Record<string, unknown>;
  }> {
    const canReuseLockedHistory = this.shouldReuseLockedHistory({
      inputMetadata: params.inputMetadata,
      sessionId: params.contextHistorySessionId,
      threadKey: params.threadKey,
      threadMode: params.threadMode,
    });
    if (canReuseLockedHistory) {
      const locked = this.lockedHistoryByThread.get(params.threadKey);
      if (locked && locked.history.length > 0) {
        return {
          history: cloneSessionMessages(locked.history),
          ...(locked.contextHistoryMetadata ? { contextHistoryMetadata: { ...locked.contextHistoryMetadata } } : {}),
        };
      }
    }

    const providedHistory = this.config.contextHistoryProvider
      ? await this.config.contextHistoryProvider(params.contextHistorySessionId, this.config.maxContextMessages)
      : null;
    const contextHistoryMetadata = extractContextHistoryMetadata(providedHistory);
    const history = Array.isArray(providedHistory)
      ? maybeCompressHistoryToTaskDigests(
          providedHistory.map((item, idx) => ({
            id: item.id ?? `ctx-${Date.now()}-${idx}`,
            role: item.role,
            content: item.content,
            timestamp: item.timestamp ?? new Date().toISOString(),
            metadata: item.metadata,
          })),
          {
            ...(params.inputMetadata ?? {}),
            ...(contextHistoryMetadata ?? {}),
          },
        )
      : await this.sessionManager.getMessageHistory(params.sessionId, this.config.maxContextMessages);
    return {
      history,
      ...(contextHistoryMetadata ? { contextHistoryMetadata } : {}),
    };
  }

  private shouldReuseLockedHistory(params: {
    inputMetadata: Record<string, unknown> | undefined;
    sessionId: string;
    threadKey: string;
    threadMode: string;
  }): boolean {
    if (!this.lockedHistoryByThread.has(params.threadKey)) return false;
    if (this.unfinishedTurnByThread.get(params.threadKey) !== true) return false;
    if (isExplicitContextRebuildRequested(params.inputMetadata)) return false;
    const pendingOnDemandView = peekContextBuilderOnDemandView(params.sessionId, this.config.moduleId);
    if (pendingOnDemandView && pendingOnDemandView.mode === params.threadMode) {
      return false;
    }
    return true;
  }

  private updateHistoryLockState(params: {
    threadKey: string;
    history: SessionMessage[];
    contextHistoryMetadata?: Record<string, unknown>;
    runMetadata?: Record<string, unknown>;
  }): void {
    const unfinished = isKernelTurnUnfinished(params.runMetadata);
    if (!unfinished) {
      this.unfinishedTurnByThread.set(params.threadKey, false);
      this.lockedHistoryByThread.delete(params.threadKey);
      return;
    }

    if (params.history.length === 0) {
      this.unfinishedTurnByThread.set(params.threadKey, true);
      return;
    }

    this.lockedHistoryByThread.set(params.threadKey, {
      history: cloneSessionMessages(params.history),
      ...(params.contextHistoryMetadata ? { contextHistoryMetadata: { ...params.contextHistoryMetadata } } : {}),
    });
    this.unfinishedTurnByThread.set(params.threadKey, true);
  }

  private buildRuntimeMetadata(params: {
    inputMetadata: Record<string, unknown> | undefined;
    roleProfileId: string | undefined;
    mode: string;
    threadKey: string;
    sessionId: string;
    sessionProjectPath?: string;
    slotMetadata?: Record<string, unknown>;
    contextSlotsRendered?: string;
    extra?: Record<string, unknown>;
    stopReasoningPolicy?: {
      requireToolForStop: boolean;
      promptInjectionEnabled: boolean;
      stopToolNames: string[];
      maxAutoContinueTurns: number;
      source: string;
    };
  }): Record<string, unknown> {
    const hasMediaInput = this.hasMediaInputItems(params.inputMetadata);
    const metadata: Record<string, unknown> = {
      ...(params.inputMetadata ?? {}),
      ...(params.roleProfileId ? { roleProfile: params.roleProfileId } : {}),
      kernelMode: params.mode,
      mode: params.mode,
      contextLedgerEnabled: params.inputMetadata?.contextLedgerEnabled !== false,
      contextLedgerAgentId:
        typeof params.inputMetadata?.contextLedgerAgentId === 'string'
          ? params.inputMetadata.contextLedgerAgentId
          : this.config.moduleId,
      contextLedgerRole:
        typeof params.inputMetadata?.contextLedgerRole === 'string'
          ? params.inputMetadata.contextLedgerRole
          : params.roleProfileId,
      contextLedgerCanReadAll:
        params.inputMetadata?.contextLedgerCanReadAll === true
        || params.roleProfileId === 'project'
        || params.roleProfileId === 'system'
        || params.roleProfileId === 'orchestrator',
      contextLedgerFocusMaxChars:
        typeof params.inputMetadata?.contextLedgerFocusMaxChars === 'number'
          ? params.inputMetadata.contextLedgerFocusMaxChars
          : 20_000,
      contextLedgerFocusEnabled:
        params.inputMetadata?.contextLedgerFocusEnabled !== false,
      stopToolGateEnabled: params.stopReasoningPolicy?.requireToolForStop ?? false,
      stopToolPromptInjectionEnabled: params.stopReasoningPolicy?.promptInjectionEnabled ?? false,
      stopToolNames: params.stopReasoningPolicy?.stopToolNames ?? [],
      stopToolMaxAutoContinueTurns: params.stopReasoningPolicy?.maxAutoContinueTurns ?? 0,
      stopToolGateSource: params.stopReasoningPolicy?.source ?? 'unknown',
      ...(typeof params.contextSlotsRendered === 'string' && params.contextSlotsRendered.trim().length > 0
        ? { contextSlotsRendered: params.contextSlotsRendered }
        : {}),
      ...(params.slotMetadata ?? {}),
      ...(params.extra ?? {}),
    };

    const normalizedProjectPath = typeof params.sessionProjectPath === 'string'
      ? params.sessionProjectPath.trim()
      : '';
    if (normalizedProjectPath.length > 0) {
      if (typeof metadata.projectPath !== 'string' || metadata.projectPath.trim().length === 0) {
        metadata.projectPath = normalizedProjectPath;
      }
      if (typeof metadata.cwd !== 'string' || metadata.cwd.trim().length === 0) {
        metadata.cwd = normalizedProjectPath;
      }
    }

    const existingApiHistory = this.getApiHistoryForThread(params.sessionId, params.threadKey);
    if (!hasMediaInput && existingApiHistory && existingApiHistory.length > 0) {
      metadata.kernelApiHistory = existingApiHistory;
    }

    if (hasMediaInput) {
      delete metadata.kernelApiHistory;
      metadata.kernelApiHistoryBypassed = true;
      metadata.kernelApiHistoryBypassedReason = 'media_input';
    }

    return metadata;
  }

  private injectProjectTaskContextSlots(params: {
    inputMetadata?: Record<string, unknown>;
    roleProfileId?: string;
  }): Record<string, unknown> | undefined {
    const roleProfileId = (params.roleProfileId ?? '').trim().toLowerCase();
    const isSystemLike = roleProfileId === 'system' || roleProfileId === 'orchestrator' || this.config.moduleId === 'finger-system-agent';
    const isProjectLike = roleProfileId === 'project' || this.config.moduleId === 'finger-project-agent';
    if (!isSystemLike && !isProjectLike) return params.inputMetadata;

    const metadata = { ...(params.inputMetadata ?? {}) };
    const snapshot = isRecord(metadata.sessionContextSnapshot)
      ? metadata.sessionContextSnapshot as Record<string, unknown>
      : {};
    const rawState = snapshot.projectTaskState ?? metadata.projectTaskState;
    const rawRegistry = snapshot.projectTaskRegistry ?? metadata.projectTaskRegistry;
    const taskState = parseProjectTaskState(rawState);
    const registry = parseDelegatedProjectTaskRegistry(rawRegistry);
    const activeRegistry = registry.filter((item) => item.active === true);
    const taskRouterPath = (
      typeof snapshot.taskRouterPath === 'string' && snapshot.taskRouterPath.trim().length > 0
        ? snapshot.taskRouterPath.trim()
        : typeof metadata.taskRouterPath === 'string' && metadata.taskRouterPath.trim().length > 0
          ? metadata.taskRouterPath.trim()
          : ''
    );

    const slotPatches = Array.isArray(metadata.contextSlots)
      ? metadata.contextSlots.filter((item) => (
        isRecord(item) ? !['task.router', 'task.project_state', 'task.project_registry'].includes(String(item.id ?? '')) : true
      ))
      : [];
    const slotOrder = Array.isArray(metadata.contextSlotOrder)
      ? metadata.contextSlotOrder.filter((item) => typeof item === 'string' && item.trim().length > 0)
      : [];

    const routerLines = [
      'Task routing source of truth:',
      taskRouterPath.length > 0 ? `- TASK.md: ${taskRouterPath}` : '- TASK.md: <not_set>',
      '- Keep context summary concise; details must stay in TASK.md.',
    ];
    slotPatches.push({
      id: 'task.router',
      mode: 'replace',
      priority: 12,
      maxChars: 600,
      content: routerLines.join('\n'),
    });

    if (isSystemLike) {
      const lines: string[] = [
        'System dispatch lifecycle (managed state, not history-only):',
      ];
      if (activeRegistry.length === 0) {
        lines.push('- No active delegated project task.');
      } else {
        for (const item of activeRegistry.slice(0, 8)) {
          lines.push(
            `- [${item.status}] ${item.targetAgentId}`
            + `${item.taskId ? ` taskId=${item.taskId}` : ''}`
            + `${item.taskName ? ` task="${item.taskName}"` : ''}`
            + `${item.dispatchId ? ` dispatch=${item.dispatchId}` : ''}`,
          );
        }
      }
      if (isProjectTaskStateActive(taskState) && taskState) {
        lines.push('');
        lines.push('Current active task focus:');
        lines.push(
          `- target=${taskState.targetAgentId}`
          + `${taskState.taskId ? ` taskId=${taskState.taskId}` : ''}`
          + `${taskState.taskName ? ` task="${taskState.taskName}"` : ''}`
          + ` status=${taskState.status}`,
        );
      }
      lines.push('');
      lines.push('Rule: if task already delegated/in-progress, do NOT re-dispatch same task; monitor via project.task.status.');
      lines.push('If user changes requirements for in-flight task, use project.task.update with same task identity.');
      slotPatches.push({
        id: 'task.project_registry',
        mode: 'replace',
        priority: 13,
        maxChars: 1800,
        content: lines.join('\n'),
      });
    }

    if (isProjectLike) {
      const lines = taskState
        ? [
          'Project task lifecycle state:',
          `- active=${taskState.active}`,
          `- status=${taskState.status}`,
          `- source=${taskState.sourceAgentId}`,
          `- target=${taskState.targetAgentId}`,
          taskState.taskId ? `- taskId=${taskState.taskId}` : '',
          taskState.taskName ? `- taskName=${taskState.taskName}` : '',
          taskState.dispatchId ? `- dispatchId=${taskState.dispatchId}` : '',
          taskState.note ? `- note=${taskState.note}` : '',
          taskState.summary ? `- summary=${taskState.summary}` : '',
          `- updatedAt=${taskState.updatedAt}`,
        ].filter(Boolean)
        : [
          'Project task lifecycle state:',
          '- active=false',
          '- status=<none>',
          '- source=<none>',
          '- target=finger-project-agent',
          '- note=No active projectTaskState in session context.',
        ];
      slotPatches.push({
        id: 'task.project_state',
        mode: 'replace',
        priority: 13,
        maxChars: 1200,
        content: lines.join('\n'),
      });

      const projectRegistry = registry.filter((item) => item.targetAgentId === PROJECT_AGENT_ID);
      const historyLines: string[] = [
        'Project dispatch history (latest first):',
      ];
      if (projectRegistry.length === 0) {
        historyLines.push('- No dispatch history for finger-project-agent in this session.');
      } else {
        for (const item of projectRegistry.slice(0, 10)) {
          historyLines.push(
            `- [${item.status}] active=${item.active} updatedAt=${item.updatedAt}`
            + ` source=${item.sourceAgentId}`
            + `${item.taskId ? ` taskId=${item.taskId}` : ''}`
            + `${item.taskName ? ` task="${item.taskName}"` : ''}`
            + `${item.dispatchId ? ` dispatch=${item.dispatchId}` : ''}`,
          );
        }
      }
      historyLines.push('');
      historyLines.push('Execution rule: treat this slot as authoritative dispatch history for current project session.');
      historyLines.push('If active task exists, continue that task first; do not start unrelated work unless assigner/user explicitly updates task scope.');
      slotPatches.push({
        id: 'task.project_registry',
        mode: 'replace',
        priority: 13,
        maxChars: 1800,
        content: historyLines.join('\n'),
      });
    }

    const ensureOrder = ['turn.user_input', 'task.router', 'task.project_registry', 'task.project_state', 'turn.recent_history', 'turn.allowed_tools'];
    for (const item of ensureOrder) {
      if (!slotOrder.includes(item)) slotOrder.push(item);
    }

    metadata.contextSlots = slotPatches;
    metadata.contextSlotOrder = slotOrder;
    metadata.projectTaskState = rawState;
    metadata.projectTaskRegistry = rawRegistry;
    if (taskRouterPath.length > 0) metadata.taskRouterPath = taskRouterPath;
    return metadata;
  }

  private hasMediaInputItems(metadata?: Record<string, unknown>): boolean {
    const inputItems = this.parseInputItems(metadata);
    if (!inputItems || inputItems.length === 0) return false;
    return inputItems.some((item) => item.type === 'image' || item.type === 'local_image');
  }

  private resolveReviewSettings(metadata?: Record<string, unknown>): ReviewSettings | undefined {
    if (!metadata) return undefined;
    const reviewBlock = isRecord(metadata.review) ? metadata.review : undefined;
    const enabledFromBlock = typeof reviewBlock?.enabled === 'boolean' ? reviewBlock.enabled : undefined;
    const enabledFromFlat = typeof metadata.reviewEnabled === 'boolean' ? metadata.reviewEnabled : undefined;
    const enabled = enabledFromBlock ?? enabledFromFlat ?? false;
    if (!enabled) return undefined;

    const target =
      (typeof reviewBlock?.target === 'string' ? reviewBlock.target : undefined)
      ?? (typeof metadata.reviewTarget === 'string' ? metadata.reviewTarget : undefined)
      ?? '';
    const normalizedTarget = target.trim();
    if (normalizedTarget.length === 0) return undefined;

    const rawStrictness =
      (typeof reviewBlock?.strictness === 'string' ? reviewBlock.strictness : undefined)
      ?? (typeof metadata.reviewStrictness === 'string' ? metadata.reviewStrictness : undefined)
      ?? 'mainline';
    const strictness = rawStrictness === 'strict' ? 'strict' : 'mainline';

    const rawMaxTurns =
      (typeof reviewBlock?.maxTurns === 'number' ? reviewBlock.maxTurns : undefined)
      ?? (typeof metadata.reviewMaxTurns === 'number' ? metadata.reviewMaxTurns : undefined)
      ?? DEFAULT_REVIEW_MAX_TURNS;
    const maxTurns = Number.isFinite(rawMaxTurns)
      ? Math.max(0, Math.floor(rawMaxTurns))
      : DEFAULT_REVIEW_MAX_TURNS;

    return {
      enabled: true,
      target: normalizedTarget,
      strictness,
      maxTurns,
    };
  }

  private async applyReviewLoop(params: {
    input: UnifiedAgentInput;
    roleProfileId: string | undefined;
    sessionId: string;
    userInput: string;
    systemPrompt: string | undefined;
    history: UnifiedHistoryItem[];
    tools: string[];
    slotMetadata?: Record<string, unknown>;
    mainThreadKey: string;
    current: KernelRunnerResult;
  }): Promise<KernelRunnerResult> {
    const reviewSettings = this.resolveReviewSettings(params.input.metadata);
    if (!reviewSettings) return params.current;

    let currentResult = params.current;
    let currentReply = currentResult.reply.trim();
    if (currentReply.length === 0) {
      throw new Error('chat-codex got empty model reply');
    }

    const reviewThreadKey = this.resolveThreadKey(params.sessionId, REVIEW_MODE);
    await this.restoreApiHistoryForThreadIfNeeded(params.sessionId, reviewThreadKey);
    const reviewTools = resolveReviewTools(params.tools);
    const reviewSystemPrompt = buildReviewSystemPrompt(this.buildSystemPrompt(this.resolveRoleProfile(params.roleProfileId)));
    const reviewCwd = resolveReviewCwd(params.input.metadata);

    // Track review started
    const reviewStartMetadata = this.buildRuntimeMetadata({
      inputMetadata: params.input.metadata,
      roleProfileId: params.roleProfileId,
      mode: REVIEW_MODE,
      threadKey: reviewThreadKey,
      sessionId: params.sessionId,
      extra: {
        contextLedgerEnabled: false,
        review: {
          phase: 'started',
          target: reviewSettings.target,
          strictness: reviewSettings.strictness,
          maxTurns: reviewSettings.maxTurns,
        },
      },
    });
    this.captureApiHistory(params.sessionId, reviewThreadKey, reviewStartMetadata);

    const hasLimit = reviewSettings.maxTurns > 0;
    const traces: Array<Record<string, unknown>> = [];
    let iteration = 0;

    while (!hasLimit || iteration < reviewSettings.maxTurns) {
      iteration += 1;

      const reviewMetadata = this.buildRuntimeMetadata({
        inputMetadata: params.input.metadata,
        roleProfileId: params.roleProfileId,
        mode: REVIEW_MODE,
        threadKey: reviewThreadKey,
        sessionId: params.sessionId,
        extra: {
          contextLedgerEnabled: false,
          review: {
            phase: 'review',
            iteration,
            target: reviewSettings.target,
            strictness: reviewSettings.strictness,
            maxTurns: reviewSettings.maxTurns,
          },
        },
      });

      const reviewResult = await this.runner.runTurn(
        buildReviewTurnInput({
          target: reviewSettings.target,
          strictness: reviewSettings.strictness,
          cwd: reviewCwd,
          userInput: params.userInput,
          assistantOutput: currentReply,
          assistantMetadata: currentResult.metadata,
        }),
        undefined,
        {
          sessionId: params.sessionId,
          systemPrompt: reviewSystemPrompt,
          history: [],
          tools: reviewTools,
          metadata: reviewMetadata,
        },
      );
      this.captureApiHistory(params.sessionId, reviewThreadKey, reviewResult.metadata);

      const verdict = parseReviewVerdict(reviewResult.reply);
      traces.push({
        iteration,
        passed: verdict.passed,
        ...(typeof verdict.score === 'number' ? { score: verdict.score } : {}),
        feedback: verdict.feedback,
      });
      if (verdict.passed) {
        return {
          ...currentResult,
          metadata: {
            ...(currentResult.metadata ?? {}),
            review: {
              enabled: true,
              target: reviewSettings.target,
              strictness: reviewSettings.strictness,
              maxTurns: reviewSettings.maxTurns,
              iterations: iteration,
              passed: true,
              traces,
            },
          },
        };
      }

      const followupMetadata = this.buildRuntimeMetadata({
        inputMetadata: params.input.metadata,
        roleProfileId: params.roleProfileId,
        mode: MAIN_MODE,
        threadKey: params.mainThreadKey,
        sessionId: params.sessionId,
        slotMetadata: params.slotMetadata,
        extra: {
          review: {
            phase: 'feedback',
            iteration,
            target: reviewSettings.target,
            strictness: reviewSettings.strictness,
            maxTurns: reviewSettings.maxTurns,
          },
        },
      });
      const followup = await this.runner.runTurn(
        buildReviewFeedbackInput({
          target: reviewSettings.target,
          strictness: reviewSettings.strictness,
          feedback: verdict.feedback,
        }),
        undefined,
        {
          sessionId: params.sessionId,
          systemPrompt: params.systemPrompt,
          history: params.history,
          tools: params.tools,
          metadata: followupMetadata,
        },
      );
      this.captureApiHistory(params.sessionId, params.mainThreadKey, followup.metadata);
      currentResult = followup;
      currentReply = followup.reply.trim();
      if (currentReply.length === 0) {
        throw new Error('chat-codex got empty model reply');
      }
    }

    return {
      ...currentResult,
      metadata: {
        ...(currentResult.metadata ?? {}),
        review: {
          enabled: true,
          target: reviewSettings.target,
          strictness: reviewSettings.strictness,
          maxTurns: reviewSettings.maxTurns,
          iterations: iteration,
          passed: false,
          stopReason: 'max_turns_reached',
          traces,
        },
      },
    };
  }

  private resolveRoleProfile(roleProfileId?: string): UnifiedAgentRoleProfile | undefined {
    const targetRoleProfileId = roleProfileId ?? this.config.defaultRoleProfileId;
    if (!targetRoleProfileId) return undefined;
    return this.config.roleProfiles?.[targetRoleProfileId];
  }

  private resolveTools(
    inputTools: string[] | undefined,
    roleProfile?: UnifiedAgentRoleProfile,
    metadata?: Record<string, unknown>,
  ): string[] {
    const roleTools = roleProfile?.allowedTools ?? [];
    const resolved = !inputTools || inputTools.length === 0
      ? roleTools
      : roleTools.length === 0
        ? Array.from(new Set(inputTools))
        : Array.from(new Set(inputTools.filter((item) => roleTools.includes(item))));

    const planModeEnabled = resolvePlanModeEnabled(metadata);
    if (planModeEnabled === false) {
      return resolved.filter((tool) => tool !== 'update_plan');
    }
    return resolved;
  }

  private buildSystemPrompt(roleProfile?: UnifiedAgentRoleProfile, slotPrompt?: string): string | undefined {
    const defaultPrompt = this.resolvePrompt(this.config.defaultSystemPrompt, this.config.defaultSystemPromptResolver);
    const rolePrompt = this.resolvePrompt(roleProfile?.systemPrompt, roleProfile?.systemPromptResolver);

    const resolvedBasePrompt = !rolePrompt
      ? defaultPrompt
      : !defaultPrompt
        ? rolePrompt
        : `${defaultPrompt}\n\n[角色约束]\n${rolePrompt}`;

    if (!slotPrompt) return resolvedBasePrompt;
    if (!resolvedBasePrompt) return slotPrompt;
    return `${resolvedBasePrompt}\n\n${slotPrompt}`;
  }

  private appendPromptSections(basePrompt: string | undefined, ...sections: Array<string | undefined>): string | undefined {
    const normalized = [basePrompt, ...sections]
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
    if (normalized.length === 0) return undefined;
    return normalized.join('\n\n');
  }

  private buildStopReasoningPrompt(params: {
    tools: string[] | import('../chat-codex/chat-codex-module.js').ChatCodexToolSpecification[];
    metadata?: Record<string, unknown>;
  }): string | undefined {
    const policy = resolveStopReasoningPolicy(params.metadata);
    if (!policy.requireToolForStop || !policy.promptInjectionEnabled) return undefined;

    const toolNames = collectToolNames(params.tools);
    const availableStopTools = policy.stopToolNames.filter((name) => toolNames.has(name));
    if (availableStopTools.length === 0) return undefined;

    return [
      '[Turn Stop Control]',
      `- Explicit stop tool required: ${availableStopTools.join(', ')}`,
      '- If you believe the current task is truly complete, call the stop tool first and provide a concise completion summary.',
      '- If the task is NOT complete, do NOT call stop tool; continue execution/reasoning.',
      '- If you return finish_reason=stop without stop tool, runtime will continue this task automatically.',
    ].join('\n');
  }

  private resolvePrompt(prompt?: string, resolver?: () => string | undefined): string | undefined {
    const resolved = resolver?.();
    if (resolved && resolved.trim().length > 0) return resolved.trim();
    if (!prompt) return undefined;
    const normalized = prompt.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private resolveThreadMode(metadata?: Record<string, unknown>): string {
    const fromMetadata = typeof metadata?.mode === 'string' ? metadata.mode.trim() : '';
    if (fromMetadata.length > 0) return fromMetadata;
    return 'main';
  }
  
  private parseInputItems(metadata?: Record<string, unknown>): KernelInputItem[] | undefined {
    if (!metadata) return undefined;
    const raw = metadata.inputItems;
    if (!Array.isArray(raw)) return undefined;
    const parsed: KernelInputItem[] = [];
    for (const item of raw) {
      if (!isRecord(item) || typeof item.type !== 'string') continue;
      if (item.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0) {
        parsed.push({ type: 'text', text: item.text });
        continue;
      }
      if (item.type === 'image' && typeof item.image_url === 'string' && item.image_url.trim().length > 0) {
        parsed.push({ type: 'image', image_url: item.image_url });
        continue;
      }
      if (item.type === 'local_image' && typeof item.path === 'string' && item.path.trim().length > 0) {
        parsed.push({ type: 'local_image', path: item.path });
      }
    }
    return parsed.length > 0 ? parsed : undefined;
  }

  private parseMailboxSnapshot(
    rawSnapshot: unknown,
  ): import('../../runtime/mailbox-snapshot.js').MailboxSnapshot | undefined {
    if (!isRecord(rawSnapshot)) return undefined;
    const currentSeq = rawSnapshot.currentSeq;
    if (typeof currentSeq !== 'number' || !Number.isFinite(currentSeq)) return undefined;

    const rawEntries = Array.isArray(rawSnapshot.entries) ? rawSnapshot.entries : [];
    const entries = rawEntries
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => {
        const id = typeof item.id === 'string' ? item.id : '';
        const seq = typeof item.seq === 'number' && Number.isFinite(item.seq) ? Math.floor(item.seq) : 0;
        const shortDescription = typeof item.shortDescription === 'string' ? item.shortDescription : '';
        const createdAt = typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString();
        return {
          id,
          seq,
          shortDescription,
          createdAt,
          ...(typeof item.sourceType === 'string' ? { sourceType: item.sourceType } : {}),
          ...(typeof item.category === 'string' ? { category: item.category } : {}),
          ...(typeof item.priority === 'number' && Number.isFinite(item.priority) ? { priority: Math.floor(item.priority) } : {}),
          ...(typeof item.channel === 'string' ? { channel: item.channel } : {}),
          ...(typeof item.threadId === 'string' ? { threadId: item.threadId } : {}),
          ...(typeof item.sender === 'string' ? { sender: item.sender } : {}),
        };
      })
      .filter((entry) => entry.id.length > 0 && entry.shortDescription.length > 0);

    const hasUnread = typeof rawSnapshot.hasUnread === 'boolean'
      ? rawSnapshot.hasUnread
      : entries.length > 0;
    const lastNotifiedSeq = typeof rawSnapshot.lastNotifiedSeq === 'number' && Number.isFinite(rawSnapshot.lastNotifiedSeq)
      ? Math.floor(rawSnapshot.lastNotifiedSeq)
      : undefined;

    return {
      currentSeq: Math.floor(currentSeq),
      entries,
      hasUnread,
      ...(typeof lastNotifiedSeq === 'number' ? { lastNotifiedSeq } : {}),
    };
  }

  private captureApiHistory(sessionId: string, threadKey: string, metadata?: Record<string, unknown>): void {
    if (!metadata) return;
    const raw = metadata.api_history;
    if (!Array.isArray(raw)) return;
    const normalized = raw.filter((item) => typeof item === 'object' && item !== null);
    this.apiHistoryByThread.set(threadKey, normalized);
    void this.persistApiHistorySnapshot(sessionId, threadKey, normalized);
  }

  private resolveResumeKernelTurnSnapshotPath(metadata?: Record<string, unknown>): string | undefined {
    if (!metadata) return undefined;
    const direct = typeof metadata.resumeKernelTurnFile === 'string' ? metadata.resumeKernelTurnFile.trim() : '';
    if (direct.length > 0) return direct;
    const nested = isRecord(metadata.recovery) && typeof metadata.recovery.resumeKernelTurnFile === 'string'
      ? metadata.recovery.resumeKernelTurnFile.trim()
      : '';
    return nested.length > 0 ? nested : undefined;
  }

  private async loadResumeKernelTurnSnapshot(filePath: string): Promise<ResumeKernelTurnSnapshot | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const lines = raw.split('\n').filter((line) => line.trim().length > 0);
      if (lines.length === 0) return null;
      const parsed = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      const userGoal = typeof parsed.userGoal === 'string' ? parsed.userGoal.trim() : '';
      if (!userGoal) return null;
      const systemPrompt = typeof parsed.systemPrompt === 'string' && parsed.systemPrompt.trim().length > 0
        ? parsed.systemPrompt
        : undefined;
      const inputItems = Array.isArray(parsed.inputItems)
        ? parsed.inputItems.filter((item): item is KernelInputItem => isRecord(item) && typeof item.type === 'string') as KernelInputItem[]
        : undefined;
      const history = Array.isArray(parsed.history)
        ? parsed.history
            .filter((item): item is { role: 'user' | 'assistant' | 'system'; content: string } =>
              isRecord(item)
              && typeof item.role === 'string'
              && (item.role === 'user' || item.role === 'assistant' || item.role === 'system')
              && typeof item.content === 'string')
        : undefined;
      const snapshotMetadata = isRecord(parsed.metadata) ? parsed.metadata : undefined;
      const tools = Array.isArray(parsed.tools)
        ? parsed.tools
            .filter((item): item is { name: string; description?: string; inputSchema?: Record<string, unknown> } =>
              isRecord(item) && typeof item.name === 'string' && item.name.trim().length > 0)
            .map((item) => ({
              name: item.name,
              ...(typeof item.description === 'string' ? { description: item.description } : {}),
              ...(isRecord(item.inputSchema) ? { inputSchema: item.inputSchema } : {}),
            }))
        : undefined;
      const injections = isRecord(parsed.injections) ? parsed.injections : undefined;
      const options = injections && isRecord(injections.options) ? injections.options : undefined;
      return {
        userGoal,
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(inputItems && inputItems.length > 0 ? { inputItems } : {}),
        ...(history && history.length > 0 ? { history } : {}),
        ...(snapshotMetadata ? { metadata: snapshotMetadata } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(options ? { options } : {}),
      };
    } catch {
      return null;
    }
  }

  private getApiHistoryForThread(_sessionId: string, threadKey: string): unknown[] | undefined {
    const existing = this.apiHistoryByThread.get(threadKey);
    if (Array.isArray(existing) && existing.length > 0) {
      return existing;
    }
    return undefined;
  }

  private async persistApiHistorySnapshot(sessionId: string, threadKey: string, items: unknown[]): Promise<void> {
    try {
      const sessionDir = path.join(FINGER_PATHS.home, 'runtime', 'api-history', encodeURIComponent(sessionId));
      await fs.mkdir(sessionDir, { recursive: true });
      const snapshot: PersistedThreadApiHistorySnapshot = {
        threadKey,
        items,
        updatedAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(sessionDir, `${encodeURIComponent(threadKey)}.json`),
        JSON.stringify(snapshot),
        'utf8',
      );
    } catch {
      // Do not fail the turn because persistence is best-effort.
    }
  }

  private async restoreApiHistoryForThreadIfNeeded(sessionId: string, threadKey: string): Promise<void> {
    if (this.apiHistoryByThread.has(threadKey)) return;
    try {
      const file = path.join(
        FINGER_PATHS.home,
        'runtime',
        'api-history',
        encodeURIComponent(sessionId),
        `${encodeURIComponent(threadKey)}.json`,
      );
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedThreadApiHistorySnapshot>;
      const items = Array.isArray(parsed.items)
        ? parsed.items.filter((item) => typeof item === 'object' && item !== null)
        : [];
      if (items.length > 0) {
        this.apiHistoryByThread.set(threadKey, items);
      }
    } catch {
      // Ignore missing/unreadable snapshots.
    }
  }

  private async applyExecutionNudgeIfNeeded(params: {
    inputText: string;
    mode: string;
    sessionId: string;
    systemPrompt?: string;
    history: UnifiedHistoryItem[];
    tools: string[];
    runtimeMetadata: Record<string, unknown>;
    threadKey: string;
    current: KernelRunnerResult;
  }): Promise<KernelRunnerResult> {
    if (params.mode !== MAIN_MODE) return params.current;
    const reply = params.current.reply?.trim() ?? '';
    if (!this.shouldRequestExecutionFollowUp(params.inputText, reply, params.current.metadata)) {
      return params.current;
    }

    const followUpMetadata: Record<string, unknown> = {
      ...params.runtimeMetadata,
      executionNudgeApplied: true,
      executionNudgeReason: 'promise_reply_without_tool_execution',
    };

    const followUpInput = [
      '[SYSTEM CONTINUATION REQUEST]',
      '当前是执行型请求。不要只给承诺或计划，请立即调用可用工具完成任务并返回可验证结果。',
      '结果必须包含关键证据（如命令输出、文件路径、变更摘要）。',
    ].join('\n');

    const followUpResult = await this.runner.runTurn(followUpInput, undefined, {
      sessionId: params.sessionId,
      systemPrompt: params.systemPrompt,
      history: params.history,
      tools: params.tools,
      metadata: followUpMetadata,
    });
    this.captureApiHistory(params.sessionId, params.threadKey, followUpResult.metadata);
    return followUpResult;
  }

  private async applyStructuredOutputRecoveryIfNeeded(params: {
    inputText: string;
    sessionId: string;
    systemPrompt?: string;
    history: UnifiedHistoryItem[];
    tools: string[];
    inputMetadata?: Record<string, unknown>;
    runtimeMetadata: Record<string, unknown>;
    roleProfileId?: string;
    threadKey: string;
    current: KernelRunnerResult;
  }): Promise<KernelRunnerResult> {
    const schemaMetadata = {
      ...(params.runtimeMetadata ?? {}),
      ...(params.inputMetadata ?? {}),
    };
    const schema = resolveResponsesOutputSchema(schemaMetadata, this.resolveSchemaRole(params.roleProfileId));
    if (!schema) return params.current;
    const retryMaxAttempts = resolveStructuredOutputRetryMaxAttempts(schemaMetadata);

    const initialReply = params.current.reply?.trim() ?? '';
    if (initialReply.length === 0) return params.current;

    const firstPass = tryParseStructuredJson(initialReply);
    if (firstPass.parsed !== undefined) {
      const issues = validateStructuredOutput(firstPass.parsed, schema);
      if (issues.length === 0) {
        if (firstPass.repaired) {
          return { ...params.current, reply: normalizeStructuredJsonText(firstPass.parsed) };
        }
        return params.current;
      }
      return this.retryStructuredOutput({
        ...params,
        schema,
        retryMaxAttempts,
        firstReply: initialReply,
        parseFailure: false,
        issues,
      });
    }

    return this.retryStructuredOutput({
      ...params,
      schema,
        retryMaxAttempts,
      firstReply: initialReply,
      parseFailure: true,
      issues: [],
    });
  }

  private async retryStructuredOutput(params: {
    inputText: string;
    sessionId: string;
    systemPrompt?: string;
    history: UnifiedHistoryItem[];
    tools: string[];
    runtimeMetadata: Record<string, unknown>;
    roleProfileId?: string;
    threadKey: string;
    current: KernelRunnerResult;
    schema: Record<string, unknown>;
    retryMaxAttempts: number;
    firstReply: string;
    parseFailure: boolean;
    issues: Array<{ path: string; message: string }>;
  }): Promise<KernelRunnerResult> {
    const initialAttempt = resolveStructuredOutputRetryAttemptCount(params.current.metadata);
    if (initialAttempt >= params.retryMaxAttempts) {
      const suffix = params.parseFailure
        ? 'Structured output parse failed and retry budget exhausted'
        : `Structured output schema mismatch and retry budget exhausted:\n${formatStructuredOutputIssues(params.issues)}`;
      throw new Error(suffix);
    }

    let lastReply = params.firstReply;
    let lastParseFailure = params.parseFailure;
    let lastIssues = [...params.issues];
    let attempt = initialAttempt;

    while (attempt < params.retryMaxAttempts) {
      const retryMetadata: Record<string, unknown> = {
        ...params.runtimeMetadata,
        structuredOutputRetryApplied: true,
        structuredOutputRetryAttempt: attempt + 1,
        structuredOutputRetryMaxAttempts: params.retryMaxAttempts,
        structuredOutputRetryReason: lastParseFailure ? 'parse_error' : 'schema_validation_error',
      };
      const retryPrompt = buildStructuredOutputRetryInput({
        originalUserInput: params.inputText,
        previousReply: lastReply,
        schema: params.schema,
        issues: lastIssues,
        parseFailure: lastParseFailure,
      });

      const retried = await this.runner.runTurn(retryPrompt, undefined, {
        sessionId: params.sessionId,
        systemPrompt: params.systemPrompt,
        history: params.history,
        tools: params.tools,
        metadata: retryMetadata,
      });
      this.captureApiHistory(params.sessionId, params.threadKey, retried.metadata);

      const retriedReply = retried.reply?.trim() ?? '';
      const parsedRetry = tryParseStructuredJson(retriedReply);
      if (parsedRetry.parsed !== undefined) {
        const retryIssues = validateStructuredOutput(parsedRetry.parsed, params.schema);
        if (retryIssues.length === 0) {
          return {
            ...retried,
            reply: normalizeStructuredJsonText(parsedRetry.parsed),
            metadata: {
              ...(retried.metadata ?? {}),
              structuredOutputRecovered: true,
            },
          };
        }
        lastReply = retriedReply;
        lastParseFailure = false;
        lastIssues = retryIssues;
      } else {
        lastReply = retriedReply;
        lastParseFailure = true;
        lastIssues = [];
      }
      attempt += 1;
    }

    if (lastParseFailure) {
      throw new Error([
        'Structured output parse failed after retry.',
        'Model must resend valid JSON matching schema.',
        'Problem: unable to parse JSON object.',
      ].join(' '));
    }

    throw new Error([
      'Structured output schema validation failed after retry.',
      'Model must resend fields at:',
      formatStructuredOutputIssues(lastIssues),
    ].join('\n'));
  }

  private async applyStopReasoningGateIfNeeded(params: {
    mode: string;
    inputText: string;
    sessionId: string;
    systemPrompt?: string;
    history: UnifiedHistoryItem[];
    tools: string[];
    runtimeMetadata: Record<string, unknown>;
    threadKey: string;
    current: KernelRunnerResult;
  }): Promise<KernelRunnerResult> {
    if (params.mode !== MAIN_MODE) return params.current;
    const policy = resolveStopReasoningPolicy(params.runtimeMetadata);
    if (!policy.requireToolForStop) return params.current;
    if (policy.maxAutoContinueTurns <= 0) return params.current;
    const availableTools = collectToolNames(params.tools);
    if (!policy.stopToolNames.some((toolName) => availableTools.has(toolName))) {
      return params.current;
    }

    let current = params.current;
    let attempt = 0;
    while (attempt < policy.maxAutoContinueTurns) {
      if (!isFinishReasonStop(current.metadata)) return current;
      if (hasStopReasoningToolEvidence(current.metadata, policy.stopToolNames)) return current;

      const followUpMetadata: Record<string, unknown> = {
        ...params.runtimeMetadata,
        stopToolGateApplied: true,
        stopToolGateAttempt: attempt + 1,
        stopToolNames: policy.stopToolNames,
      };
      const followUpInput = [
        '[STOP TOOL GATE CONTINUATION REQUEST]',
        '上一轮 finish_reason=stop，但你没有调用 stop 工具。',
        `如果任务已完成：先调用 ${policy.stopToolNames.join(' / ')} 工具并给出 summary，再结束。`,
        '如果任务未完成：继续执行，不要结束。',
        '',
        '[Original User Input]',
        params.inputText,
      ].join('\n');

      current = await this.runner.runTurn(followUpInput, undefined, {
        sessionId: params.sessionId,
        systemPrompt: params.systemPrompt,
        history: params.history,
        tools: params.tools,
        metadata: followUpMetadata,
      });
      this.captureApiHistory(params.sessionId, params.threadKey, current.metadata);
      attempt += 1;
    }
    return current;
  }

  private resolveSchemaRole(roleProfileId?: string): 'orchestrator' | 'reviewer' | 'executor' | 'searcher' | 'router' {
    const normalized = (roleProfileId ?? '').trim().toLowerCase();
    if (normalized.includes('review')) return 'reviewer';
    if (normalized.includes('search') || normalized.includes('research')) return 'searcher';
    if (normalized.includes('execut') || normalized.includes('coder') || normalized.includes('coding')) return 'executor';
    if (normalized === 'router') return 'router';
    return 'orchestrator';
  }

  private shouldRequestExecutionFollowUp(
    inputText: string,
    replyText: string,
    metadata?: Record<string, unknown>,
  ): boolean {
    if (inputText.trim().length === 0 || replyText.trim().length === 0) return false;
    if (metadata?.pendingInputAccepted === true) return false;
    if (metadata?.executionNudgeApplied === true) return false;
    if (hasToolEvidence(metadata)) return false;
    if (!looksLikeExecutionRequest(inputText)) return false;
    if (containsExecutionEvidence(replyText)) return false;
    return looksLikePromiseOnlyReply(replyText);
  }
}

function cloneSessionMessages(history: SessionMessage[]): SessionMessage[] {
  return history.map((item) => ({
    ...item,
    ...(item.metadata ? { metadata: { ...item.metadata } } : {}),
  }));
}

function isExplicitContextRebuildRequested(metadata?: Record<string, unknown>): boolean {
  if (!metadata) return false;
  if (metadata.contextBuilderRebuildRequested === true) return true;
  const source = typeof metadata.contextHistorySource === 'string'
    ? metadata.contextHistorySource.trim().toLowerCase()
    : '';
  if (source === 'context_builder_on_demand') return true;
  const toolTrace = Array.isArray(metadata.tool_trace) ? metadata.tool_trace : [];
  for (const item of toolTrace) {
    if (!isRecord(item)) continue;
    if (item.tool === 'context_builder.rebuild') return true;
  }
  return false;
}

function isKernelTurnUnfinished(metadata?: Record<string, unknown>): boolean {
  if (!metadata) return false;
  if (metadata.pendingInputAccepted === true) return true;

  const rounds = Array.isArray(metadata.round_trace)
    ? metadata.round_trace.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
  if (rounds.length > 0) {
    const lastRound = rounds[rounds.length - 1];
    const finishReasonRaw = typeof lastRound.finish_reason === 'string'
      ? lastRound.finish_reason
      : typeof lastRound.finishReason === 'string'
        ? lastRound.finishReason
        : '';
    const responseStatusRaw = typeof lastRound.response_status === 'string'
      ? lastRound.response_status
      : typeof lastRound.responseStatus === 'string'
        ? lastRound.responseStatus
        : '';
    const finishReason = finishReasonRaw.trim().toLowerCase();
    const responseStatus = responseStatusRaw.trim().toLowerCase();
    if (responseStatus.length > 0 && responseStatus !== 'completed') return true;
    if (finishReason.length > 0 && finishReason !== 'stop') return true;
    return false;
  }

  const stopReason = typeof metadata.stopReason === 'string'
    ? metadata.stopReason.trim().toLowerCase()
    : '';
  if (stopReason.length > 0 && stopReason !== 'stop' && stopReason !== 'model_stop') return true;

  const responseStatus = typeof metadata.responseStatus === 'string'
    ? metadata.responseStatus.trim().toLowerCase()
    : '';
  if (responseStatus.length > 0 && responseStatus !== 'completed') return true;

  return false;
}

function maybeCompressHistoryToTaskDigests(
  history: SessionMessage[],
  metadata?: Record<string, unknown>,
): SessionMessage[] {
  const enabled = metadata?.contextHistoryDigestEnabled !== false
    && metadata?.historyDigestEnabled !== false;
  if (!enabled) return history;
  if (!Array.isArray(history) || history.length === 0) return history;

  const source = typeof metadata?.contextHistorySource === 'string'
    ? metadata.contextHistorySource.trim().toLowerCase()
    : '';
  const isHistoryView = source.startsWith('context_builder')
    || source === 'raw_session'
    || source === 'raw_session_fallback'
    || metadata?.contextBuilderBypassed === true
    || metadata?.contextBuilderRebuilt === true;
  if (!isHistoryView) return history;

  // Design rule: task digest compression is only applied on rebuild turns.
  // Normal continuation turns must preserve recent full-fidelity messages
  // to avoid losing near-term execution/tool context.
  const rebuiltThisTurn = metadata?.contextBuilderRebuilt === true
    || source === 'context_builder_on_demand'
    || source === 'context_builder_bootstrap';
  if (!rebuiltThisTurn) return history;

  const grouped: SessionMessage[][] = [];
  let current: SessionMessage[] = [];
  for (const item of history) {
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (content.length === 0) continue;
    if (item.role === 'user' && current.length > 0) {
      grouped.push(current);
      current = [item];
      continue;
    }
    current.push(item);
  }
  if (current.length > 0) grouped.push(current);
  if (grouped.length === 0) return history;

  const keepRecentTaskCount = 2;
  const keepRecentFrom = Math.max(0, grouped.length - keepRecentTaskCount);
  const output: SessionMessage[] = [];

  for (let index = 0; index < grouped.length; index += 1) {
    const task = grouped[index];
    const preserveFullTask = index >= keepRecentFrom || taskContainsCriticalLifecycleSignals(task);
    if (preserveFullTask) {
      output.push(...task);
      continue;
    }

    const firstUser = task.find((item) => item.role === 'user')?.content ?? task[0]?.content ?? '';
    const lastAssistant = [...task].reverse().find((item) => item.role === 'assistant')?.content
      ?? task[task.length - 1]?.content
      ?? '';
    const startTs = task[0]?.timestamp ?? new Date().toISOString();
    const endTs = task[task.length - 1]?.timestamp ?? startTs;
    const slotRange = resolveTaskSlotRange(task);
    const taskId = task[0]?.id ?? `task-${index + 1}`;
    const lines = [
      `[task_digest ${index + 1}/${grouped.length}] id=${taskId}`,
      `request: ${compressDigestText(firstUser, 260)}`,
      `finish_summary: ${compressDigestText(lastAssistant, 260)}`,
      `time: ${startTs} -> ${endTs}`,
      slotRange
        ? `ledger_slots: ${slotRange.start}-${slotRange.end}`
        : 'ledger_slots: unknown',
      slotRange
        ? `expand_hint: context_ledger.expand_task { slot_start: ${slotRange.start}, slot_end: ${slotRange.end} }`
        : 'expand_hint: use context_ledger.memory search/query(detail=true) to expand this task.',
    ];
    output.push({
      id: `digest-${taskId}-${index + 1}`,
      role: 'assistant',
      content: lines.join('\n'),
      timestamp: endTs,
      metadata: {
        taskDigest: true,
        taskDigestIndex: index + 1,
        taskDigestTotal: grouped.length,
        taskDigestTaskId: taskId,
        ...(slotRange ? { taskDigestSlotStart: slotRange.start, taskDigestSlotEnd: slotRange.end } : {}),
      },
    } satisfies SessionMessage);
  }
  return output;
}

function resolveTaskSlotRange(task: SessionMessage[]): { start: number; end: number } | undefined {
  const slots = task
    .map((item) => {
      const direct = item.metadata?.contextLedgerSlot;
      const fallback = item.metadata?.slot;
      if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return Math.floor(direct);
      if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) return Math.floor(fallback);
      return null;
    })
    .filter((item): item is number => item !== null);
  if (slots.length === 0) return undefined;
  return {
    start: Math.min(...slots),
    end: Math.max(...slots),
  };
}

function compressDigestText(text: string, maxLen: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen)}...`;
}

const CRITICAL_LIFECYCLE_TOOLS = new Set([
  'update_plan',
  'agent.dispatch',
  'dispatch',
  'report-task-completion',
  'project.task.status',
  'project.task.update',
]);

const CRITICAL_LIFECYCLE_PATTERNS: RegExp[] = [
  /\bupdate_plan\b/i,
  /\bagent\.dispatch\b/i,
  /\bdispatch\b/i,
  /\breport-task-completion\b/i,
  /\bproject\.task\.(status|update)\b/i,
  /\btask[_\s-]?completed\b/i,
  /\btask[_\s-]?result\b/i,
  /\breview(er)?\s+(result|pass|passed|reject|rejected|block|blocked)\b/i,
  /\bdecision:\s*(pass|passed|reject|rejected|block|blocked)\b/i,
  /审核(通过|拒绝|驳回|结论)/,
  /任务(完成|结果|交付)/,
];

function taskContainsCriticalLifecycleSignals(task: SessionMessage[]): boolean {
  for (const item of task) {
    const content = typeof item.content === 'string' ? item.content : '';
    if (CRITICAL_LIFECYCLE_PATTERNS.some((pattern) => pattern.test(content))) {
      return true;
    }

    const metadata = item.metadata;
    if (!metadata || typeof metadata !== 'object') continue;

    const toolTrace = Array.isArray(metadata.tool_trace) ? metadata.tool_trace : [];
    for (const trace of toolTrace) {
      if (!isRecord(trace)) continue;
      const toolName = typeof trace.tool === 'string' ? trace.tool.trim() : '';
      if (toolName.length > 0 && CRITICAL_LIFECYCLE_TOOLS.has(toolName)) {
        return true;
      }
    }

    const toolName = typeof metadata.toolName === 'string' ? metadata.toolName.trim() : '';
    if (toolName.length > 0 && CRITICAL_LIFECYCLE_TOOLS.has(toolName)) {
      return true;
    }

    const eventType = typeof metadata.eventType === 'string' ? metadata.eventType.trim().toLowerCase() : '';
    if (eventType === 'task_completed' || eventType === 'task_result' || eventType === 'review_result') {
      return true;
    }
  }
  return false;
}

function toUnifiedHistory(history: SessionMessage[]): UnifiedHistoryItem[] {
  return history.map((item) => ({
    role: item.role,
    content: item.content,
  }));
}

function hasToolEvidence(metadata?: Record<string, unknown>): boolean {
  if (!metadata) return false;
  if (Array.isArray(metadata.tool_trace) && metadata.tool_trace.length > 0) return true;
  if (typeof metadata.toolTraceCount === 'number' && metadata.toolTraceCount > 0) return true;
  return false;
}

function hasStopReasoningToolEvidence(
  metadata: Record<string, unknown> | undefined,
  stopToolNames: string[],
): boolean {
  if (!metadata) return false;
  const names = Array.isArray(stopToolNames) && stopToolNames.length > 0
    ? stopToolNames
    : resolveStopReasoningPolicy(metadata).stopToolNames;

  const traces = Array.isArray(metadata.tool_trace) ? metadata.tool_trace : [];
  for (const trace of traces) {
    if (!isRecord(trace)) continue;
    const toolName = typeof trace.tool === 'string' ? trace.tool : '';
    if (isStopReasoningStopTool(toolName, names)) return true;
  }

  const lastToolName = typeof metadata.toolName === 'string' ? metadata.toolName : '';
  if (isStopReasoningStopTool(lastToolName, names)) return true;
  return false;
}

function isFinishReasonStop(metadata?: Record<string, unknown>): boolean {
  if (!metadata) return false;
  const rounds = Array.isArray(metadata.round_trace)
    ? metadata.round_trace.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : undefined;
  const roundFinish = typeof lastRound?.finish_reason === 'string'
    ? lastRound.finish_reason
    : typeof lastRound?.finishReason === 'string'
      ? lastRound.finishReason
      : '';
  if (roundFinish.trim().toLowerCase() === 'stop') return true;

  const stopReason = typeof metadata.stopReason === 'string' ? metadata.stopReason.trim().toLowerCase() : '';
  if (stopReason === 'stop' || stopReason === 'model_stop') return true;
  return false;
}

function collectToolNames(
  tools: string[] | import('../chat-codex/chat-codex-module.js').ChatCodexToolSpecification[],
): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (typeof tool === 'string') {
      const normalized = tool.trim();
      if (normalized.length > 0) names.add(normalized);
      continue;
    }
    if (tool && typeof tool === 'object' && typeof tool.name === 'string' && tool.name.trim().length > 0) {
      names.add(tool.name.trim());
    }
  }
  return names;
}

function looksLikeExecutionRequest(text: string): boolean {
  return /(修复|修改|实现|执行|运行|测试|写入|列出|查看|检查|搜索|查找|编译|build|test|run|write|list|fix|implement|edit|patch|search)/i.test(
    text,
  );
}

function looksLikePromiseOnlyReply(text: string): boolean {
  return /(我会|我将|马上|稍后|接着|收到|已收到|我先|I will|I'll|let me|going to)/i.test(text);
}

function containsExecutionEvidence(text: string): boolean {
  return /(已完成|完成了|执行结果|exitCode|stdout|stderr|写入成功|已修改|变更如下|结果如下|调用工具|tool_result|命令输出)/i.test(
    text,
  );
}

function resolvePlanModeEnabled(metadata?: Record<string, unknown>): boolean | undefined {
  if (!metadata) return undefined;
  const planBlock = isRecord(metadata.plan) ? metadata.plan : undefined;
  if (typeof planBlock?.enabled === 'boolean') return planBlock.enabled;
  if (typeof metadata.planModeEnabled === 'boolean') return metadata.planModeEnabled;
  if (typeof metadata.includePlanTool === 'boolean') return metadata.includePlanTool;
  if (typeof metadata.mode === 'string' && metadata.mode.trim().toLowerCase() === 'plan') return true;
  return undefined;
}

function extractContextHistoryMetadata(
  providedHistory:
    | Array<{
      metadata?: Record<string, unknown>;
    }>
    | null
    | undefined,
): Record<string, unknown> | undefined {
  if (!Array.isArray(providedHistory) || providedHistory.length === 0) return undefined;
  for (let index = providedHistory.length - 1; index >= 0; index -= 1) {
    const metadata = providedHistory[index]?.metadata;
    if (!metadata || typeof metadata !== 'object') continue;
    const source = typeof metadata.contextBuilderHistorySource === 'string'
      ? metadata.contextBuilderHistorySource
      : undefined;
    const bypassed = typeof metadata.contextBuilderBypassed === 'boolean'
      ? metadata.contextBuilderBypassed
      : undefined;
    const bypassReason = typeof metadata.contextBuilderBypassReason === 'string'
      ? metadata.contextBuilderBypassReason
      : undefined;
    const rebuilt = typeof metadata.contextBuilderRebuilt === 'boolean'
      ? metadata.contextBuilderRebuilt
      : undefined;
    if (source || bypassed !== undefined || bypassReason || rebuilt !== undefined) {
      return {
        ...(source ? { contextHistorySource: source } : {}),
        ...(bypassed !== undefined ? { contextBuilderBypassed: bypassed } : {}),
        ...(bypassReason ? { contextBuilderBypassReason: bypassReason } : {}),
        ...(rebuilt !== undefined ? { contextBuilderRebuilt: rebuilt } : {}),
      };
    }
  }
  return undefined;
}

function resolveReviewTools(tools: string[]): string[] {
  return tools.filter((tool) => REVIEW_READONLY_TOOLS.has(tool));
}

function buildReviewModePrompt(): string {
  return [
    '你是独立的审核代理（reviewer），运行在隔离上下文中。',
    '审核目标：验证“主模型声明”是否有可复现证据支撑，不能凭主模型自述直接放行。',
    '你必须优先使用只读工具在当前 cwd 做核验（读文件、执行只读 shell、查看图片、必要时网络检索）。',
    '禁止任何写入、修改、删除类操作。',
    '若证据不足、结论不确定、或关键声明未被验证，一律 `passed=false` 并给出可执行修正建议。',
    '当且仅当主线目标满足（或 strict 模式下全部要求满足）且有证据时，才可 `passed=true`。',
    '如仓库存在 AGENTS.md/agents.md，必须先读取并遵守其中约束再审查。',
    '输出必须是 JSON 对象，字段：',
    '- passed: boolean',
    '- score: number (0-100，可选)',
    '- feedback: string（简明可执行）',
    '- blockers: string[]（可选）',
    '- evidence: string[]（可选，列出命令输出/文件路径/关键观察）',
    '禁止输出 markdown 代码块；仅输出 JSON。',
  ].join('\n');
}

function buildReviewSystemPrompt(basePrompt?: string): string {
  const reviewPrompt = buildReviewModePrompt();
  const normalizedBase = basePrompt?.trim();
  if (!normalizedBase) return reviewPrompt;
  return [
    normalizedBase,
    '',
    '[Review Mode Override]',
    '当前为独立 Review 线程。若与基础提示词有冲突，以本段 Review 规则优先。',
    reviewPrompt,
  ].join('\n');
}

function buildReviewTurnInput(params: {
  target: string;
  strictness: 'strict' | 'mainline';
  cwd: string;
  userInput: string;
  assistantOutput: string;
  assistantMetadata?: Record<string, unknown>;
}): string {
  const strictnessText = params.strictness === 'strict' ? '必须完全合格' : '主线合格即可';
  const executionEvidence = buildMainOutputEvidenceSnapshot(params.assistantMetadata);
  return [
    '[Review Request]',
    `Review目标: ${params.target}`,
    `审核标准: ${strictnessText}`,
    `工作目录(cwd): ${params.cwd}`,
    '请在该 cwd 下核查主模型声明是否成立，必要时调用只读工具获取证据。',
    '若无法验证或证据不足，必须判定不通过并给出修正建议。',
    '',
    '[用户输入]',
    params.userInput,
    '',
    '[主模型声明]',
    params.assistantOutput,
    ...(executionEvidence ? ['', '[主模型执行摘要]', executionEvidence] : []),
    '',
    '请返回 JSON：{"passed":boolean,"score":number,"feedback":"...","blockers":["..."],"evidence":["..."]}',
  ].join('\n');
}

function buildReviewFeedbackInput(params: {
  target: string;
  strictness: 'strict' | 'mainline';
  feedback: string;
}): string {
  const strictnessText = params.strictness === 'strict' ? '必须完全合格' : '主线合格即可';
  return [
    '[Review Feedback]',
    `Review目标: ${params.target}`,
    `审核标准: ${strictnessText}`,
    '',
    '审查未通过，请根据以下审查意见继续修正并给出新的完整答复：',
    params.feedback,
  ].join('\n');
}

function parseReviewVerdict(raw: string): ReviewVerdict {
  const trimmed = raw.trim();
  const jsonCandidate = extractJsonObject(trimmed);
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate);
      if (isRecord(parsed)) {
        const passed = resolveReviewPassed(parsed);
        const feedback = resolveReviewFeedback(parsed, trimmed);
        const score = typeof parsed.score === 'number' && Number.isFinite(parsed.score)
          ? parsed.score
          : undefined;
        return {
          passed,
          feedback,
          ...(typeof score === 'number' ? { score } : {}),
        };
      }
    } catch {
      // fall through
    }
  }

  const match = trimmed.match(/(?:"passed"|'passed'|passed)\s*[:=]\s*(true|false)/i);
  if (match) {
    return {
      passed: match[1].toLowerCase() === 'true',
      feedback: trimmed,
    };
  }

  return {
    passed: false,
    feedback: trimmed.length > 0 ? trimmed : 'Review 未返回可解析结果',
  };
}

function resolveReviewPassed(parsed: Record<string, unknown>): boolean {
  if (typeof parsed.passed === 'boolean') return parsed.passed;
  if (typeof parsed.pass === 'boolean') return parsed.pass;
  if (typeof parsed.approved === 'boolean') return parsed.approved;
  if (typeof parsed.verdict === 'string') {
    const verdict = parsed.verdict.trim().toLowerCase();
    if (verdict === 'pass' || verdict === 'passed' || verdict === 'approve' || verdict === 'approved') return true;
    if (verdict === 'fail' || verdict === 'failed' || verdict === 'reject' || verdict === 'rejected') return false;
  }
  return false;
}

function resolveReviewFeedback(parsed: Record<string, unknown>, fallback: string): string {
  if (typeof parsed.feedback === 'string' && parsed.feedback.trim().length > 0) return parsed.feedback.trim();
  if (typeof parsed.comments === 'string' && parsed.comments.trim().length > 0) return parsed.comments.trim();
  if (Array.isArray(parsed.suggestions)) {
    const suggestions = parsed.suggestions
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (suggestions.length > 0) {
      return `修正建议:\n- ${suggestions.join('\n- ')}`;
    }
  }
  if (Array.isArray(parsed.blockers)) {
    const blockers = parsed.blockers
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (blockers.length > 0) {
      return `阻塞项:\n- ${blockers.join('\n- ')}`;
    }
  }
  return fallback;
}

function buildMainOutputEvidenceSnapshot(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) return undefined;
  const lines: string[] = [];

  if (Array.isArray(metadata.tool_trace)) {
    const trace = metadata.tool_trace
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .slice(-6);
    if (trace.length > 0) {
      lines.push(`tool_trace_count=${trace.length}`);
      for (const item of trace) {
        const tool = typeof item.tool === 'string' ? item.tool : 'unknown';
        const status = item.status === 'error' ? 'error' : 'ok';
        const duration = typeof item.duration_ms === 'number' ? `${Math.round(item.duration_ms)}ms` : 'n/a';
        lines.push(`- ${tool} | ${status} | ${duration}`);
      }
    }
  }

  if (Array.isArray(metadata.round_trace) && metadata.round_trace.length > 0) {
    const lastRound = metadata.round_trace
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .slice(-1)[0];
    if (lastRound) {
      const round = typeof lastRound.round === 'number' ? Math.floor(lastRound.round) : undefined;
      const finishReason = typeof lastRound.finish_reason === 'string' ? lastRound.finish_reason : undefined;
      const responseStatus = typeof lastRound.response_status === 'string' ? lastRound.response_status : undefined;
      const totalTokens = typeof lastRound.total_tokens === 'number' ? Math.floor(lastRound.total_tokens) : undefined;
      const summary = [
        ...(round !== undefined ? [`round=${round}`] : []),
        ...(finishReason ? [`finish=${finishReason}`] : []),
        ...(responseStatus ? [`status=${responseStatus}`] : []),
        ...(totalTokens !== undefined ? [`total_tokens=${totalTokens}`] : []),
      ];
      if (summary.length > 0) {
        lines.push(`last_round: ${summary.join(', ')}`);
      }
    }
  }

  return lines.length > 0 ? lines.join('\n') : undefined;
}

function resolveReviewCwd(metadata?: Record<string, unknown>): string {
  if (typeof metadata?.cwd === 'string' && metadata.cwd.trim().length > 0) return metadata.cwd.trim();
  return process.cwd();
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

function buildStructuredOutputRetryInput(params: {
  originalUserInput: string;
  previousReply: string;
  schema: Record<string, unknown>;
  issues: Array<{ path: string; message: string }>;
  parseFailure: boolean;
}): string {
  return [
    '[STRUCTURED OUTPUT RETRY]',
    'Your previous answer did not satisfy the required structured output contract.',
    params.parseFailure
      ? 'Problem: JSON could not be parsed. Resend one valid JSON object only.'
      : ['Problem: schema validation failed. Resend one valid JSON object only.', formatStructuredOutputIssues(params.issues)].join('\n'),
    '',
    '[Original User Input]',
    params.originalUserInput,
    '',
    '[Previous Reply]',
    params.previousReply,
    '',
    '[Required JSON Schema]',
    JSON.stringify(params.schema, null, 2),
    '',
    'Return only corrected JSON. Do not include markdown fences or extra explanation.',
  ].join('\n');
}

function resolveStructuredOutputRetryMaxAttempts(metadata?: Record<string, unknown>): number {
  const raw = metadata?.structuredOutputRetryMaxAttempts
    ?? metadata?.structured_output_retry_max_attempts
    ?? metadata?.responsesStructuredOutputRetryMaxAttempts;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, Math.floor(raw));
  }
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return DEFAULT_STRUCTURED_OUTPUT_RETRY_MAX_ATTEMPTS;
}

function resolveStructuredOutputRetryAttemptCount(metadata?: Record<string, unknown>): number {
  const raw = metadata?.structuredOutputRetryAttempt ?? metadata?.structured_output_retry_attempt;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return metadata?.structuredOutputRetryApplied === true ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export default KernelAgentBase;
