import type { OrchestrationAgentEntry, OrchestrationProfile } from './orchestration-config.js';

export type OrchestrationQuotaSource = 'project' | 'workflow' | 'default' | 'implicit-default';

export interface OrchestrationPromptAgent {
  id: string;
  role: OrchestrationAgentEntry['role'];
  quota: number;
  quotaSource: OrchestrationQuotaSource;
  workflowQuota?: Record<string, number>;
  isSelf?: boolean;
}

export interface OrchestrationPromptBuildResult {
  prompt: string | null;
  agents: OrchestrationPromptAgent[];
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function normalizeWorkflowQuota(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    const id = key.trim();
    if (!id) continue;
    const parsed = normalizeNonNegativeInteger(value);
    if (parsed === undefined) continue;
    normalized[id] = parsed;
  }
  return normalized;
}

function resolveQuotaDetails(entry: OrchestrationAgentEntry): {
  quota: number;
  source: OrchestrationQuotaSource;
  workflowQuota: Record<string, number>;
} {
  const projectQuota = normalizeNonNegativeInteger(entry.quotaPolicy?.projectQuota);
  const workflowQuota = normalizeWorkflowQuota(entry.quotaPolicy?.workflowQuota);
  const defaultQuota = normalizeNonNegativeInteger(entry.defaultQuota);

  if (projectQuota !== undefined) {
    return { quota: projectQuota, source: 'project', workflowQuota };
  }

  if (defaultQuota !== undefined) {
    return { quota: defaultQuota, source: 'default', workflowQuota };
  }

  const workflowValues = Object.values(workflowQuota);
  if (workflowValues.length > 0) {
    const maxQuota = Math.max(0, ...workflowValues);
    return { quota: maxQuota, source: 'workflow', workflowQuota };
  }

  return { quota: 1, source: 'implicit-default', workflowQuota };
}

function hasAnyPositiveQuota(details: { quota: number; workflowQuota: Record<string, number> }): boolean {
  if (details.quota > 0) return true;
  return Object.values(details.workflowQuota).some((value) => value > 0);
}

function formatWorkflowQuotaMap(workflowQuota: Record<string, number>): string | null {
  const entries = Object.entries(workflowQuota)
    .filter(([, value]) => value > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  const pairs = entries.map(([id, value]) => `${id}=${value}`);
  return pairs.join(', ');
}

function formatAgentLine(agent: OrchestrationPromptAgent): string {
  const parts = [`role=${agent.role}`, `quota=${agent.quota}`, `source=${agent.quotaSource}`];
  const workflowDetails = agent.workflowQuota ? formatWorkflowQuotaMap(agent.workflowQuota) : null;
  if (workflowDetails) parts.push(`workflow=${workflowDetails}`);
  if (agent.isSelf) parts.push('self');
  return `- ${agent.id} (${parts.join(', ')})`;
}

export function buildOrchestrationDispatchPrompt(
  profile: OrchestrationProfile,
  options: { selfAgentId?: string } = {},
): OrchestrationPromptBuildResult {
  const agents: OrchestrationPromptAgent[] = [];
  const selfAgentId = (options.selfAgentId ?? '').trim();

  for (const entry of profile.agents) {
    if (entry.enabled === false) continue;
    const quotaDetails = resolveQuotaDetails(entry);
    if (!hasAnyPositiveQuota(quotaDetails)) continue;
    agents.push({
      id: entry.targetAgentId,
      role: entry.role,
      quota: quotaDetails.quota,
      quotaSource: quotaDetails.source,
      workflowQuota: Object.keys(quotaDetails.workflowQuota).length > 0 ? quotaDetails.workflowQuota : undefined,
      ...(selfAgentId && entry.targetAgentId === selfAgentId ? { isSelf: true } : {}),
    });
  }

  agents.sort((a, b) => a.id.localeCompare(b.id));

  if (agents.length === 0) {
    return { prompt: null, agents };
  }

  const lines = [
    '[orchestration_dispatch_policy]',
    'Only agents listed below have quota and are eligible dispatch targets. Do not dispatch to unlisted agents.',
    'Available agents (quota > 0):',
    ...agents.map(formatAgentLine),
    'Quota meaning: quota is the max dispatch capacity (project/workflow/default). Respect it and avoid over-dispatch.',
    'Dispatch selection: use `agent.list` / `agent.capabilities` to choose targets dynamically; never hardcode agent ids.',
    'Search delegation: for tasks that need substantial web search, extract search goals, dispatch to researcher, wait for results, then write key facts into `context_ledger.memory` before proceeding.',
  ];

  return {
    prompt: lines.join('\n'),
    agents,
  };
}
