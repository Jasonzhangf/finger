import type { ModuleRegistry } from '../../orchestration/module-registry.js';
import { logger } from '../../core/logger.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { ChatCodexRunnerController } from './mock-runtime.js';
import { createFingerGeneralModule, type ChatCodexLoopEvent } from '../../agents/finger-general/finger-general-module.js';
import type { ChatCodexDeveloperRole } from '../../agents/chat-codex/developer-prompt-templates.js';
import { buildContext } from '../../runtime/context-builder.js';
import { loadContextBuilderSettings } from '../../core/user-settings.js';
import {
  consumeContextBuilderOnDemandView,
  shouldRunContextBuilderBootstrapOnce,
} from '../../runtime/context-builder-on-demand-state.js';
import {
  buildContextBuilderHistoryIndex,
  buildNextIndexedHistoryIndex,
  buildIndexedHistoryFromSnapshot,
  extractPinnedMessageIdsFromSessionContext,
  persistContextBuilderHistoryIndex,
  readPersistedContextBuilderHistoryIndex,
} from './context-builder-history-index.js';
import { join, isAbsolute } from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';

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

type RuntimePromptConfig = {
  prompts?: {
    system?: string;
    developer?: string;
  };
};

function resolveRolePromptOverridesFromConfig(
  runtimeConfig: RuntimePromptConfig | undefined | null,
  role: FingerRoleSpec,
  developerRole: ChatCodexDeveloperRole,
  agentId: string,
): {
  developerPromptPath?: string;
  developerPromptPaths?: Partial<Record<ChatCodexDeveloperRole, string>>;
} {
  const systemPath = runtimeConfig?.prompts?.system?.trim();
  const developerPath = runtimeConfig?.prompts?.developer?.trim();

  // Prompt convergence rule:
  // - Keep coding/system prompt on the shared Codex general prompt track.
  // - Finger system prompt should be injected as developer prompt (not system field).
  const effectiveDeveloperPath = role.roleProfile === 'system'
    ? (systemPath && systemPath.length > 0 ? systemPath : developerPath)
    : developerPath;

  if (!effectiveDeveloperPath || effectiveDeveloperPath.length === 0) {
    return {};
  }

  // Resolve relative paths against the agent's runtime directory
  const agentDir = join(FINGER_PATHS.runtime.agentsDir, agentId);
  const resolvedPath = isAbsolute(effectiveDeveloperPath)
    ? effectiveDeveloperPath
    : join(agentDir, effectiveDeveloperPath);

  return {
    developerPromptPath: resolvedPath,
    developerPromptPaths: {
      [developerRole]: resolvedPath,
    } as Partial<Record<ChatCodexDeveloperRole, string>>,
  };
}

