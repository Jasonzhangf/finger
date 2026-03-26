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

    // Intercept user request and write to CACHE.md
    await this.cacheMemoryInterceptor.interceptRequest(input);

    try {
      const { session, responseSessionId } = await this.resolveSession(input);
      const clientPersist = input.metadata?.sessionPersistence === 'client'
        || input.metadata?.session_persistence === 'client'
        || input.metadata?.persistSession === false;
      if (input.sessionId && !clientPersist) {
        await this.sessionManager.addMessage(session.id, {
          role: 'user',
          content: input.text,
          metadata: input.metadata,
        });
      }

      const contextHistorySessionId = responseSessionId || input.sessionId || session.id;
      const providedHistory = this.config.contextHistoryProvider
        ? await this.config.contextHistoryProvider(contextHistorySessionId, this.config.maxContextMessages)
        : null;
      const contextHistoryMetadata = extractContextHistoryMetadata(providedHistory);
      const history = Array.isArray(providedHistory)
        ? providedHistory.map((item, idx) => ({
            id: item.id ?? `ctx-${Date.now()}-${idx}`,
            role: item.role,
            content: item.content,
            timestamp: item.timestamp ?? new Date().toISOString(),
            metadata: item.metadata,
          }))
        : await this.sessionManager.getMessageHistory(session.id, this.config.maxContextMessages);
      const mergedHistory = mergeHistory(history, input.history, this.config.maxContextMessages);
      const roleProfile = this.resolveRoleProfile(input.roleProfile);
      const threadMode = this.resolveThreadMode(input.metadata);
      const runnerSessionId = responseSessionId || session.id;
      const threadKey = this.resolveThreadKey(runnerSessionId, threadMode);
      const tools = this.resolveTools(input.tools, roleProfile, input.metadata);
      const contextSlots = composeTurnContextSlots({
        cacheKey: session.id,
        userInput: input.text,
        history: toUnifiedHistory(mergedHistory),
        tools,
        metadata: input.metadata,
      });
      const systemPrompt = this.buildSystemPrompt(
        roleProfile,
        this.config.appendContextSlotsToSystemPrompt === false ? undefined : contextSlots?.rendered,
      );
      const slotMetadata = contextSlots
        ? {
            contextSlotIds: contextSlots.slotIds,
            contextSlotTrimmedIds: contextSlots.trimmedSlotIds,
          }
        : undefined;
      const runtimeMetadata = this.buildRuntimeMetadata({
        inputMetadata: input.metadata,
        roleProfileId: roleProfile?.id,
        mode: threadMode,
        threadKey,
        slotMetadata,
        extra: contextHistoryMetadata,
        contextSlotsRendered:
          this.config.appendContextSlotsToSystemPrompt === false
            ? contextSlots?.rendered
            : undefined,
      });

      const inputItems = this.parseInputItems(input.metadata);
      const mailboxSnapshot = this.parseMailboxSnapshot(input.metadata?.mailboxSnapshot);
      const runnerContext = {
        sessionId: runnerSessionId,
        systemPrompt,
        history: toUnifiedHistory(mergedHistory),
        tools,
        metadata: runtimeMetadata,
        ...(mailboxSnapshot ? { mailboxSnapshot } : {}),
      };
      let runResult = await this.runner.runTurn(input.text, inputItems, runnerContext);

      this.captureApiHistory(threadKey, runResult.metadata);
      const pendingInputAccepted = runResult.metadata?.pendingInputAccepted === true;
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
        inputMetadata: input.metadata,
        runtimeMetadata,
        roleProfileId: roleProfile?.id ?? input.roleProfile,
        threadKey,
        current: runResult,
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

  private buildRuntimeMetadata(params: {
    inputMetadata: Record<string, unknown> | undefined;
    roleProfileId: string | undefined;
    mode: string;
    threadKey: string;
    sessionProjectPath?: string;
    slotMetadata?: Record<string, unknown>;
    contextSlotsRendered?: string;
    extra?: Record<string, unknown>;
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

    const existingApiHistory = this.apiHistoryByThread.get(params.threadKey);
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
    const reviewTools = resolveReviewTools(params.tools);
    const reviewSystemPrompt = buildReviewSystemPrompt(this.buildSystemPrompt(this.resolveRoleProfile(params.roleProfileId)));
    const reviewCwd = resolveReviewCwd(params.input.metadata);

    // Track review started
    const reviewStartMetadata = this.buildRuntimeMetadata({
      inputMetadata: params.input.metadata,
      roleProfileId: params.roleProfileId,
      mode: REVIEW_MODE,
      threadKey: reviewThreadKey,
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
    this.captureApiHistory(reviewThreadKey, reviewStartMetadata);

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
      this.captureApiHistory(reviewThreadKey, reviewResult.metadata);

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
      this.captureApiHistory(params.mainThreadKey, followup.metadata);
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

  private captureApiHistory(threadKey: string, metadata?: Record<string, unknown>): void {
    if (!metadata) return;
    const raw = metadata.api_history;
    if (!Array.isArray(raw)) return;
    const normalized = raw.filter((item) => typeof item === 'object' && item !== null);
    this.apiHistoryByThread.set(threadKey, normalized);
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
    this.captureApiHistory(params.threadKey, followUpResult.metadata);
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
      this.captureApiHistory(params.threadKey, retried.metadata);

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
