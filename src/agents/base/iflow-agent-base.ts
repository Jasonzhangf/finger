import { logger } from '../../core/logger.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { BaseSessionAgent, type AgentContext, type BaseSessionAgentConfig } from './base-session-agent.js';
import { IflowSessionManager } from '../chat/iflow-session-manager.js';
import {
  type ISessionManager,
  type Session,
  type SessionMessage,
  SessionStatus,
  setGlobalSessionManager,
} from '../chat/session-types.js';
import {
  mergeHistory,
  parseUnifiedAgentInput,
  type UnifiedAgentInput,
  type UnifiedAgentOutput,
  type UnifiedAgentRoleProfile,
} from './unified-agent-types.js';
import { composeTurnContextSlots } from './context-slots.js';

const log = logger.module('IflowAgentBase');

export interface IflowAgentBaseConfig extends BaseSessionAgentConfig {
  provider?: string;
  roleProfiles?: Record<string, UnifiedAgentRoleProfile>;
}

interface UnifiedTurnContext {
  session: Session;
  input: UnifiedAgentInput;
  history: SessionMessage[];
  roleProfile?: UnifiedAgentRoleProfile;
  tools: string[];
  systemPrompt?: string;
}

export abstract class IflowAgentBase extends BaseSessionAgent {
  protected readonly provider: string;
  protected readonly roleProfiles: Record<string, UnifiedAgentRoleProfile>;
  protected readonly localSessionManager: IflowSessionManager;

  private localSessionReady = false;

  constructor(config: IflowAgentBaseConfig) {
    super(config);
    this.provider = config.provider ?? 'iflow';
    this.roleProfiles = config.roleProfiles ?? {};
    this.localSessionManager = new IflowSessionManager();
  }

  override async initializeHub(hub: MessageHub, sessionManager?: ISessionManager): Promise<void> {
    const manager = sessionManager ?? this.localSessionManager;
    await super.initializeHub(hub, manager);
  }

  protected async prepareSessionManager(): Promise<void> {
    const manager = this.sessionManager ?? this.localSessionManager;
    if (manager === this.localSessionManager && !this.localSessionReady) {
      await this.localSessionManager.initialize();
      this.localSessionReady = true;
      log.info('Local iFlow session manager initialized');
    }
    setGlobalSessionManager(manager);
  }

  protected registerUnifiedHandlers(hub: MessageHub, moduleId = this.config.id): void {
    hub.registerInput(moduleId, async (message: unknown) => {
      const result = await this.handleUnifiedTurn(moduleId, message);
      return { success: result.success, result };
    });

    hub.registerOutput(moduleId, async (message: unknown) => {
      const result = await this.handleUnifiedTurn(moduleId, message);
      return result;
    });

    log.info('Unified handlers registered', { moduleId, provider: this.provider });
  }

  protected override async handleMessage(input: unknown, _context: AgentContext): Promise<unknown> {
    return this.handleUnifiedTurn(this.config.id, input);
  }

