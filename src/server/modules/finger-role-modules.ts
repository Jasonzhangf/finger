import type { ModuleRegistry } from '../../orchestration/module-registry.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { ChatCodexRunnerController } from './mock-runtime.js';
import { createFingerGeneralModule, type ChatCodexLoopEvent } from '../../agents/finger-general/finger-general-module.js';

export type FingerRoleProfile = 'general' | 'orchestrator' | 'researcher' | 'executor' | 'coder' | 'reviewer';

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

  const resolveFingerToolSpecifications = async (toolNames: string[]) => {
    const resolved: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [];
    for (const name of toolNames) {
      const tool = toolRegistry.get(name);
      if (!tool || tool.policy !== 'allow') continue;
      resolved.push({
        name: tool.name,
        description: tool.description,
        inputSchema:
          typeof tool.inputSchema === 'object' && tool.inputSchema !== null
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: 'object', additionalProperties: true },
      });
    }
    return resolved;
  };

  const registerFingerRoleModule = async (role: FingerRoleSpec): Promise<void> => {
    const roleModule = createFingerGeneralModule({
      id: role.id,
      name: role.id,
      roleProfile: role.roleProfile,
      resolveToolSpecifications: resolveFingerToolSpecifications,
      toolExecution: {
        daemonUrl,
        agentId: role.id,
      },
      onLoopEvent,
    }, chatCodexRunner);
    await moduleRegistry.register(roleModule);
    const policy = runtime.setAgentToolWhitelist(role.id, role.allowedTools);
    console.log(`[Server] ${role.id} module registered, tools=${policy.whitelist.join(', ')}`);
  };

  for (const role of roles) {
    await registerFingerRoleModule(role);
  }

  if (legacy?.enableLegacyChatCodexAlias) {
    const legacyChatCodexAlias = createFingerGeneralModule({
      id: legacy.legacyAgentId,
      name: legacy.legacyAgentId,
      roleProfile: 'general',
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
