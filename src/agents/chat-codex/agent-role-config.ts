export type BaseAgentRole = 'system' | 'project' | 'reviewer';

const CORE_EXECUTION_TOOLS = [
  'exec_command',
  'write_stdin',
  'apply_patch',
  'view_image',
  'send_local_image',
  'web_search',
  'update_plan',
  'context_ledger.memory',
  'context_ledger.expand_task',
  'context_builder.rebuild',
  'reasoning.stop',
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

const SKILLS_TOOLS = [
  'skills.list',
  'skills.status',
] as const;

const READ_ONLY_COORDINATION_TOOLS = [
  'exec_command',
  'write_stdin',
  'view_image',
  'web_search',
  'update_plan',
  'context_ledger.memory',
  'context_ledger.expand_task',
  'context_builder.rebuild',
  'clock',
  'command.exec',
] as const;

const ORCHESTRATION_TOOLS = [
  'agent.list',
  'agent.capabilities',
  'agent.deploy',
  'agent.dispatch',
  'agent.continue',
  'agent.query',
  'agent.progress.ask',
  'agent.control',
  'orchestrator.loop_templates',
  'user.ask',
  'clock',
  'command.exec',
] as const;

const ORCHESTRATOR_DOCUMENTATION_TOOLS = [
  'apply_patch',
] as const;

const PROJECT_TASK_MANAGEMENT_TOOLS = [
  'project.task.status',
  'project.task.update',
] as const;

const SYSTEM_ONLY_CONTROL_TOOLS = [
  'reasoning.stop_policy',
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
    allowedTools: dedupeTools(
      [...ORCHESTRATOR_FULL_TOOLS],
      [...MAILBOX_TOOLS],
      [...SKILLS_TOOLS],
      [...PROJECT_TASK_MANAGEMENT_TOOLS],
      [...SYSTEM_ONLY_CONTROL_TOOLS],
    ),
    defaultLedgerCanReadAll: true,
  },
  project: {
    role: 'project',
    description: 'Project agent. Handles project-scoped planning, coding, execution, and verification work.',
    allowedTools: dedupeTools([...ORCHESTRATOR_FULL_TOOLS], [...MAILBOX_TOOLS], [...SKILLS_TOOLS], ['report-task-completion']),
    defaultLedgerCanReadAll: true,
  },
  reviewer: {
    role: 'reviewer',
    description: 'Reviewer agent. Focuses on evidence, risk, regression checks, and mailbox-driven review tasks.',
    allowedTools: dedupeTools(
      [
        'exec_command',
        'view_image',
        'web_search',
        'context_ledger.memory',
        'context_ledger.expand_task',
        'context_builder.rebuild',
        'reasoning.stop',
        'user.ask',
        'report-task-completion',
      ],
      [...MAILBOX_TOOLS],
      [...SKILLS_TOOLS],
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
