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
  resetContextBuilderBootstrapOnce,
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
import { normalizeProjectPathCanonical } from '../../common/path-normalize.js';

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

const INDEXED_HISTORY_MISSING_RATIO_REBUILD_THRESHOLD = 0.2;
const INDEXED_HISTORY_MISSING_COUNT_REBUILD_THRESHOLD = 64;

function isEffectivelyEmptyHistoryForBootstrap(messages: HistoryMessage[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return true;
  const nonEmpty = messages.filter((item) => typeof item.content === 'string' && item.content.trim().length > 0);
  return nonEmpty.length === 0;
}

function hasHistoricalContextZone(messages: HistoryMessage[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  return messages.some((item) => {
    const metadata = item.metadata;
    if (!metadata || typeof metadata !== 'object') return false;
    const zone = typeof metadata.contextZone === 'string' ? metadata.contextZone.trim() : '';
    return zone === 'historical_memory';
  });
}

function resolveBootstrapRebuildPolicy(
  historyEmpty: boolean,
  hasHistoryContext: boolean,
): {
  shouldBootstrap: boolean;
  enforceOnceGuard: boolean;
  trigger: 'history_empty' | 'history_context_zero' | 'none';
} {
  if (historyEmpty) {
    return {
      shouldBootstrap: true,
      enforceOnceGuard: true,
      trigger: 'history_empty',
    };
  }
  if (!hasHistoryContext) {
    // Jason 规则：history context=0 必须触发 rebuild（不受 once gating 限制）。
    return {
      shouldBootstrap: true,
      enforceOnceGuard: false,
      trigger: 'history_context_zero',
    };
  }
  return {
    shouldBootstrap: false,
    enforceOnceGuard: false,
    trigger: 'none',
  };
}

function resolveLatestUserPrompt(messages: HistoryMessage[]): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item.role !== 'user') continue;
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (content.length > 0) return content;
  }
  return undefined;
}

function resolveBootstrapPrompt(
  sessionMessages: HistoryMessage[],
  bootstrapSeedMessages: HistoryMessage[],
): { prompt?: string; source: 'session_messages' | 'bootstrap_seed' | 'none' } {
  const fromSession = resolveLatestUserPrompt(sessionMessages);
  if (typeof fromSession === 'string' && fromSession.trim().length > 0) {
    return { prompt: fromSession, source: 'session_messages' };
  }
  const fromSeed = resolveLatestUserPrompt(bootstrapSeedMessages);
  if (typeof fromSeed === 'string' && fromSeed.trim().length > 0) {
    return { prompt: fromSeed, source: 'bootstrap_seed' };
  }
  return { source: 'none' };
}

