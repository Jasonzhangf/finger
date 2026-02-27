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

export interface BaseAgentRoleConfig {
  role: BaseAgentRole;
  description: string;
  allowedTools: string[];
  defaultLedgerCanReadAll: boolean;
}

export const BASE_AGENT_ROLE_CONFIG: Record<BaseAgentRole, BaseAgentRoleConfig> = {
  orchestrator: {
    role: 'orchestrator',
    description: 'Default planner/dispatcher role. Prioritizes deploy+dispatch through standard agent tools.',
    allowedTools: [...READ_ONLY_COORDINATION_TOOLS, ...ORCHESTRATION_TOOLS],
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
  if (normalized === 'orchestrator' || normalized.includes('orchestr')) return 'orchestrator';
  if (normalized === 'reviewer' || normalized.includes('review')) return 'reviewer';
  if (normalized === 'searcher' || normalized.includes('search')) return 'searcher';
  if (
    normalized === 'executor'
    || normalized.includes('execut')
    || normalized === 'coding-cli'
    || normalized.includes('coding')
  ) {
    return 'executor';
  }
  return 'orchestrator';
}
