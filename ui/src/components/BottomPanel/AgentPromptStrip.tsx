import React, { useMemo } from 'react';
import type { AgentConfigSummary, AgentRuntimePanelAgent } from '../../hooks/useAgentRuntimePanel.js';
import './AgentPromptStrip.css';

interface AgentPromptStripProps {
  configAgents: AgentRuntimePanelAgent[];
  runtimeAgents: AgentRuntimePanelAgent[];
  configs: AgentConfigSummary[];
  selectedAgentConfigId?: string | null;
  onSelectAgentConfig?: (agentId: string) => void;
}

const PINNED_AGENT_IDS = new Set([
  'finger-system-agent',
  'finger-project-agent',
  'finger-review-agent',
  'finger-context-agent',
]);

function isPinnedAgent(agentId: string): boolean {
  if (PINNED_AGENT_IDS.has(agentId)) return true;
  if (agentId.startsWith('project:')) return true;
  if (agentId.includes('review')) return true;
  if (agentId.includes('context')) return true;
  return false;
}

function resolveStatus(agentId: string, runtimeAgents: AgentRuntimePanelAgent[]): string {
  const runtime = runtimeAgents.find((a) => a.id === agentId);
  return runtime?.status ?? 'idle';
}

function statusBadgeClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'running' || s === 'busy' || s === 'deployed') return 'running';
  if (s === 'failed' || s === 'error' || s === 'blocked') return 'error';
  return 'idle';
}

export const AgentPromptStrip: React.FC<AgentPromptStripProps> = ({
  configAgents,
  runtimeAgents,
  selectedAgentConfigId,
  onSelectAgentConfig,
}) => {
  const pinnedAgents = useMemo(() => {
    const byId = new Map(configAgents.map((a) => [a.id, a]));
    return Array.from(byId.values())
      .filter((agent) => isPinnedAgent(agent.id))
      .sort((a, b) => {
        const rank = (id: string): number => {
          if (id === 'finger-system-agent') return 0;
          if (id === 'finger-project-agent') return 1;
          if (id.includes('review')) return 2;
          if (id.includes('context')) return 3;
          return 10;
        };
        const d = rank(a.id) - rank(b.id);
        if (d !== 0) return d;
        return a.id.localeCompare(b.id);
      });
  }, [configAgents]);

  return (
    <div className="agent-prompt-strip">
      <div className="agent-prompt-strip-title">Prompt 快捷栏</div>
      <div className="agent-prompt-strip-list">
        {pinnedAgents.map((agent) => {
          const status = resolveStatus(agent.id, runtimeAgents);
          const selected = selectedAgentConfigId === agent.id;
          return (
            <button
              key={agent.id}
              className={`agent-prompt-chip ${selected ? 'selected' : ''}`}
              onClick={() => onSelectAgentConfig?.(agent.id)}
              title={agent.name || agent.id}
            >
              <span className="chip-name">{agent.name || agent.id}</span>
              <span className={`chip-status ${statusBadgeClass(status)}`}>{status}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