function keepDigestOnlyHistoricalMessages(
  messages: Array<{
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }>,
): Array<{
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }> {
  const hasCompactHistorical = messages.some((item) => {
    const metadata = item.metadata;
    const zone = typeof metadata?.contextZone === 'string' ? metadata.contextZone.trim() : '';
    if (zone !== 'historical_memory') return false;
    return metadata?.compactDigest === true;
  });
  if (!hasCompactHistorical) {
    // 防止 “history context=0” 死循环：当构建结果暂时没有 compactDigest 标记时，
    // 保留历史消息（而不是全部丢弃），让下一轮至少能继续携带 historical_memory。
    return messages;
  }
  return messages.filter((item) => {
    const metadata = item.metadata;
    const zone = typeof metadata?.contextZone === 'string' ? metadata.contextZone.trim() : '';
    if (zone !== 'historical_memory') return true;
    return metadata?.compactDigest === true;
  });
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

function resolveCrossSessionBootstrapSeed(
  runtime: RuntimeFacade,
  currentSessionId: string,
  agentId: string,
  projectPath: string,
): { sourceSessionId: string; messages: HistoryMessage[] } | null {
  const normalizedProject = normalizeProjectPathCanonical(projectPath);
  if (!normalizedProject) return null;
  const candidates = runtime.listSessions()
    .filter((session) => session.id !== currentSessionId)
    .filter((session) => normalizeProjectPathCanonical(session.projectPath) === normalizedProject)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  for (const candidate of candidates) {
    const fullSession = runtime.getSession(candidate.id);
    if (!fullSession) continue;
    const context = (fullSession.context ?? {}) as Record<string, unknown>;
    const ownerAgentId = typeof context.ownerAgentId === 'string' ? context.ownerAgentId.trim() : '';
    if (ownerAgentId && ownerAgentId !== agentId) continue;
    if (context.sessionTier === 'runtime') continue;
    const messages = normalizeHistoryMessages(runtime.getMessages(candidate.id, 0));
    if (messages.length === 0 || isEffectivelyEmptyHistoryForBootstrap(messages)) continue;
    return {
      sourceSessionId: candidate.id,
      messages,
    };
  }

  return null;
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

function buildHistoricalFallbackFromSeed(
  seedMessages: HistoryMessage[],
  budgetTokens: number,
  limit: number,
): Array<{
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}> {
  if (!Array.isArray(seedMessages) || seedMessages.length === 0) return [];
  const normalizedBudget = Number.isFinite(budgetTokens) && budgetTokens > 0 ? Math.floor(budgetTokens) : 20000;
  const selected: HistoryMessage[] = [];
  let used = 0;
  for (let index = seedMessages.length - 1; index >= 0; index -= 1) {
    const item = seedMessages[index];
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) continue;
    const tokens = estimateTokens(content);
    if (used + tokens > normalizedBudget) continue;
    selected.push(item);
    used += tokens;
    if (used >= normalizedBudget) break;
  }
  selected.reverse();
  const limited = Number.isFinite(limit) && limit > 0 ? selected.slice(-limit) : selected;
  return limited.map((item) => ({
    id: item.id,
    role: item.role,
    content: item.content,
    timestamp: item.timestamp,
    metadata: {
      ...(item.metadata ?? {}),
      contextZone: 'historical_memory',
      compactDigest: true,
      contextBuilderHistorySource: 'cross_session_seed_fallback',
      contextBuilderBypassed: false,
      contextBuilderRebuilt: true,
      contextBuilderBootstrap: true,
    },
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
        // Media turn: keep session-view order, do not rewrite context via context builder.
        const mapped = augmentHistoryWithContinuityAnchors(mapRawSessionMessages(sessionMessages, limit, {
          contextBuilderHistorySource: 'session_view_passthrough',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'media_turn',
          contextBuilderRebuilt: false,
        }), sessionMessages, limit, {
          contextBuilderHistorySource: 'session_view_passthrough',
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
          contextBuilderHistorySource: 'session_view_passthrough',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'context_builder_disabled',
          contextBuilderRebuilt: false,
        }), sessionMessages, limit, {
          contextBuilderHistorySource: 'session_view_passthrough',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'context_builder_disabled',
          contextBuilderRebuilt: false,
        });
        logger.module('finger-role-modules').info('Context builder disabled, using session-view passthrough history', {
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
            const requestedHistoricalCount = indexed.requestedHistoricalCount;
            const missingHistoricalCount = indexed.missingHistoricalCount;
            const missingHistoricalRatio = requestedHistoricalCount > 0
              ? missingHistoricalCount / requestedHistoricalCount
              : 0;
            const indexedCoverageInsufficient = requestedHistoricalCount > 0 && (
              missingHistoricalCount >= INDEXED_HISTORY_MISSING_COUNT_REBUILD_THRESHOLD
              || missingHistoricalRatio >= INDEXED_HISTORY_MISSING_RATIO_REBUILD_THRESHOLD
            );
            if (indexedCoverageInsufficient) {
              logger.module('finger-role-modules').warn('Persisted indexed history coverage stale; fallback to bootstrap rebuild path', {
                roleId: role.id,
                sessionId,
                buildMode: persistedIndex.buildMode,
                targetBudget: persistedIndex.targetBudget,
                requestedHistoricalCount,
                resolvedHistoricalCount: indexed.resolvedHistoricalCount,
                missingHistoricalCount,
                missingHistoricalRatio: Number(missingHistoricalRatio.toFixed(3)),
                thresholdRatio: INDEXED_HISTORY_MISSING_RATIO_REBUILD_THRESHOLD,
              });
            } else {
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
              const hasIndexedHistoricalContext = hasHistoricalContextZone(
                merged as unknown as HistoryMessage[],
              );
              if (hasIndexedHistoricalContext) {
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
              logger.module('finger-role-modules').warn('Indexed history has no historical_memory zone; fallback to bootstrap path', {
                roleId: role.id,
                sessionId,
                selectedCount: indexed.selectedCount,
                deltaCount: indexed.deltaCount,
                buildMode: persistedIndex.buildMode,
                targetBudget: persistedIndex.targetBudget,
              });
            }
          }
          logger.module('finger-role-modules').warn('Persisted indexed history unavailable on snapshot, fallback to raw/anchors', {
            roleId: role.id,
            sessionId,
            buildMode: persistedIndex.buildMode,
            selectedMessageCount: persistedIndex.selectedMessageIds.length,
          });
        }
        const hasHistoryContext = hasHistoricalContextZone(sessionMessages);
        const historyEmpty = isEffectivelyEmptyHistoryForBootstrap(sessionMessages);
        const bootstrapPolicy = resolveBootstrapRebuildPolicy(historyEmpty, hasHistoryContext);
        const canAutoBootstrap = bootstrapPolicy.shouldBootstrap;
        const bootstrapTrigger = bootstrapPolicy.trigger;
        const bootstrapAllowedByOnceGuard = !bootstrapPolicy.enforceOnceGuard
          || shouldRunContextBuilderBootstrapOnce(sessionId, agentId);
        if (canAutoBootstrap) {
          logger.module('finger-role-modules').info('Context bootstrap decision', {
            roleId: role.id,
            sessionId,
            trigger: bootstrapTrigger,
            historyEmpty,
            hasHistoryContext,
            sessionMessageCount: sessionMessages.length,
            enforceOnceGuard: bootstrapPolicy.enforceOnceGuard,
            bootstrapAllowedByOnceGuard,
          });
        }
        if (canAutoBootstrap && bootstrapAllowedByOnceGuard) {
          const configuredBudget = Number.isFinite(settings.historyBudgetTokens) && settings.historyBudgetTokens > 0
            ? Math.floor(settings.historyBudgetTokens)
            : 20000;
          const bootstrapBuildMode = bootstrapTrigger === 'history_context_zero'
            ? 'aggressive'
            : settings.mode;
          const crossSessionSeed = !hasHistoryContext
            ? resolveCrossSessionBootstrapSeed(runtime, sessionId, agentId, session.projectPath)
            : null;
          const bootstrapSeedMessages = crossSessionSeed?.messages ?? sessionMessages;
          const bootstrapPrompt = resolveBootstrapPrompt(sessionMessages, bootstrapSeedMessages);
          const latestUserPrompt = bootstrapPrompt.prompt;
          if (crossSessionSeed) {
            logger.module('finger-role-modules').info('Bootstrap uses cross-session seed history', {
              roleId: role.id,
              sessionId,
              sourceSessionId: crossSessionSeed.sourceSessionId,
              sourceMessageCount: crossSessionSeed.messages.length,
              trigger: bootstrapTrigger,
            });
          }
          logger.module('finger-role-modules').info('Bootstrap prompt source resolved', {
            roleId: role.id,
            sessionId,
            trigger: bootstrapTrigger,
            promptSource: bootstrapPrompt.source,
            promptLength: typeof latestUserPrompt === 'string' ? latestUserPrompt.length : 0,
          });
          let bootstrapped:
            | Awaited<ReturnType<typeof buildContext>>
            | null = null;
          try {
            bootstrapped = await buildContext(
              {
                rootDir,
                sessionId,
                agentId,
                mode: 'main',
                ...(bootstrapSeedMessages.length > 0 ? { sessionMessages: bootstrapSeedMessages } : {}),
                ...(latestUserPrompt ? { currentPrompt: latestUserPrompt } : {}),
              },
              {
              targetBudget: configuredBudget,
              buildMode: bootstrapBuildMode,
              includeMemoryMd: false,
              enableTaskGrouping: true,
                enableModelRanking: settings.enableModelRanking,
                rankingProviderId: settings.rankingProviderId,
              },
            );
          } catch (error) {
            resetContextBuilderBootstrapOnce(sessionId, agentId);
            logger.module('finger-role-modules').warn('Bootstrap rebuild failed, will retry on next turn', {
              roleId: role.id,
              sessionId,
              trigger: bootstrapTrigger,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          if (bootstrapped) {
            logger.module('finger-role-modules').info('Context bootstrap build result', {
              roleId: role.id,
              sessionId,
              trigger: bootstrapTrigger,
              messageCount: bootstrapped.messages.length,
              taskBlockCount: bootstrapped.taskBlockCount,
              totalTokens: bootstrapped.totalTokens,
              historicalTaskBlockCount: bootstrapped.metadata?.historicalTaskBlockCount,
              historicalMessageCount: bootstrapped.metadata?.historicalMessageCount,
              historicalTokens: bootstrapped.metadata?.historicalTokens,
              rankingExecuted: bootstrapped.metadata?.rankingExecuted,
              rankingMode: bootstrapped.metadata?.rankingMode,
              rankingReason: bootstrapped.metadata?.rankingReason,
              rankingProviderId: bootstrapped.metadata?.rankingProviderId,
              rankingProviderModel: bootstrapped.metadata?.rankingProviderModel,
              promptSource: bootstrapPrompt.source,
              promptLength: typeof latestUserPrompt === 'string' ? latestUserPrompt.length : 0,
            });
          }
          if (!bootstrapped) {
            const mapped = augmentHistoryWithContinuityAnchors(mapRawSessionMessages(sessionMessages, limit, {
              contextBuilderHistorySource: 'session_view_passthrough',
              contextBuilderBypassed: true,
              contextBuilderBypassReason: 'bootstrap_failed',
              contextBuilderRebuilt: false,
            }), sessionMessages, limit, {
              contextBuilderHistorySource: 'session_view_passthrough',
              contextBuilderBypassed: true,
              contextBuilderBypassReason: 'bootstrap_failed',
              contextBuilderRebuilt: false,
            });
            return topUpHistoryToBudget(mapped, sessionMessages, historyBudgetTokens, {
              contextBuilderHistorySource: 'session_view_passthrough',
              contextBuilderHistoryTopup: true,
            });
          }

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
              contextBuilderBuildMode: bootstrapBuildMode,
              contextBuilderTargetBudget: configuredBudget,
              contextBuilderSelectedBlockCount: bootstrapped.rankedTaskBlocks.length,
              contextBuilderAppliedAt: new Date().toISOString(),
            },
          }));
          const digestOnlyBootstrappedMapped = keepDigestOnlyHistoricalMessages(bootstrappedMapped);
          const hasBootstrappedHistoricalContext = hasHistoricalContextZone(
            digestOnlyBootstrappedMapped as unknown as HistoryMessage[],
          );
          if (!hasBootstrappedHistoricalContext) {
            if (crossSessionSeed && crossSessionSeed.messages.length > 0) {
              const crossSessionFallback = buildHistoricalFallbackFromSeed(
                crossSessionSeed.messages,
                configuredBudget,
                limit,
              );
              if (crossSessionFallback.length > 0) {
                logger.module('finger-role-modules').warn('Bootstrap returned no historical_memory; apply cross-session historical fallback', {
                  roleId: role.id,
                  sessionId,
                  sourceSessionId: crossSessionSeed.sourceSessionId,
                  selectedCount: crossSessionFallback.length,
                  trigger: bootstrapTrigger,
                });
                const merged = augmentHistoryWithContinuityAnchors(crossSessionFallback, sessionMessages, limit, {
                  contextBuilderHistorySource: 'cross_session_seed_fallback',
                  contextBuilderBypassed: false,
                  contextBuilderRebuilt: true,
                  contextBuilderBootstrap: true,
                });
                return merged;
              }
            }
            resetContextBuilderBootstrapOnce(sessionId, agentId);
            logger.module('finger-role-modules').warn('Bootstrap rebuild returned no historical_memory messages; retry bootstrap on next turn', {
              roleId: role.id,
              sessionId,
              selectedCount: bootstrappedMapped.length,
              digestOnlySelectedCount: digestOnlyBootstrappedMapped.length,
              trigger: bootstrapTrigger,
            });
            const mapped = augmentHistoryWithContinuityAnchors(mapRawSessionMessages(sessionMessages, limit, {
              contextBuilderHistorySource: 'session_view_passthrough',
              contextBuilderBypassed: true,
              contextBuilderBypassReason: 'bootstrap_no_historical_output',
              contextBuilderRebuilt: false,
            }), sessionMessages, limit, {
              contextBuilderHistorySource: 'session_view_passthrough',
              contextBuilderBypassed: true,
              contextBuilderBypassReason: 'bootstrap_no_historical_output',
              contextBuilderRebuilt: false,
            });
            return topUpHistoryToBudget(mapped, sessionMessages, historyBudgetTokens, {
              contextBuilderHistorySource: 'session_view_passthrough',
              contextBuilderHistoryTopup: true,
            });
          }
          if (bootstrappedMapped.length > 0) {
            const indexSnapshot = buildContextBuilderHistoryIndex(
              'context_builder_bootstrap',
              bootstrapBuildMode,
              configuredBudget,
              bootstrapped.rankedTaskBlocks.map((block) => block.id),
              bootstrapped.messages,
              pinnedMessageIds.length > 0 ? { pinnedMessageIds } : undefined,
            );
            persistContextBuilderHistoryIndex(runtime, sessionId, indexSnapshot);
            logger.module('finger-role-modules').info('Applied one-time bootstrap context rebuild', {
              roleId: role.id,
              sessionId,
              selectedCount: bootstrappedMapped.length,
              digestOnlySelectedCount: digestOnlyBootstrappedMapped.length,
              mode: bootstrapBuildMode,
              targetBudget: configuredBudget,
              trigger: bootstrapTrigger,
            });
            const merged = augmentHistoryWithContinuityAnchors(digestOnlyBootstrappedMapped, sessionMessages, limit, {
              contextBuilderHistorySource: 'context_builder_bootstrap',
              contextBuilderBypassed: false,
              contextBuilderRebuilt: true,
              contextBuilderBootstrap: true,
            });
            return merged;
          }

          resetContextBuilderBootstrapOnce(sessionId, agentId);
          logger.module('finger-role-modules').debug('Bootstrap rebuild yielded empty history, fallback to session-view passthrough', { roleId: role.id, sessionId });
        } else if (!canAutoBootstrap) {
          logger.module('finger-role-modules').debug('Skip bootstrap rebuild because session history is not empty', {
            roleId: role.id,
            sessionId,
            historyCount: sessionMessages.length,
          });
        } else {
          logger.module('finger-role-modules').debug('Skip bootstrap rebuild due once-guard gate', {
            roleId: role.id,
            sessionId,
            trigger: bootstrapTrigger,
          });
        }
        const mapped = augmentHistoryWithContinuityAnchors(mapRawSessionMessages(sessionMessages, limit, {
          contextBuilderHistorySource: 'session_view_passthrough',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'on_demand_not_requested',
          contextBuilderRebuilt: false,
        }), sessionMessages, limit, {
          contextBuilderHistorySource: 'session_view_passthrough',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'on_demand_not_requested',
          contextBuilderRebuilt: false,
        });
        logger.module('finger-role-modules').debug('Context builder not requested, using session-view passthrough history', { roleId: role.id, sessionId, selectedCount: mapped.length });
        return topUpHistoryToBudget(mapped, sessionMessages, historyBudgetTokens, {
          contextBuilderHistorySource: 'session_view_passthrough',
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
          contextBuilderHistorySource: 'session_view_fallback',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'empty_on_demand_result',
          contextBuilderRebuilt: false,
        }), sessionMessages, limit, {
          contextBuilderHistorySource: 'session_view_fallback',
          contextBuilderBypassed: true,
          contextBuilderBypassReason: 'empty_on_demand_result',
          contextBuilderRebuilt: false,
        });
        logger.module('finger-role-modules').warn('On-demand context builder returned empty history, fallback to session-view passthrough', { roleId: role.id, sessionId, rawMessageCount: sessionMessages.length, selectedCount: fallback.length, mode: onDemand.buildMode });
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
  resolveBootstrapRebuildPolicy,
  resolveBootstrapPrompt,
  keepDigestOnlyHistoricalMessages,
  buildHistoricalFallbackFromSeed,
};
