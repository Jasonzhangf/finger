import type { ModuleRegistry } from '../../orchestration/module-registry.js';
import { logger } from '../../core/logger.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { ChatCodexRunnerController } from '../../server/modules/mock-runtime.js';
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
} from '../../server/modules/context-builder-history-index.js';
import {
  augmentHistoryWithContinuityAnchors,
  extractRecentTaskMessages,
  extractRecentUserInputs,
  sessionMessageIdentity,
} from '../../server/modules/finger-role-modules-continuity.js';
import {
  hasMediaInputInMessage,
  mapRawSessionMessages,
  resolveRolePromptOverridesFromConfig,
  type RuntimePromptConfig,
} from '../../server/modules/finger-role-modules-helpers.js';
import { normalizeProjectPathCanonical } from '../../common/path-normalize.js';
import { resolveAgentDisplayName } from '../../server/modules/agent-name-resolver.js';
import { augmentToolSpecificationsWithCompatAliases } from '../../runtime/tool-compat-aliases.js';

export type FingerRoleProfile = 'project' | 'system';

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
const BOOTSTRAP_ONCE_RETRY_COOLDOWN_MS = Number.isFinite(Number(process.env.FINGER_BOOTSTRAP_ONCE_RETRY_COOLDOWN_MS))
  ? Math.max(10_000, Math.floor(Number(process.env.FINGER_BOOTSTRAP_ONCE_RETRY_COOLDOWN_MS)))
  : 120_000;

type BootstrapOnceOutcome = 'started' | 'success' | 'failed' | 'no_historical';
type BootstrapTrigger = 'history_empty' | 'history_context_zero' | 'none';

interface PersistedBootstrapOnceAgentState {
  lastAttemptAt: string;
  lastOutcome: BootstrapOnceOutcome;
  lastTrigger: BootstrapTrigger;
  messageCountAtAttempt: number;
}

interface PersistedBootstrapOnceState {
  version: 1;
  byAgent: Record<string, PersistedBootstrapOnceAgentState>;
}

function parsePersistedBootstrapOnceState(
  sessionContext: Record<string, unknown> | undefined,
): PersistedBootstrapOnceState | null {
  const raw = sessionContext?.contextBuilderBootstrapOnceState;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const byAgentRaw = value.byAgent;
  if (!byAgentRaw || typeof byAgentRaw !== 'object' || Array.isArray(byAgentRaw)) return null;
  const byAgent: Record<string, PersistedBootstrapOnceAgentState> = {};
  for (const [agentId, candidate] of Object.entries(byAgentRaw as Record<string, unknown>)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const state = candidate as Record<string, unknown>;
    const lastAttemptAt = typeof state.lastAttemptAt === 'string' ? state.lastAttemptAt.trim() : '';
    const lastOutcome = state.lastOutcome === 'started'
      || state.lastOutcome === 'success'
      || state.lastOutcome === 'failed'
      || state.lastOutcome === 'no_historical'
      ? state.lastOutcome
      : undefined;
    const lastTrigger = state.lastTrigger === 'history_empty'
      || state.lastTrigger === 'history_context_zero'
      || state.lastTrigger === 'none'
      ? state.lastTrigger
      : undefined;
    const messageCountAtAttempt = typeof state.messageCountAtAttempt === 'number' && Number.isFinite(state.messageCountAtAttempt)
      ? Math.max(0, Math.floor(state.messageCountAtAttempt))
      : undefined;
    if (!lastAttemptAt || !lastOutcome || !lastTrigger || messageCountAtAttempt === undefined) continue;
    byAgent[agentId] = {
      lastAttemptAt,
      lastOutcome,
      lastTrigger,
      messageCountAtAttempt,
    };
  }
  return {
    version: 1,
    byAgent,
  };
}

function shouldAllowBootstrapFromPersistedState(
  state: PersistedBootstrapOnceState | null,
  agentId: string,
  sessionMessageCount: number,
  nowMs: number,
  cooldownMs = BOOTSTRAP_ONCE_RETRY_COOLDOWN_MS,
): { allowed: boolean; reason: string; previous?: PersistedBootstrapOnceAgentState } {
  const previous = state?.byAgent?.[agentId];
  if (!previous) return { allowed: true, reason: 'no_previous_attempt' };
  if (previous.lastOutcome === 'success') {
    return { allowed: false, reason: 'already_succeeded', previous };
  }
  if (sessionMessageCount > previous.messageCountAtAttempt) {
    return { allowed: true, reason: 'new_messages_since_attempt', previous };
  }
  const lastAttemptMs = Date.parse(previous.lastAttemptAt);
  if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs >= cooldownMs) {
    return { allowed: true, reason: 'retry_cooldown_elapsed', previous };
  }
  return { allowed: false, reason: 'retry_cooldown_active', previous };
}

