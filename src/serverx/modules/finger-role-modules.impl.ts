import type { ModuleRegistry } from '../../orchestration/module-registry.js';
import { logger } from '../../core/logger.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { ChatCodexRunnerController } from '../../server/modules/mock-runtime.js';
import { createFingerGeneralModule, type ChatCodexLoopEvent } from '../../agents/finger-general/finger-general-module.js';
import type { ChatCodexDeveloperRole } from '../../agents/chat-codex/developer-prompt-templates.js';
import { resolveContextHistoryBudget } from '../../runtime/context-history/index.js';
import { estimateTokens } from '../../utils/token-counter.js';
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
        contextHistoryTopup: true,
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
      const session = runtime.getSession(sessionId);
      if (!session) {
        logger.module('finger-role-modules').warn('Context history session not found, fallback to session history', {
          roleId: role.id,
          sessionId,
        });
        return null;
      }
      // Runtime consumption truth: use current built session snapshot only.
      // Ledger stays append-only storage and explicit query surface.
      const sessionMessages = normalizeHistoryMessages(runtime.getMessages(sessionId, 0));
      const latestMessage = sessionMessages.length > 0 ? sessionMessages[sessionMessages.length - 1] : null;
      const hasMediaInput = hasMediaInputInMessage(latestMessage);
      if (hasMediaInput) {
        // Media turn: keep session-view order, do not rewrite context via context builder.
        const mapped = augmentHistoryWithContinuityAnchors(mapRawSessionMessages(sessionMessages, limit, {
          contextHistorySource: 'session_view_passthrough',
          contextHistoryBypassed: true,
          contextHistoryBypassReason: 'media_turn',
          contextHistoryRebuilt: false,
        }), sessionMessages, limit, {
          contextHistorySource: 'session_view_passthrough',
          contextHistoryBypassed: true,
          contextHistoryBypassReason: 'media_turn',
          contextHistoryRebuilt: false,
        });
        logger.module('finger-role-modules').info('Context builder bypassed for media turn', {
          roleId: role.id,
          sessionId,
          rawMessageCount: sessionMessages.length,
          selectedCount: mapped.length,
        });
        return mapped;
      }
      const historyBudgetTokens = resolveContextHistoryBudget();

      const sessionSnapshotRebuilt = sessionMessages.some((message) => message.metadata?.compactDigest === true);
      const mappedSessionHistory = augmentHistoryWithContinuityAnchors(mapRawSessionMessages(sessionMessages, limit, {
        contextHistorySource: 'raw_session',
        contextHistoryBypassed: false,
        contextHistoryRebuilt: sessionSnapshotRebuilt,
      }), sessionMessages, limit, {
        contextHistorySource: 'raw_session',
        contextHistoryBypassed: false,
        contextHistoryRebuilt: sessionSnapshotRebuilt,
      });
      logger.module('finger-role-modules').debug('Use single-source session snapshot history', {
        roleId: role.id,
        sessionId,
        selectedCount: mappedSessionHistory.length,
      });
      return topUpHistoryToBudget(mappedSessionHistory, sessionMessages, historyBudgetTokens, {
        contextHistorySource: 'raw_session',
        contextHistoryTopup: true,
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
};
