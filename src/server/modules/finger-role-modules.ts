import type { ModuleRegistry } from '../../orchestration/module-registry.js';
import { logger } from '../../core/logger.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { ChatCodexRunnerController } from './mock-runtime.js';
import { createFingerGeneralModule, type ChatCodexLoopEvent } from '../../agents/finger-general/finger-general-module.js';
import type { ChatCodexDeveloperRole } from '../../agents/chat-codex/developer-prompt-templates.js';
import { buildContext } from '../../runtime/context-builder.js';
import { loadContextBuilderSettings } from '../../core/user-settings.js';

export type FingerRoleProfile = 'project' | 'reviewer' | 'system';

export interface FingerRoleSpec {
  id: string;
  roleProfile: FingerRoleProfile;
  allowedTools: string[];
}

export interface RegisterFingerRoleModulesDeps {
  moduleRegistry: ModuleRegistry;
  runtime: RuntimeFacade;
  toolRegistry: ToolRegistry;
  chatCodexRunner: ChatCodexRunnerController;
  daemonUrl: string;
  onLoopEvent: (event: ChatCodexLoopEvent) => void;
  resolveSessionLedgerRoot?: (session: { id: string; projectPath: string }) => string | undefined;
}

export interface LegacyAliasOptions {
  enableLegacyChatCodexAlias: boolean;
  legacyAgentId: string;
  legacyAllowedTools: string[];
}

function hasMediaInputInMessage(message: { metadata?: Record<string, unknown> } | null | undefined): boolean {
  if (!message?.metadata || typeof message.metadata !== 'object') return false;
  const inputItems = (message.metadata as Record<string, unknown>).inputItems;
  if (!Array.isArray(inputItems)) return false;
  return inputItems.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const type = (item as { type?: unknown }).type;
    return type === 'image' || type === 'local_image';
  });
}

function resolveLatestUserPrompt(
  messages: Array<{ role: string; content: string }> | undefined,
): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item.role !== 'user') continue;
    const text = typeof item.content === 'string' ? item.content.trim() : '';
    if (text.length > 0) return text;
  }
  return undefined;
}

function mapRawSessionMessages(
  messages: Array<{
    id?: string;
    role: string;
    content: string;
    timestamp?: string;
    metadata?: Record<string, unknown>;
  }>,
  limit: number,
  extraMetadata?: Record<string, unknown>,
): Array<{
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}> {
  const sliced = Number.isFinite(limit) && limit > 0
    ? messages.slice(-limit)
    : messages;
  return sliced
    .filter((item) => typeof item.content === 'string' && item.content.trim().length > 0)
    .map((item, index) => ({
      id: item.id ?? `raw-${Date.now()}-${index}`,
      role: item.role === 'assistant' || item.role === 'system' ? item.role : 'user',
      content: item.content,
      timestamp: item.timestamp ?? new Date().toISOString(),
      ...((item.metadata && typeof item.metadata === 'object') || (extraMetadata && typeof extraMetadata === 'object')
        ? { metadata: { ...(item.metadata ?? {}), ...(extraMetadata ?? {}) } }
        : {}),
    }));
}

