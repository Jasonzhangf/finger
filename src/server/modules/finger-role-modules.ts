import type { ModuleRegistry } from '../../orchestration/module-registry.js';
import { logger } from '../../core/logger.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { ChatCodexRunnerController } from './mock-runtime.js';
import { createFingerGeneralModule, type ChatCodexLoopEvent } from '../../agents/finger-general/finger-general-module.js';
import { resolveBaseAgentRole } from '../../agents/chat-codex/agent-role-config.js';
import type { ChatCodexDeveloperRole } from '../../agents/chat-codex/developer-prompt-templates.js';

export type FingerRoleProfile = 'general' | 'orchestrator' | 'system';

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

export async function registerFingerRoleModules(
  deps: RegisterFingerRoleModulesDeps,
  roles: FingerRoleSpec[],
  legacy?: LegacyAliasOptions,
): Promise<void> {
  const { moduleRegistry, runtime, toolRegistry, chatCodexRunner, daemonUrl, onLoopEvent } = deps;

  const resolveDeveloperRole = (role: FingerRoleSpec): ChatCodexDeveloperRole => {
    if (role.roleProfile === 'system') return 'orchestrator';
    if (role.roleProfile === 'general') return 'orchestrator';
    return resolveBaseAgentRole(role.roleProfile);
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
    const roleModule = createFingerGeneralModule({
      id: role.id,
      name: role.id,
      roleProfile: role.roleProfile === 'system' ? 'orchestrator' : role.roleProfile,
      ...resolvePromptOverrides(role.id, role),
      resolvePromptPaths: () => resolvePromptOverrides(role.id, role),
      resolveToolSpecifications: resolveFingerToolSpecifications,
      toolExecution: {
        daemonUrl,
        agentId: role.id,
      },
      onLoopEvent,
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
      roleProfile: 'general',
      ...resolvePromptOverrides(legacy.legacyAgentId, {
        id: legacy.legacyAgentId,
        roleProfile: 'general',
        allowedTools: legacy.legacyAllowedTools,
      }),
      resolvePromptPaths: () =>
        resolvePromptOverrides(legacy.legacyAgentId, {
          id: legacy.legacyAgentId,
          roleProfile: 'general',
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
