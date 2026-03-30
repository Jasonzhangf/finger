import type { ModuleRegistry } from '../../orchestration/module-registry.js';
import { logger } from '../../core/logger.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { ChatCodexRunnerController } from './mock-runtime.js';
import { createFingerGeneralModule, type ChatCodexLoopEvent } from '../../agents/finger-general/finger-general-module.js';
import type { ChatCodexDeveloperRole } from '../../agents/chat-codex/developer-prompt-templates.js';
import { buildContext } from '../../runtime/context-builder.js';
import { loadContextBuilderSettings } from '../../core/user-settings.js';
import { estimateTokens } from '../../utils/token-counter.js';
import {
  consumeContextBuilderOnDemandView,
  shouldRunContextBuilderBootstrapOnce,
} from '../../runtime/context-builder-on-demand-state.js';
import {
  buildContextBuilderHistoryIndex,
  buildIndexedHistoryFromSnapshot,
  buildNextIndexedHistoryIndex,
  extractPinnedMessageIdsFromSessionContext,
  persistContextBuilderHistoryIndex,
  readPersistedContextBuilderHistoryIndex,
} from './context-builder-history-index.js';
import {
  augmentHistoryWithContinuityAnchors,
  extractRecentTaskMessages,
  extractRecentUserInputs,
  sessionMessageIdentity,
} from './finger-role-modules-continuity.js';
import {
  hasMediaInputInMessage,
  mapRawSessionMessages,
  resolveRolePromptOverridesFromConfig,
  type RuntimePromptConfig,
} from './finger-role-modules-helpers.js';

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

type HistoryMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
};

