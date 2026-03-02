export type BaseAgentRole = 'orchestrator' | 'reviewer' | 'executor' | 'searcher';

const CORE_EXECUTION_TOOLS = [
  'shell.exec',
  'exec_command',
  'write_stdin',
  'apply_patch',
  'view_image',
  'web_search',
  'update_plan',
  'context_ledger.memory',
] as const;

const READ_ONLY_COORDINATION_TOOLS = [
  'shell.exec',
  'exec_command',
  'write_stdin',
  'view_image',
  'web_search',
  'update_plan',
  'context_ledger.memory',
] as const;

const ORCHESTRATION_TOOLS = [
  'agent.list',
  'agent.capabilities',
  'agent.deploy',
  'agent.dispatch',
  'agent.control',
  'orchestrator.loop_templates',
  'user.ask',
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
  orchestrator: {
    role: 'orchestrator',
    description: 'Default planner/dispatcher role. Has full tools for orchestration, experiment, and verification, while delegating production coding to executor.',
    allowedTools: [...ORCHESTRATOR_FULL_TOOLS],
    defaultLedgerCanReadAll: true,
  },
  reviewer: {
    role: 'reviewer',
    description: 'Verification role. Focuses on evidence, risk, and regression checks.',
    allowedTools: ['shell.exec', 'exec_command', 'view_image', 'web_search', 'context_ledger.memory'],
    defaultLedgerCanReadAll: false,
  },
  executor: {
    role: 'executor',
    description: 'Execution role. Performs concrete task execution with verifiable outputs.',
    allowedTools: [...CORE_EXECUTION_TOOLS],
    defaultLedgerCanReadAll: false,
  },
  searcher: {
    role: 'searcher',
    description: 'Retrieval role. Prioritizes source discovery, comparison, and evidence collection.',
    allowedTools: ['web_search', 'context_ledger.memory'],
    defaultLedgerCanReadAll: false,
  },
};

export function resolveBaseAgentRole(roleProfile: string | undefined): BaseAgentRole {
  const normalized = (roleProfile ?? '').trim().toLowerCase();
  if (!normalized) return 'orchestrator';
  if (normalized === 'general' || normalized === 'finger-general') return 'orchestrator';
  if (normalized === 'orchestrator' || normalized.includes('orchestr')) return 'orchestrator';
  if (normalized === 'reviewer' || normalized.includes('review')) return 'reviewer';
  if (normalized === 'searcher' || normalized.includes('search') || normalized.includes('research')) return 'searcher';
  if (
    normalized === 'executor'
    || normalized.includes('execut')
    || normalized.includes('coder')
    || normalized.includes('code')
    || normalized === 'coding-cli'
    || normalized.includes('coding')
  ) {
    return 'executor';
  }
  return 'orchestrator';
}
