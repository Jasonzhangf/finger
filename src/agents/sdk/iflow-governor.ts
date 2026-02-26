import type {
  ApprovalMode,
  CommandConfig,
  IFlowOptions,
  SessionSettings,
} from '@iflow-ai/iflow-cli-sdk';
import { resolveAvailableCliCapabilities } from '../../tools/external/cli-capability-registry.js';

export interface IflowToolPolicy {
  allowedTools?: string[];
  disallowedTools?: string[];
  approvalMode?: `${ApprovalMode}`;
}

export interface IflowCommandPolicy {
  injectCapabilities?: boolean;
  capabilityIds?: string[];
  commandNamespace?: string;
}

export interface IflowGovernanceConfig {
  toolPolicy?: IflowToolPolicy;
  commandPolicy?: IflowCommandPolicy;
}

export interface InjectedCapabilityCommand {
  capabilityId: string;
  capabilityName: string;
  commandName: string;
  commandLine: string;
  description: string;
}

export interface IflowGovernanceResolution {
  sessionSettings: SessionSettings | undefined;
  commands: CommandConfig[] | undefined;
  injectedCommands: InjectedCapabilityCommand[];
}

export function resolveIflowGovernance(
  options: IFlowOptions | undefined,
  governance: IflowGovernanceConfig | undefined,
): IflowGovernanceResolution {
  const sessionSettings = mergeSessionSettings(options?.sessionSettings, governance?.toolPolicy);
  const commandResolution = mergeCommandPolicies(options?.commands, governance?.commandPolicy);

  return {
    sessionSettings,
    commands: commandResolution.commands,
    injectedCommands: commandResolution.injected,
  };
}

function mergeSessionSettings(
  base: SessionSettings | undefined,
  toolPolicy: IflowToolPolicy | undefined,
): SessionSettings | undefined {
  const next: SessionSettings = { ...(base ?? {}) };
  let changed = false;

  const allowed = normalizeStringArray(toolPolicy?.allowedTools);
  const disallowed = normalizeStringArray(toolPolicy?.disallowedTools);

  if (allowed.length > 0) {
    next.allowed_tools = allowed;
    changed = true;
  }
  if (disallowed.length > 0) {
    next.disallowed_tools = disallowed;
    changed = true;
  }
  if (toolPolicy?.approvalMode) {
    next.permission_mode = toolPolicy.approvalMode;
    changed = true;
  }

  if (!changed && !base) return undefined;
  return next;
}

function mergeCommandPolicies(
  baseCommands: CommandConfig[] | undefined,
  policy: IflowCommandPolicy | undefined,
): { commands: CommandConfig[] | undefined; injected: InjectedCapabilityCommand[] } {
  const commands = new Map<string, CommandConfig>();
  for (const item of baseCommands ?? []) {
    if (typeof item.name !== 'string' || item.name.trim().length === 0) continue;
    commands.set(item.name, {
      name: item.name,
      content: item.content,
    });
  }

  const injected: InjectedCapabilityCommand[] = [];
  if (policy?.injectCapabilities) {
    const requested = normalizeStringArray(policy.capabilityIds);
    const requestedSet = requested.length > 0 ? new Set(requested) : null;
    const namespace = normalizeNamespace(policy.commandNamespace);

    for (const capability of resolveAvailableCliCapabilities()) {
      if (requestedSet && !requestedSet.has(capability.id)) {
        continue;
      }

      const commandName = `${namespace}${toSnakeCase(capability.id)}`;
      if (commands.has(commandName)) {
        continue;
      }

      const commandLine = [capability.command, ...(capability.defaultArgs ?? [])]
        .map(escapeShellArg)
        .join(' ');

      commands.set(commandName, {
        name: commandName,
        content: commandLine,
      });

      injected.push({
        capabilityId: capability.id,
        capabilityName: capability.name,
        commandName,
        commandLine,
        description: capability.description,
      });
    }
  }

  return {
    commands: commands.size > 0 ? Array.from(commands.values()) : undefined,
    injected,
  };
}

function normalizeStringArray(values: string[] | undefined): string[] {
  if (!values) return [];
  return Array.from(
    new Set(
      values
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
}

function normalizeNamespace(value: string | undefined): string {
  const fallback = 'cap_';
  if (!value) return fallback;
  const normalized = value.trim();
  if (normalized.length === 0) return fallback;
  return normalized;
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function escapeShellArg(value: string): string {
  if (value.length === 0) return "''";
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
