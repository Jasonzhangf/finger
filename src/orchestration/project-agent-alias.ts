import path from 'path';
import { listAgents, type AgentInfo } from '../agents/finger-system-agent/registry.js';

export interface ProjectAgentAliasEntry {
  alias: string;
  baseAlias: string;
  projectId: string;
  projectPath: string;
  projectName: string;
  agentId: string;
  monitored: boolean;
}

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._#-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function toBaseAlias(agent: AgentInfo): string {
  const fromPath = path.basename((agent.projectPath || '').replace(/\\/g, '/').replace(/\/+$/, ''));
  const candidate = normalizeAlias(fromPath || agent.projectName || agent.projectId || 'project');
  return candidate || 'project';
}

function toSortTimestamp(agent: AgentInfo): number {
  const ts = agent.monitorUpdatedAt || agent.lastHeartbeat || '';
  const value = Date.parse(ts);
  return Number.isFinite(value) ? value : 0;
}

export async function listProjectAgentAliases(options?: { monitoredOnly?: boolean }): Promise<ProjectAgentAliasEntry[]> {
  const monitoredOnly = options?.monitoredOnly !== false;
  const agents = await listAgents();
  const filtered = monitoredOnly ? agents.filter((agent) => agent.monitored === true) : agents;

  const sorted = filtered.slice().sort((a, b) => toSortTimestamp(b) - toSortTimestamp(a));
  const seen = new Map<string, number>();
  const entries: ProjectAgentAliasEntry[] = [];

  for (const agent of sorted) {
    const baseAlias = toBaseAlias(agent);
    const count = (seen.get(baseAlias) ?? 0) + 1;
    seen.set(baseAlias, count);
    const alias = count === 1 ? baseAlias : `${baseAlias}#${count}`;
    entries.push({
      alias,
      baseAlias,
      projectId: agent.projectId,
      projectPath: agent.projectPath,
      projectName: agent.projectName,
      agentId: agent.agentId,
      monitored: agent.monitored === true,
    });
  }

  return entries;
}

export type ResolveAliasResult =
  | { ok: true; entry: ProjectAgentAliasEntry }
  | { ok: false; reason: 'not_found'; query: string; candidates: ProjectAgentAliasEntry[] }
  | { ok: false; reason: 'ambiguous'; query: string; candidates: ProjectAgentAliasEntry[] };

export async function resolveProjectAgentAlias(aliasRaw: string): Promise<ResolveAliasResult> {
  const query = normalizeAlias(aliasRaw);
  const entries = await listProjectAgentAliases({ monitoredOnly: true });
  if (!query) {
    return { ok: false, reason: 'not_found', query, candidates: entries };
  }

  const exact = entries.find((entry) => normalizeAlias(entry.alias) === query);
  if (exact) return { ok: true, entry: exact };

  const baseMatches = entries.filter((entry) => normalizeAlias(entry.baseAlias) === query);
  if (baseMatches.length === 1) return { ok: true, entry: baseMatches[0] };
  if (baseMatches.length > 1) {
    return { ok: false, reason: 'ambiguous', query, candidates: baseMatches };
  }

  return { ok: false, reason: 'not_found', query, candidates: entries };
}

