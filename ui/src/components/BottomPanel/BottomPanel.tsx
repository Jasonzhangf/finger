import React, { useMemo, useState } from 'react';
import type { AgentRuntime } from '../../api/types.js';
import type { AgentConfigSummary, AgentRuntimeInstance } from '../../hooks/useAgentRuntimePanel.js';
import { findConfigForAgent, isActiveInstanceStatus, matchInstanceToAgent } from './agentRuntimeUtils.js';
import './BottomPanel.css';

type Tab = 'overview' | 'agents' | 'instances';

interface BottomPanelProps {
  agents: AgentRuntime[];
  instances: AgentRuntimeInstance[];
  configs: AgentConfigSummary[];
  selectedAgentId?: string | null;
  currentSessionId?: string | null;
  isLoading?: boolean;
  error?: string | null;
  onSelectAgent?: (agentId: string) => void;
  onSelectInstance?: (instance: AgentRuntimeInstance) => void;
  onRefresh?: () => void;
}

function getStatusColor(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'error' || normalized === 'blocked') return '#ef4444';
  if (normalized === 'running' || normalized === 'deployed' || normalized === 'busy') return '#f59e0b';
  return '#22c55e';
}

function formatInstanceStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'deployed') return '已部署';
  if (normalized === 'busy' || normalized === 'running') return '运行中';
  if (normalized === 'blocked') return '阻塞';
  if (normalized === 'error') return '异常';
  if (normalized === 'released') return '已释放';
  return '空闲';
}

export const BottomPanel: React.FC<BottomPanelProps> = ({
  agents,
  instances,
  configs,
  selectedAgentId,
  currentSessionId,
  isLoading = false,
  error = null,
  onSelectAgent,
  onSelectInstance,
  onRefresh,
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('agents');

  const overview = useMemo(() => {
    const activeInstances = instances.filter((instance) => isActiveInstanceStatus(instance.status)).length;
    const boundSessions = instances.filter((instance) => typeof instance.sessionId === 'string' && instance.sessionId.length > 0).length;
    const erroredInstances = instances.filter((instance) => instance.status.toLowerCase() === 'error').length;
    return {
      totalAgents: agents.length,
      totalInstances: instances.length,
      activeInstances,
      idleInstances: Math.max(0, instances.length - activeInstances),
      boundSessions,
      erroredInstances,
      totalConfigs: configs.length,
    };
  }, [agents.length, configs.length, instances]);

  return (
    <div className="bottom-panel-container">
      <div className="panel-tabs">
        <button className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>Overview</button>
        <button className={activeTab === 'agents' ? 'active' : ''} onClick={() => setActiveTab('agents')}>Agent</button>
        <button className={activeTab === 'instances' ? 'active' : ''} onClick={() => setActiveTab('instances')}>Instance</button>
        <button className="refresh-btn" onClick={onRefresh} disabled={!onRefresh || isLoading}>刷新</button>
      </div>

      <div className="panel-content">
        {error && <div className="panel-error">⚠ {error}</div>}
        {isLoading && <div className="panel-loading">同步中...</div>}

        {activeTab === 'overview' && (
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-label">Agent</div>
              <div className="stat-value">{overview.totalAgents}</div>
              <div className="stat-sub">可管理角色</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Instance</div>
              <div className="stat-value">{overview.totalInstances}</div>
              <div className="stat-sub">运行实例总数</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Running</div>
              <div className="stat-value">{overview.activeInstances}</div>
              <div className="stat-sub">活跃实例</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Idle</div>
              <div className="stat-value">{overview.idleInstances}</div>
              <div className="stat-sub">空闲实例</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Bound Session</div>
              <div className="stat-value">{overview.boundSessions}</div>
              <div className="stat-sub">绑定会话</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Error</div>
              <div className="stat-value">{overview.erroredInstances}</div>
              <div className="stat-sub">异常实例</div>
            </div>
          </div>
        )}

        {activeTab === 'agents' && (
          <div className="agents-container">
            <div className="agents-grid">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  className={`agent-card ${agent.status} ${selectedAgentId === agent.id ? 'selected' : ''}`}
                  onClick={() => onSelectAgent?.(agent.id)}
                  type="button"
                >
                  <div className="agent-header">
                    <span className="agent-dot" style={{ background: getStatusColor(agent.status) }} />
                    <span className="agent-name">{agent.name}</span>
                    <span className="agent-role">{agent.type}</span>
                  </div>
                  <div className="agent-metrics">
                    <div className="metric">
                      <span className="metric-label">状态</span>
                      <span className="metric-value">{agent.status}</span>
                    </div>
                    <div className="metric">
                      <span className="metric-label">可用实例</span>
                      <span className="metric-value">
                        {instances.filter((instance) => matchInstanceToAgent(agent, instance)).length}
                      </span>
                    </div>
                    <div className="metric">
                      <span className="metric-label">已部署</span>
                      <span className="metric-value">
                        {instances.filter((instance) => matchInstanceToAgent(agent, instance) && isActiveInstanceStatus(instance.status)).length}
                      </span>
                    </div>
                  </div>
                  <div className="agent-config-ref">
                    {(() => {
                      const config = findConfigForAgent(agent, configs);
                      if (!config) return '无配置文件映射';
                      return `配置: ${config.id}`;
                    })()}
                  </div>
                </button>
              ))}
            </div>
            {agents.length === 0 && <div className="empty-state">当前没有可用 Agent</div>}
          </div>
        )}

        {activeTab === 'instances' && (
          <div className="instances-container">
            {instances.length === 0 && <div className="empty-state">暂无实例</div>}
            {instances.length > 0 && (
              <div className="instance-list">
                {instances.map((instance) => {
                  const switchable = typeof instance.sessionId === 'string' && instance.sessionId.length > 0;
                  const active = switchable && instance.sessionId === currentSessionId;
                  return (
                    <button
                      key={instance.id}
                      type="button"
                      className={`instance-row ${active ? 'active' : ''}`}
                      disabled={!switchable}
                      onClick={() => onSelectInstance?.(instance)}
                    >
                      <span className="instance-dot" style={{ background: getStatusColor(instance.status) }} />
                      <span className="instance-main">
                        <span className="instance-name">{instance.name}</span>
                        <span className="instance-meta">
                          {instance.id} · {formatInstanceStatus(instance.status)}
                          {instance.sessionId ? ` · 会话 ${instance.sessionId}` : ' · 未绑定会话'}
                        </span>
                      </span>
                      <span className="instance-switch">{switchable ? '切换会话' : '不可切换'}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'agents' && (
          <div className="agent-hint">
            点击 Agent 卡片打开左侧配置抽屉；点击 Instance 行可切换右侧会话面板。
          </div>
        )}

        {activeTab === 'instances' && (
          <div className="instance-hint">
            仅已绑定 `sessionId` 的实例支持会话切换。
          </div>
        )}

        {activeTab === 'overview' && (
          <div className="overview-hint">
            当前已加载配置 {overview.totalConfigs} 条。
          </div>
        )}
      </div>
    </div>
  );
};
