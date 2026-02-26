import type { Session, SessionMessage } from '../chat/session-types.js';
import { composeTurnContextSlots } from './context-slots.js';
import { MemorySessionManager } from './memory-session-manager.js';
import {
  mergeHistory,
  parseUnifiedAgentInput,
  type UnifiedAgentInput,
  type UnifiedAgentOutput,
  type UnifiedAgentRoleProfile,
  type UnifiedHistoryItem,
} from './unified-agent-types.js';

export interface KernelRunContext {
  sessionId: string;
  systemPrompt?: string;
  history: UnifiedHistoryItem[];
  tools: string[];
  metadata?: Record<string, unknown>;
}

export interface KernelRunnerResult {
  reply: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
}

export interface KernelAgentRunner {
  runTurn(text: string, context?: KernelRunContext): Promise<KernelRunnerResult>;
}

export interface KernelAgentBaseConfig {
  moduleId: string;
  provider: string;
  defaultSystemPrompt?: string;
  defaultSystemPromptResolver?: () => string | undefined;
  defaultRoleProfileId?: string;
  maxContextMessages: number;
  roleProfiles?: Record<string, UnifiedAgentRoleProfile>;
}

const DEFAULT_KERNEL_AGENT_CONFIG: Omit<KernelAgentBaseConfig, 'moduleId'> = {
  provider: 'kernel',
  defaultSystemPrompt: undefined,
  defaultRoleProfileId: undefined,
  maxContextMessages: 20,
  roleProfiles: {},
};

export class KernelAgentBase {
  private readonly config: KernelAgentBaseConfig;
  private readonly runner: KernelAgentRunner;
  private readonly sessionManager: MemorySessionManager;
  private readonly apiHistoryByThread = new Map<string, unknown[]>();
  private readonly externalSessionBindings = new Map<string, string>();
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

    try {
      const { session, responseSessionId } = await this.resolveSession(input);
      await this.sessionManager.addMessage(session.id, {
        role: 'user',
        content: input.text,
        metadata: input.metadata,
      });

      const history = await this.sessionManager.getMessageHistory(session.id, this.config.maxContextMessages);
      const mergedHistory = mergeHistory(history, input.history, this.config.maxContextMessages);
      const roleProfile = this.resolveRoleProfile(input.roleProfile);
      const threadMode = this.resolveThreadMode(input.metadata);
      const threadKey = `${session.id}:${threadMode}`;
      const tools = this.resolveTools(input.tools, roleProfile);
      const contextSlots = composeTurnContextSlots({
        cacheKey: session.id,
        userInput: input.text,
        history: toUnifiedHistory(mergedHistory),
        tools,
        metadata: input.metadata,
      });
      const systemPrompt = this.buildSystemPrompt(roleProfile, contextSlots?.rendered);
      const runtimeMetadata: Record<string, unknown> = {
        ...(input.metadata ?? {}),
        kernelMode: threadMode,
        contextLedgerEnabled: input.metadata?.contextLedgerEnabled !== false,
        contextLedgerAgentId:
          typeof input.metadata?.contextLedgerAgentId === 'string'
            ? input.metadata.contextLedgerAgentId
            : this.config.moduleId,
        contextLedgerRole:
          typeof input.metadata?.contextLedgerRole === 'string'
            ? input.metadata.contextLedgerRole
            : roleProfile?.id,
        contextLedgerCanReadAll:
          input.metadata?.contextLedgerCanReadAll === true || roleProfile?.id === 'orchestrator',
        contextLedgerFocusMaxChars:
          typeof input.metadata?.contextLedgerFocusMaxChars === 'number'
            ? input.metadata.contextLedgerFocusMaxChars
            : 20_000,
        contextLedgerFocusEnabled:
          input.metadata?.contextLedgerFocusEnabled !== false,
        ...(contextSlots
          ? {
              contextSlotIds: contextSlots.slotIds,
              contextSlotTrimmedIds: contextSlots.trimmedSlotIds,
            }
          : {}),
      };
      const existingApiHistory = this.apiHistoryByThread.get(threadKey);
      if (existingApiHistory && existingApiHistory.length > 0) {
        runtimeMetadata.kernelApiHistory = existingApiHistory;
      }

      const runResult = await this.runner.runTurn(input.text, {
        sessionId: session.id,
        systemPrompt,
        history: toUnifiedHistory(mergedHistory),
        tools,
        metadata: runtimeMetadata,
      });

      this.captureApiHistory(threadKey, runResult.metadata);

      const reply = runResult.reply?.trim();
      if (!reply) {
        throw new Error('chat-codex got empty model reply');
      }

      const assistantMessage = await this.sessionManager.addMessage(session.id, {
        role: 'assistant',
        content: reply,
        metadata: {
          roleProfile: roleProfile?.id,
          tools,
        },
      });

      return {
        success: true,
        response: reply,
        module: this.config.moduleId,
        provider: this.config.provider,
        sessionId: responseSessionId,
        messageId: runResult.messageId ?? assistantMessage.id,
        latencyMs: Date.now() - startedAt,
        metadata: {
          roleProfile: roleProfile?.id,
          tools,
          ...(contextSlots
            ? {
                contextSlotIds: contextSlots.slotIds,
                contextSlotTrimmedIds: contextSlots.trimmedSlotIds,
              }
            : {}),
          ...(runResult.metadata ?? {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
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

  private resolveRoleProfile(roleProfileId?: string): UnifiedAgentRoleProfile | undefined {
    const targetRoleProfileId = roleProfileId ?? this.config.defaultRoleProfileId;
    if (!targetRoleProfileId) return undefined;
    return this.config.roleProfiles?.[targetRoleProfileId];
  }

  private resolveTools(inputTools: string[] | undefined, roleProfile?: UnifiedAgentRoleProfile): string[] {
    const roleTools = roleProfile?.allowedTools ?? [];
    if (!inputTools || inputTools.length === 0) return roleTools;
    if (roleTools.length === 0) return Array.from(new Set(inputTools));
    return Array.from(new Set(inputTools.filter((item) => roleTools.includes(item))));
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

  private captureApiHistory(threadKey: string, metadata?: Record<string, unknown>): void {
    if (!metadata) return;
    const raw = metadata.api_history;
    if (!Array.isArray(raw)) return;
    const normalized = raw.filter((item) => typeof item === 'object' && item !== null);
    this.apiHistoryByThread.set(threadKey, normalized);
  }
}

function toUnifiedHistory(history: SessionMessage[]): UnifiedHistoryItem[] {
  return history.map((item) => ({
    role: item.role,
    content: item.content,
  }));
}

export default KernelAgentBase;
