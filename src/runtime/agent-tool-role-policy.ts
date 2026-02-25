import type { AgentToolPolicy } from './agent-tool-access.js';
import { AgentToolAccessControl } from './agent-tool-access.js';

export interface AgentRoleToolPolicyPreset {
  role: string;
  whitelist: string[];
  blacklist: string[];
}

export type RoleToolPolicyPresetMap = Record<string, AgentRoleToolPolicyPreset>;

export function applyRoleToolPolicy(
  accessControl: AgentToolAccessControl,
  agentId: string,
  role: string,
  presets: RoleToolPolicyPresetMap,
): AgentToolPolicy {
  const normalizedRole = role.trim().toLowerCase();
  const preset = presets[normalizedRole];
  if (!preset) {
    throw new Error(`Unknown role policy preset: ${role}`);
  }

  accessControl.setWhitelist(agentId, preset.whitelist);
  accessControl.setBlacklist(agentId, preset.blacklist);
  return accessControl.getPolicy(agentId);
}