function hasMediaInputInMessage(
  message: {
    metadata?: Record<string, unknown>;
    attachments?: unknown[];
  } | null | undefined,
): boolean {
  if (!message) return false;
  const directAttachments = Array.isArray(message.attachments) ? message.attachments : [];
  const metadataAttachments = Array.isArray(message.metadata?.attachments)
    ? message.metadata.attachments as unknown[]
    : [];
  const allAttachments = [...directAttachments, ...metadataAttachments];
  if (allAttachments.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const attachment = item as Record<string, unknown>;
    const kind = typeof attachment.kind === 'string' ? attachment.kind : '';
    const mimeType = typeof attachment.mimeType === 'string' ? attachment.mimeType : '';
    const type = typeof attachment.type === 'string' ? attachment.type : '';
    return kind === 'image'
      || mimeType.startsWith('image/')
      || type === 'image';
  })) {
    return true;
  }

  const inputItems = message.metadata?.inputItems;
  if (!Array.isArray(inputItems)) return false;
  return inputItems.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const type = (item as { type?: unknown }).type;
    return type === 'image' || type === 'local_image';
  });
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
    const runtimeConfig = runtime.getAgentRuntimeConfig(agentId) ?? undefined;
    const developerRole = resolveDeveloperRole(role);
    const promptOverrides = resolveRolePromptOverridesFromConfig(runtimeConfig, role, developerRole, agentId);
    return {
      ...(promptOverrides.developerPromptPaths
        ? { developerPromptPaths: promptOverrides.developerPromptPaths }
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
      const session = runtime.getSession(sessionId);
      if (!session) {
        logger.module('finger-role-modules').warn('Context history session not found, fallback to session history', {
          roleId: role.id,
          sessionId,
        });
        return null;
      }
      const sessionMessages = runtime.getMessages(sessionId, 0);

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
      const persistedIndex = readPersistedContextBuilderHistoryIndex(sessionContext);
      const pinnedMessageIds = extractPinnedMessageIdsFromSessionContext(sessionContext);

      // 默认不自动重组，只在模型显式调用 context_builder.rebuild 后
      // 在下一轮消费一次按需重组视图。
      if (!settings.enabled) {
        const mapped = mapRawSessionMessages(sessionMessages, limit, {
          contextBuilderHistorySource: 'raw_session',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'context_builder_disabled',
          contextBuilderRebuilt: false,
        });
        logger.module('finger-role-modules').info('Context builder disabled, using raw session history', {
          roleId: role.id,
          sessionId,
          selectedCount: mapped.length,
        });
        return mapped;
      }

      const onDemand = consumeContextBuilderOnDemandView(sessionId, agentId);
      if (!onDemand) {
        if (persistedIndex) {
          const indexed = buildIndexedHistoryFromSnapshot(sessionMessages, persistedIndex, limit);
          if (indexed && indexed.messages.length > 0) {
            const indexedMapped = indexed.messages.map((message) => ({
              ...message,
              metadata: {
                ...(message.metadata ?? {}),
                contextBuilderHistorySource: 'context_builder_indexed',
                contextBuilderBypassed: false,
                contextBuilderRebuilt: false,
                contextBuilderIndexed: true,
                contextBuilderBuildMode: persistedIndex.buildMode,
                contextBuilderTargetBudget: persistedIndex.targetBudget,
                contextBuilderSelectedBlockCount: persistedIndex.selectedBlockIds.length,
                contextBuilderSelectedMessageCount: persistedIndex.selectedMessageIds.length,
                contextBuilderDeltaMessageCount: indexed.deltaCount,
                contextBuilderIndexAnchorMessageId: persistedIndex.anchorMessageId,
                contextBuilderIndexUpdatedAt: persistedIndex.updatedAt,
              },
            }));
            logger.module('finger-role-modules').info('Applied indexed context history from persisted snapshot', { roleId: role.id, sessionId, selectedCount: indexedMapped.length, selectedMessageCount: persistedIndex.selectedMessageIds.length, deltaCount: indexed.deltaCount, buildMode: persistedIndex.buildMode });
            persistContextBuilderHistoryIndex(runtime, sessionId, buildNextIndexedHistoryIndex(persistedIndex, indexedMapped));
            return indexedMapped;
          }
          logger.module('finger-role-modules').debug('Persisted context history index yielded no messages, fallback to bootstrap/raw', {
            roleId: role.id,
            sessionId,
            selectedMessageCount: persistedIndex.selectedMessageIds.length,
          });
        }

        if (shouldRunContextBuilderBootstrapOnce(sessionId, agentId)) {
          const configuredBudget = Number.isFinite(settings.historyBudgetTokens) && settings.historyBudgetTokens > 0
            ? Math.floor(settings.historyBudgetTokens)
            : 100000;
          const bootstrapped = await buildContext(
            {
              rootDir,
              sessionId,
              agentId,
              mode: 'main',
            },
            {
              targetBudget: configuredBudget,
              buildMode: settings.mode,
              includeMemoryMd: false,
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

          const bootstrappedSliced = Number.isFinite(limit) && limit > 0
            ? bootstrapped.messages.slice(-limit)
            : bootstrapped.messages;
          const bootstrappedMapped = bootstrappedSliced.map((message) => ({
            id: message.messageId || message.id,
            role: message.role === 'orchestrator' ? 'assistant' as const : message.role,
            content: message.content,
            timestamp: message.timestampIso,
            metadata: {
              ...(message.metadata ?? {}),
              ...(message.attachments ? { attachments: message.attachments } : {}),
              ...(message.messageId ? { messageId: message.messageId } : {}),
              ...(message.contextZone ? { contextZone: message.contextZone } : {}),
              contextBuilderHistorySource: 'context_builder_bootstrap',
              contextBuilderBypassed: false,
              contextBuilderRebuilt: true,
              contextBuilderOnDemand: false,
              contextBuilderBootstrap: true,
              contextBuilderBuildMode: settings.mode,
              contextBuilderTargetBudget: configuredBudget,
              contextBuilderSelectedBlockCount: bootstrapped.rankedTaskBlocks.length,
              contextBuilderAppliedAt: new Date().toISOString(),
            },
          }));
          if (bootstrappedMapped.length > 0) {
            const indexSnapshot = buildContextBuilderHistoryIndex(
              'context_builder_bootstrap',
              settings.mode,
              configuredBudget,
              bootstrapped.rankedTaskBlocks.map((block) => block.id),
              bootstrapped.messages,
              pinnedMessageIds.length > 0 ? { pinnedMessageIds } : undefined,
            );
            persistContextBuilderHistoryIndex(runtime, sessionId, indexSnapshot);
            logger.module('finger-role-modules').info('Applied one-time bootstrap context rebuild', { roleId: role.id, sessionId, selectedCount: bootstrappedMapped.length, mode: settings.mode, targetBudget: configuredBudget });
            return bootstrappedMapped;
          }

          logger.module('finger-role-modules').debug('Bootstrap rebuild yielded empty history, fallback to raw session', { roleId: role.id, sessionId });
        }
        const mapped = mapRawSessionMessages(sessionMessages, limit, {
          contextBuilderHistorySource: 'raw_session',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'on_demand_not_requested',
          contextBuilderRebuilt: false,
        });
        logger.module('finger-role-modules').debug('Context builder not requested, using raw session history', { roleId: role.id, sessionId, selectedCount: mapped.length });
        return mapped;
      }

      const sliced = Number.isFinite(limit) && limit > 0
        ? onDemand.messages.slice(-limit)
        : onDemand.messages;

      const mapped = sliced.map((message) => ({
        id: message.messageId || message.id,
        role: message.role === 'orchestrator' ? 'assistant' as const : message.role,
        content: message.content,
        timestamp: message.timestampIso,
        metadata: {
          ...(message.metadata ?? {}),
          ...(message.attachments ? { attachments: message.attachments } : {}),
          ...(message.messageId ? { messageId: message.messageId } : {}),
          ...(message.contextZone ? { contextZone: message.contextZone } : {}),
          contextBuilderHistorySource: 'context_builder_on_demand',
          contextBuilderBypassed: false,
          contextBuilderRebuilt: true,
          contextBuilderOnDemand: true,
          contextBuilderBuildMode: onDemand.buildMode,
          contextBuilderTargetBudget: onDemand.targetBudget,
          contextBuilderSelectedBlockCount: onDemand.selectedBlockIds.length,
          contextBuilderAppliedAt: onDemand.createdAt,
        },
      }));

      if (mapped.length === 0 && sessionMessages.length > 0) {
        const fallback = mapRawSessionMessages(sessionMessages, limit, {
          contextBuilderHistorySource: 'raw_session_fallback',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'empty_on_demand_result',
          contextBuilderRebuilt: false,
        });
        logger.module('finger-role-modules').warn('On-demand context builder returned empty history, fallback to raw session', { roleId: role.id, sessionId, rawMessageCount: sessionMessages.length, selectedCount: fallback.length, mode: onDemand.buildMode });
        return fallback;
      }

      const indexSnapshot = buildContextBuilderHistoryIndex(
        'context_builder_on_demand',
        onDemand.buildMode,
        onDemand.targetBudget,
        onDemand.selectedBlockIds,
        onDemand.messages,
        pinnedMessageIds.length > 0 ? { pinnedMessageIds } : undefined,
      );
      persistContextBuilderHistoryIndex(runtime, sessionId, indexSnapshot);

      logger.module('finger-role-modules').info('Applied on-demand context builder history', {
        roleId: role.id,
        sessionId,
        selectedCount: mapped.length,
        mode: onDemand.buildMode,
        targetBudget: onDemand.targetBudget,
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

export const __fingerRoleModulesInternals = {
  resolveRolePromptOverridesFromConfig,
};