function persistBootstrapOnceState(
  runtime: RuntimeFacade,
  sessionId: string,
  sessionContext: Record<string, unknown> | undefined,
  agentId: string,
  trigger: BootstrapTrigger,
  outcome: BootstrapOnceOutcome,
  sessionMessageCount: number,
): void {
  const previous = parsePersistedBootstrapOnceState(sessionContext);
  const byAgent = {
    ...(previous?.byAgent ?? {}),
    [agentId]: {
      lastAttemptAt: new Date().toISOString(),
      lastOutcome: outcome,
      lastTrigger: trigger,
      messageCountAtAttempt: Math.max(0, Math.floor(sessionMessageCount)),
    },
  };
  runtime.updateSessionContext(sessionId, {
    contextBuilderBootstrapOnceState: {
      version: 1,
      byAgent,
    },
  });
}

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
    if (zone === 'historical_memory') return true;
    // zone 丢失时，仍允许通过 compactDigest / rebuild source 判定历史上下文存在，
    // 避免误判成 history_context_zero 并反复触发 bootstrap。
    if (metadata.compactDigest === true) return true;
    const historySource = typeof metadata.contextBuilderHistorySource === 'string'
      ? metadata.contextBuilderHistorySource.trim()
      : '';
    if (historySource.startsWith('context_builder_')) return true;
    if (historySource === 'cross_session_seed_fallback') return true;
    return false;
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

  let best: { sourceSessionId: string; messages: HistoryMessage[]; score: number } | null = null;

  for (const candidate of candidates) {
    if (candidate.id.startsWith('hb-session-')) continue;
    const fullSession = runtime.getSession(candidate.id);
    if (!fullSession) continue;
    const context = (fullSession.context ?? {}) as Record<string, unknown>;
    const sessionTier = typeof context.sessionTier === 'string' ? context.sessionTier.trim().toLowerCase() : '';
    const ownerAgentId = typeof context.ownerAgentId === 'string' ? context.ownerAgentId.trim() : '';
    if (ownerAgentId && ownerAgentId !== agentId) continue;
    if (sessionTier === 'runtime' || sessionTier === 'heartbeat-control' || sessionTier === 'heartbeat') continue;
    const messages = normalizeHistoryMessages(runtime.getMessages(candidate.id, 0));
    if (messages.length === 0 || isEffectivelyEmptyHistoryForBootstrap(messages)) continue;
    const historicalCount = messages.reduce((count, message) => {
      const zone = typeof message.metadata?.contextZone === 'string'
        ? message.metadata.contextZone.trim()
        : '';
      return zone === 'historical_memory' ? count + 1 : count;
    }, 0);
    const hasHistorical = hasHistoricalContextZone(messages);
    const updatedAtScore = Number.isFinite(Date.parse(candidate.updatedAt))
      ? Math.floor(Date.parse(candidate.updatedAt) / 1000)
      : 0;
    const score = (hasHistorical ? 1_000_000 : 0)
      + (historicalCount * 2_000)
      + (messages.length * 10)
      + Math.floor(updatedAtScore / 10_000);
    if (!best || score > best.score) {
      best = {
        sourceSessionId: candidate.id,
        messages,
        score,
      };
    }
  }

  return best
    ? {
      sourceSessionId: best.sourceSessionId,
      messages: best.messages,
    }
    : null;
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
    if (role.roleProfile === 'system') return 'system';
    return 'project';
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

      // Provider strict compatibility: ensure user.ask schema is explicit and closed.
      if (tool.name === 'user.ask') {
        finalSchema.type = 'object';
        finalSchema.properties = {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          context: { type: 'string' },
          blocking_reason: { type: 'string' },
          decision_impact: { type: 'string', enum: ['critical', 'major', 'normal'] },
          timeout_ms: { type: 'number' },
          session_id: { type: 'string' },
          workflow_id: { type: 'string' },
          epic_id: { type: 'string' },
          agent_id: { type: 'string' },
        };
        finalSchema.required = ['question'];
        finalSchema.additionalProperties = false;
      }

      resolved.push({
        name: tool.name,
        description: tool.description,
        inputSchema: finalSchema,
      });
    }
    return augmentToolSpecificationsWithCompatAliases(resolved);
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

      const mappedSessionHistory = augmentHistoryWithContinuityAnchors(mapRawSessionMessages(sessionMessages, limit, {
        contextBuilderHistorySource: 'raw_session',
        contextBuilderBypassed: false,
        contextBuilderRebuilt: sessionMessages.some((message) => message.metadata?.compactDigest === true),
      }), sessionMessages, limit, {
        contextBuilderHistorySource: 'raw_session',
        contextBuilderBypassed: false,
        contextBuilderRebuilt: sessionMessages.some((message) => message.metadata?.compactDigest === true),
      });
      logger.module('finger-role-modules').debug('Use single-source session snapshot history', {
        roleId: role.id,
        sessionId,
        selectedCount: mappedSessionHistory.length,
        pinnedMessageCount: pinnedMessageIds.length,
      });
      return topUpHistoryToBudget(mappedSessionHistory, sessionMessages, historyBudgetTokens, {
        contextBuilderHistorySource: 'raw_session',
        contextBuilderHistoryTopup: true,
      });

    };

    const digestProvider = async (
      sessionId: string,
      message: { id: string; role: string; content: string; timestamp: string },
      tags: string[],
      agentId?: string,
      mode?: string,
    ) => {
      await runtime.appendDigest(sessionId, message, tags, agentId, mode);
    };

    const roleModule = createFingerGeneralModule({
      id: role.id,
      name: resolveAgentDisplayName(role.id),
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
      digestProvider,
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
      name: resolveAgentDisplayName(legacy.legacyAgentId),
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
  hasHistoricalContextZone,
  resolveBootstrapRebuildPolicy,
  resolveBootstrapPrompt,
  keepDigestOnlyHistoricalMessages,
  buildHistoricalFallbackFromSeed,
  parsePersistedBootstrapOnceState,
  shouldAllowBootstrapFromPersistedState,
};
