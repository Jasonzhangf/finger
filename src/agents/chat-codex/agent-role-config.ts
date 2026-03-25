export type BaseAgentRole = 'system' | 'project' | 'reviewer';

const CORE_EXECUTION_TOOLS = [
  'shell.exec',
  'exec_command',
  'write_stdin',
  'apply_patch',
  'view_image',
  'web_search',
  'update_plan',
  'context_ledger.memory',
  'clock',
  'command.exec',
] as const;

const MAILBOX_TOOLS = [
  'mailbox.status',
  'mailbox.list',
  'mailbox.read',
  'mailbox.read_all',
  'mailbox.ack',
  'mailbox.remove',
  'mailbox.remove_all',
] as const;

const READ_ONLY_COORDINATION_TOOLS = [
  'shell.exec',
  'exec_command',
  'write_stdin',
  'view_image',
  'web_search',
  'update_plan',
  'context_ledger.memory',
  'clock',
  'command.exec',
] as const;

const ORCHESTRATION_TOOLS = [
  'agent.list',
  'agent.capabilities',
  'agent.deploy',
  'agent.dispatch',
  'agent.control',
  'orchestrator.loop_templates',
  'user.ask',
  'clock',
  'command.exec',
] as const;

const ORCHESTRATOR_DOCUMENTATION_TOOLS = [
  'apply_patch',
] as const;

function dedupeTools(...groups: ReadonlyArray<ReadonlyArray<string>>): string[] {
  return Array.from(new Set(groups.flatMap((group) => group)));
}

const ORCHESTRATOR_FULL_TOOLS = dedupeTools(
  [...CORE_EXECUTION_TOOLS],
  [...ORCHESTRATION_TOOLS],
  [...READ_ONLY_COORDINATION_TOOLS],
  [...ORCHESTRATOR_DOCUMENTATION_TOOLS],
);

export interface BaseAgentRoleConfig {
  role: BaseAgentRole;
  description: string;
  allowedTools: string[];
  defaultLedgerCanReadAll: boolean;
}

export const BASE_AGENT_ROLE_CONFIG: Record<BaseAgentRole, BaseAgentRoleConfig> = {
  system: {
    role: 'system',
    description: 'System agent. Owns system-level coordination, registry access, and cross-project dispatch.',
    allowedTools: dedupeTools([...ORCHESTRATOR_FULL_TOOLS], [...MAILBOX_TOOLS]),
    defaultLedgerCanReadAll: true,
  },
  project: {
    role: 'project',
    description: 'Project agent. Handles project-scoped planning, coding, execution, and verification work.',
    allowedTools: dedupeTools([...ORCHESTRATOR_FULL_TOOLS], [...MAILBOX_TOOLS], ['report-task-completion']),
    defaultLedgerCanReadAll: true,
  },
  reviewer: {
    role: 'reviewer',
    description: 'Reviewer agent. Focuses on evidence, risk, regression checks, and mailbox-driven review tasks.',
    allowedTools: dedupeTools(
      ['shell.exec', 'exec_command', 'view_image', 'web_search', 'context_ledger.memory', 'user.ask'],
      [...MAILBOX_TOOLS],
    ),
    defaultLedgerCanReadAll: false,
  },
};

export function resolveBaseAgentRole(roleProfile: string | undefined): BaseAgentRole {
  const normalized = (roleProfile ?? '').trim().toLowerCase();
  if (!normalized) return 'project';
  if (normalized === 'system' || normalized.includes('finger-system')) return 'system';
  if (normalized === 'reviewer' || normalized.includes('review')) return 'reviewer';
  return 'project';
}