function isEffectivelyEmptyHistoryForBootstrap(messages: HistoryMessage[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return true;
  const nonEmpty = messages.filter((item) => typeof item.content === 'string' && item.content.trim().length > 0);
  return nonEmpty.length === 0;
}

function normalizeHistoryMessages(
  messages: Array<{
    id?: string;
    role: string;
    content: string;
    timestamp?: string;
    metadata?: Record<string, unknown>;
  }>,
): HistoryMessage[] {
  return messages.map((message, index) => ({
    id: typeof message.id === 'string' && message.id.trim().length > 0 ? message.id : `norm-${Date.now()}-${index}`,
    role: message.role === 'assistant' || message.role === 'system' ? message.role : 'user',
    content: typeof message.content === 'string' ? message.content : '',
    timestamp: typeof message.timestamp === 'string' ? message.timestamp : new Date().toISOString(),
    ...(message.metadata ? { metadata: message.metadata } : {}),
  }));
}

function topUpHistoryToBudget(
  selected: Array<{
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }>,
  rawMessages: HistoryMessage[],
  budgetTokens: number,
  extraMetadata?: Record<string, unknown>,
): Array<{
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}> {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return selected;
  if (!Array.isArray(selected) || selected.length === 0) return selected;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return selected;

  let usedTokens = selected.reduce((sum, item) => sum + estimateTokens(item.content), 0);
  if (usedTokens >= budgetTokens) return selected;

  const selectedKeys = new Set(selected.map((item) => sessionMessageIdentity(item)));
  const addKeys = new Set<string>();

  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const item = rawMessages[index];
    if (!item.content || item.content.trim().length === 0) continue;
    const key = sessionMessageIdentity(item);
    if (selectedKeys.has(key)) continue;
    const itemTokens = estimateTokens(item.content);
    if (usedTokens + itemTokens > budgetTokens) continue;
    addKeys.add(key);
    selectedKeys.add(key);
    usedTokens += itemTokens;
    if (usedTokens >= budgetTokens) break;
  }

  if (addKeys.size === 0) return selected;

  const byKey = new Map<string, {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }>();
  for (const item of selected) {
    byKey.set(sessionMessageIdentity(item), item);
  }
  for (const item of rawMessages) {
    const key = sessionMessageIdentity(item);
    if (!addKeys.has(key)) continue;
    byKey.set(key, {
      id: item.id,
      role: item.role,
      content: item.content,
      timestamp: item.timestamp,
      metadata: {
        ...(item.metadata ?? {}),
        ...(extraMetadata ?? {}),
        contextBuilderHistoryTopup: true,
      },
    });
  }

  const merged: Array<{
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const pushed = new Set<string>();
  for (const raw of rawMessages) {
    const key = sessionMessageIdentity(raw);
    const hit = byKey.get(key);
    if (!hit || pushed.has(key)) continue;
    pushed.add(key);
    merged.push(hit);
  }
  for (const item of selected) {
    const key = sessionMessageIdentity(item);
    if (pushed.has(key)) continue;
    pushed.add(key);
    merged.push(item);
  }

  return merged;
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
      const sessionContext = (session.context ?? {}) as Record<string, unknown>;
      const agentId = typeof sessionContext.ownerAgentId === 'string' && sessionContext.ownerAgentId.trim().length > 0
        ? sessionContext.ownerAgentId
        : role.id;
      const rootDir = deps.resolveSessionLedgerRoot
        ? deps.resolveSessionLedgerRoot({ id: session.id, projectPath: session.projectPath })
        : undefined;
      // Runtime consumption truth: use current built session snapshot only.
      // Ledger stays append-only storage and explicit query surface.
      const sessionMessages = normalizeHistoryMessages(runtime.getMessages(sessionId, 0));
      const latestMessage = sessionMessages.length > 0 ? sessionMessages[sessionMessages.length - 1] : null;
      const hasMediaInput = hasMediaInputInMessage(latestMessage);
      if (hasMediaInput) {
        // Media turn: keep raw session order, do not rewrite context via context builder.
        const mapped = augmentHistoryWithContinuityAnchors(mapRawSessionMessages(sessionMessages, limit, {
          contextBuilderHistorySource: 'raw_session',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'media_turn',
          contextBuilderRebuilt: false,
        }), sessionMessages, limit, {
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
      const pinnedMessageIds = extractPinnedMessageIdsFromSessionContext(sessionContext);
      const historyBudgetTokens = Number.isFinite(settings.historyBudgetTokens) && settings.historyBudgetTokens > 0
        ? Math.floor(settings.historyBudgetTokens)
        : 20000;

      // 默认不自动重组，只在模型显式调用 context_builder.rebuild 后
      // 在下一轮消费一次按需重组视图。
      if (!settings.enabled) {
        const mapped = augmentHistoryWithContinuityAnchors(mapRawSessionMessages(sessionMessages, limit, {
          contextBuilderHistorySource: 'raw_session',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'context_builder_disabled',
          contextBuilderRebuilt: false,
        }), sessionMessages, limit, {
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
        const persistedIndex = readPersistedContextBuilderHistoryIndex(sessionContext);
        if (persistedIndex) {
          const indexed = buildIndexedHistoryFromSnapshot(sessionMessages, persistedIndex, limit);
          if (indexed && indexed.messages.length > 0) {
            const mappedIndexed = indexed.messages.map((message) => ({
              ...message,
              metadata: {
                ...(message.metadata ?? {}),
                contextBuilderHistorySource: 'context_builder_indexed',
                contextBuilderBypassed: false,
                contextBuilderRebuilt: false,
                contextBuilderIndexed: true,
                contextBuilderOnDemand: false,
                contextBuilderBuildMode: persistedIndex.buildMode,
                contextBuilderTargetBudget: persistedIndex.targetBudget,
                contextBuilderSelectedBlockCount: persistedIndex.selectedBlockIds.length,
                contextBuilderAppliedAt: persistedIndex.updatedAt,
              },
            }));
            const merged = augmentHistoryWithContinuityAnchors(mappedIndexed, sessionMessages, limit, {
              contextBuilderHistorySource: 'context_builder_indexed',
              contextBuilderBypassed: false,
              contextBuilderRebuilt: false,
              contextBuilderIndexed: true,
            });
            const nextIndex = buildNextIndexedHistoryIndex(
              persistedIndex,
              merged.map((item) => ({
                id: item.id,
                timestamp: item.timestamp,
                ...(item.metadata ? { metadata: item.metadata } : {}),
              })),
            );
            persistContextBuilderHistoryIndex(runtime, sessionId, nextIndex);
            logger.module('finger-role-modules').debug('Applied indexed context history continuity view', {
              roleId: role.id,
              sessionId,
              selectedCount: indexed.selectedCount,
              deltaCount: indexed.deltaCount,
              buildMode: persistedIndex.buildMode,
              targetBudget: persistedIndex.targetBudget,
            });
            return topUpHistoryToBudget(
              merged,
              sessionMessages,
              Math.max(historyBudgetTokens, persistedIndex.targetBudget),
              {
                contextBuilderHistorySource: 'context_builder_indexed',
                contextBuilderHistoryTopup: true,
                contextBuilderIndexed: true,
              },
            );
          }
          logger.module('finger-role-modules').warn('Persisted indexed history unavailable on snapshot, fallback to raw/anchors', {
            roleId: role.id,
            sessionId,
            buildMode: persistedIndex.buildMode,
            selectedMessageCount: persistedIndex.selectedMessageIds.length,
          });
        }
        const canAutoBootstrap = isEffectivelyEmptyHistoryForBootstrap(sessionMessages);
        if (canAutoBootstrap && shouldRunContextBuilderBootstrapOnce(sessionId, agentId)) {
          const configuredBudget = Number.isFinite(settings.historyBudgetTokens) && settings.historyBudgetTokens > 0
            ? Math.floor(settings.historyBudgetTokens)
            : 20000;
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
            const merged = augmentHistoryWithContinuityAnchors(bootstrappedMapped, sessionMessages, limit, {
              contextBuilderHistorySource: 'context_builder_bootstrap',
              contextBuilderBypassed: false,
              contextBuilderRebuilt: true,
              contextBuilderBootstrap: true,
            });
            return topUpHistoryToBudget(merged, sessionMessages, historyBudgetTokens, {
              contextBuilderHistorySource: 'context_builder_bootstrap',
              contextBuilderHistoryTopup: true,
            });
          }

          logger.module('finger-role-modules').debug('Bootstrap rebuild yielded empty history, fallback to raw session', { roleId: role.id, sessionId });
        } else if (!canAutoBootstrap) {
          logger.module('finger-role-modules').debug('Skip bootstrap rebuild because session history is not empty', {
            roleId: role.id,
            sessionId,
            historyCount: sessionMessages.length,
          });
        }
        const mapped = augmentHistoryWithContinuityAnchors(mapRawSessionMessages(sessionMessages, limit, {
          contextBuilderHistorySource: 'raw_session',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'on_demand_not_requested',
          contextBuilderRebuilt: false,
        }), sessionMessages, limit, {
          contextBuilderHistorySource: 'raw_session',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'on_demand_not_requested',
          contextBuilderRebuilt: false,
        });
        logger.module('finger-role-modules').debug('Context builder not requested, using raw session history', { roleId: role.id, sessionId, selectedCount: mapped.length });
        return topUpHistoryToBudget(mapped, sessionMessages, historyBudgetTokens, {
          contextBuilderHistorySource: 'raw_session',
          contextBuilderHistoryTopup: true,
        });
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
        const fallback = augmentHistoryWithContinuityAnchors(mapRawSessionMessages(sessionMessages, limit, {
          contextBuilderHistorySource: 'raw_session_fallback',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'empty_on_demand_result',
          contextBuilderRebuilt: false,
        }), sessionMessages, limit, {
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
      const merged = augmentHistoryWithContinuityAnchors(mapped, sessionMessages, limit, {
        contextBuilderHistorySource: 'context_builder_on_demand',
        contextBuilderBypassed: false,
        contextBuilderRebuilt: true,
        contextBuilderOnDemand: true,
      });
      return topUpHistoryToBudget(merged, sessionMessages, historyBudgetTokens, {
        contextBuilderHistorySource: 'context_builder_on_demand',
        contextBuilderHistoryTopup: true,
      });
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
  extractRecentTaskMessages,
  extractRecentUserInputs,
  augmentHistoryWithContinuityAnchors,
  isEffectivelyEmptyHistoryForBootstrap,
};