  protected async handleUnifiedTurn(moduleId: string, message: unknown): Promise<UnifiedAgentOutput> {
    const startedAt = Date.now();
    const input = parseUnifiedAgentInput(message);

    if (!input) {
      return {
        success: false,
        error: 'No input text provided',
        module: moduleId,
        provider: this.provider,
        sessionId: 'unknown',
        latencyMs: Date.now() - startedAt,
      };
    }

    const manager = this.getSessionManager();
    try {
      const session = await this.resolveSession(manager, input);
      await manager.addMessage(session.id, {
        role: 'user',
        content: input.text,
        metadata: input.metadata,
      });

      const sessionHistory = await manager.getMessageHistory(session.id, this.config.maxContextMessages);
      const mergedHistory = mergeHistory(sessionHistory, input.history, this.config.maxContextMessages ?? 20);
      const roleProfile = this.resolveRoleProfile(input.roleProfile);
      const tools = this.resolveTools(input.tools, roleProfile);
      const contextSlots = composeTurnContextSlots({
        cacheKey: session.id,
        userInput: input.text,
        history: mergedHistory.map((item) => ({
          role: item.role,
          content: item.content,
        })),
        tools,
        metadata: input.metadata,
      });
      const systemPrompt = this.buildSystemPrompt(roleProfile, contextSlots?.rendered);

      const response = await this.generateAssistantResponse({
        session,
        input,
        history: mergedHistory,
        roleProfile,
        tools,
        systemPrompt,
      });

      const assistantMessage = await manager.addMessage(session.id, {
        role: 'assistant',
        content: response,
        metadata: {
          roleProfile: roleProfile?.id,
          tools,
          ...(contextSlots
            ? {
                contextSlotIds: contextSlots.slotIds,
                contextSlotTrimmedIds: contextSlots.trimmedSlotIds,
              }
            : {}),
        },
      });

      return {
        success: true,
        response,
        module: moduleId,
        provider: this.provider,
        sessionId: session.id,
        messageId: assistantMessage.id,
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
        },
      };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: messageText,
        module: moduleId,
        provider: this.provider,
        sessionId: input.sessionId ?? 'unknown',
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  protected async generateAssistantResponse(context: UnifiedTurnContext): Promise<string> {
    return this.callLLM(context.input.text, context.systemPrompt, context.history);
  }

  protected getSessionManager(): ISessionManager {
    return this.sessionManager ?? this.localSessionManager;
  }

  protected async resolveSession(manager: ISessionManager, input: UnifiedAgentInput): Promise<Session> {
    if (input.createNewSession || !input.sessionId) {
      return manager.createSession({
        title: input.text.substring(0, 50) || '新对话',
        metadata: input.metadata,
      });
    }

    const existing = await manager.getSession(input.sessionId);
    if (existing) return existing;

    return manager.createSession({
      title: input.text.substring(0, 50) || '新对话',
      metadata: input.metadata,
    });
  }

  protected resolveRoleProfile(roleProfileId?: string): UnifiedAgentRoleProfile | undefined {
    if (!roleProfileId) return undefined;
    return this.roleProfiles[roleProfileId];
  }

  protected resolveTools(inputTools: string[] | undefined, roleProfile?: UnifiedAgentRoleProfile): string[] {
    const roleTools = roleProfile?.allowedTools ?? [];
    if (!inputTools || inputTools.length === 0) return roleTools;
    if (roleTools.length === 0) return Array.from(new Set(inputTools));
    return Array.from(new Set(inputTools.filter((item) => roleTools.includes(item))));
  }

  protected buildSystemPrompt(roleProfile?: UnifiedAgentRoleProfile, slotPrompt?: string): string | undefined {
    const basePrompt = this.resolvePrompt(this.config.systemPrompt);
    const rolePrompt = this.resolvePrompt(roleProfile?.systemPrompt, roleProfile?.systemPromptResolver);
    const combined = !rolePrompt ? basePrompt : !basePrompt ? rolePrompt : `${basePrompt}\n\n[角色约束]\n${rolePrompt}`;
    if (!slotPrompt) return combined;
    if (!combined) return slotPrompt;
    return `${combined}\n\n${slotPrompt}`;
  }

  protected resolvePrompt(prompt?: string, resolver?: () => string | undefined): string | undefined {
    const resolved = resolver?.();
    if (resolved && resolved.trim().length > 0) return resolved.trim();
    if (!prompt) return undefined;
    const normalized = prompt.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  async createSession(title?: string): Promise<Session> {
    const manager = this.getSessionManager();
    return manager.createSession({ title });
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.getSessionManager().getSession(sessionId);
  }

  async listSessions(): Promise<Session[]> {
    return this.getSessionManager().querySessions({ status: SessionStatus.ACTIVE });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.getSessionManager().deleteSession(sessionId);
  }
}

export default IflowAgentBase;