export async function registerFingerRoleModules(
  deps: RegisterFingerRoleModulesDeps,
  roles: FingerRoleSpec[],
  legacy?: LegacyAliasOptions,
): Promise<void> {
  const { moduleRegistry, runtime, toolRegistry, chatCodexRunner, daemonUrl, onLoopEvent } = deps;

  const resolveDeveloperRole = (role: FingerRoleSpec): ChatCodexDeveloperRole => {
    if (role.roleProfile === 'reviewer') return 'reviewer';
    return 'orchestrator';
  };

  const resolvePromptOverrides = (agentId: string, role: FingerRoleSpec) => {
    const runtimeConfig = runtime.getAgentRuntimeConfig(agentId);
    const developerRole = resolveDeveloperRole(role);
    const systemPath = runtimeConfig?.prompts?.system?.trim();
    const developerPath = runtimeConfig?.prompts?.developer?.trim();
    return {
      ...(systemPath ? { codingPromptPath: systemPath } : {}),
      ...(developerPath
        ? {
            developerPromptPaths: {
              [developerRole]: developerPath,
            } as Partial<Record<ChatCodexDeveloperRole, string>>,
          }
        : {}),
    };
  };

  const resolveFingerToolSpecifications = async (toolNames: string[]) => {
    const resolved: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [];
    for (const name of toolNames) {
      const tool = toolRegistry.get(name);
      if (!tool || tool.policy !== 'allow') continue;

      // 确保 inputSchema 符合 OpenAI function calling 规范
      const schema = tool.inputSchema as Record<string, unknown>;
      const finalSchema: Record<string, unknown> = {
        type: schema?.type ?? 'object',
      };

      if (schema?.properties && typeof schema.properties === 'object') {
        finalSchema.properties = schema.properties;
      }

      if (schema?.required && Array.isArray(schema.required)) {
        finalSchema.required = schema.required;
      }

      if (schema?.additionalProperties !== undefined) {
        finalSchema.additionalProperties = schema.additionalProperties;
      }

      resolved.push({
        name: tool.name,
        description: tool.description,
        inputSchema: finalSchema,
      });
    }
    return resolved;
  };

  const registerFingerRoleModule = async (role: FingerRoleSpec): Promise<void> => {
    const contextHistoryProvider = async (sessionId: string, limit: number) => {
      const settings = loadContextBuilderSettings();
      if (!settings.enabled) {
        // Disabled => signal fallback to traditional in-memory history path
        logger.module('finger-role-modules').info('Context builder disabled, fallback to session history', {
          roleId: role.id,
          sessionId,
        });
        return null;
      }

      const session = runtime.getSession(sessionId);
      if (!session) return [];
      const sessionMessages = Array.isArray((session as { messages?: unknown }).messages)
        ? ((session as { messages?: Array<{
          id?: string;
          role: string;
          content: string;
          timestamp?: string;
          metadata?: Record<string, unknown>;
        }> }).messages ?? [])
        : [];

      const latestMessage = sessionMessages.length > 0 ? sessionMessages[sessionMessages.length - 1] : null;
      const hasMediaInput = hasMediaInputInMessage(latestMessage);
      if (hasMediaInput) {
        // Media turn: keep raw session order, do not rewrite context via context builder.
        const mapped = mapRawSessionMessages(sessionMessages, limit, {
          contextBuilderHistorySource: 'raw_session',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'media_turn',
          contextBuilderRebuilt: false,
        });
        logger.module('finger-role-modules').info('Context builder bypassed for media turn', {
          roleId: role.id,
          sessionId,
          rawMessageCount: sessionMessages.length,
          selectedCount: mapped.length,
        });
        return mapped;
      }

      const sessionContext = (session.context ?? {}) as Record<string, unknown>;
      const agentId = typeof sessionContext.ownerAgentId === 'string' && sessionContext.ownerAgentId.trim().length > 0
        ? sessionContext.ownerAgentId
        : role.id;
      const rootDir = deps.resolveSessionLedgerRoot
        ? deps.resolveSessionLedgerRoot({ id: session.id, projectPath: session.projectPath })
        : undefined;

      const built = await buildContext(
        {
          rootDir,
          sessionId,
          agentId,
          mode: 'main',
          currentPrompt: resolveLatestUserPrompt(sessionMessages),
        },
        {
          targetBudget: 1_000_000,
          buildMode: settings.mode,
          includeMemoryMd: settings.includeMemoryMd,
          enableTaskGrouping: true,
          enableModelRanking: settings.enableModelRanking,
          rankingProviderId: settings.rankingProviderId,
          timeWindow: {
            nowMs: Date.now(),
            halfLifeMs: settings.halfLifeMs,
            overThresholdRelevance: settings.overThresholdRelevance,
          },
        },
      );

      const sliced = Number.isFinite(limit) && limit > 0
        ? built.messages.slice(-limit)
        : built.messages;

      const mapped = sliced.map((m) => ({
        id: m.messageId || m.id,
        role: m.role === 'orchestrator' ? 'assistant' as const : m.role,
        content: m.content,
        timestamp: m.timestampIso,
        metadata: {
          ...(m.metadata ?? {}),
          ...(m.attachments ? { attachments: m.attachments } : {}),
          ...(m.messageId ? { messageId: m.messageId } : {}),
          contextBuilderHistorySource: 'context_builder',
          contextBuilderBypassed: false,
          contextBuilderRebuilt: true,
        },
      }));
      logger.module('finger-role-modules').info('Context builder rebuilt session history', {
        roleId: role.id,
        sessionId,
        selectedCount: mapped.length,
        mode: settings.mode,
      });
      return mapped;
    };

    const roleModule = createFingerGeneralModule({
      id: role.id,
      name: role.id,
      roleProfile: role.roleProfile,
      ...resolvePromptOverrides(role.id, role),
      resolvePromptPaths: () => resolvePromptOverrides(role.id, role),
      resolveToolSpecifications: resolveFingerToolSpecifications,
      toolExecution: {
        daemonUrl,
        agentId: role.id,
      },
      onLoopEvent,
      contextHistoryProvider,
    }, chatCodexRunner);
    await moduleRegistry.register(roleModule);
    const policy = runtime.setAgentToolWhitelist(role.id, role.allowedTools);
    logger.module('finger-role-modules').info('Role module registered', { roleId: role.id, tools: policy.whitelist.join(', ') });
  };

  for (const role of roles) {
    await registerFingerRoleModule(role);
  }

  if (legacy?.enableLegacyChatCodexAlias) {
    const legacyChatCodexAlias = createFingerGeneralModule({
      id: legacy.legacyAgentId,
      name: legacy.legacyAgentId,
      roleProfile: 'project',
      ...resolvePromptOverrides(legacy.legacyAgentId, {
        id: legacy.legacyAgentId,
        roleProfile: 'project',
        allowedTools: legacy.legacyAllowedTools,
      }),
      resolvePromptPaths: () =>
        resolvePromptOverrides(legacy.legacyAgentId, {
          id: legacy.legacyAgentId,
          roleProfile: 'project',
          allowedTools: legacy.legacyAllowedTools,
        }),
      resolveToolSpecifications: resolveFingerToolSpecifications,
      toolExecution: {
        daemonUrl,
        agentId: legacy.legacyAgentId,
      },
      onLoopEvent,
    }, chatCodexRunner);
    await moduleRegistry.register(legacyChatCodexAlias);
    runtime.setAgentToolWhitelist(legacy.legacyAgentId, legacy.legacyAllowedTools);
  }
}
