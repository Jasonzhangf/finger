import React, { useState } from 'react';
import './BottomPanel.css';

type Tab = 'stats' | 'agents' | 'load' | 'config';

interface Agent {
  id: string;
  name: string;
  role: string;
  status: 'idle' | 'busy' | 'error';
  load: number;
  tasks: number;
  errorRate: number;
  tokens: number;
  uptime: number;
}

export const BottomPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('agents');

  const stats = {
    total: 24,
    completed: 18,
    today: 6,
    activeAgents: 5,
    totalAgents: 8,
    errorRate: 2.3,
    tokens: 1.2,
  };

  const agents: Agent[] = [
    { id: 'orch-1', name: 'orchestrator-1', role: 'orchestrator', status: 'busy', load: 45, tasks: 2, errorRate: 0, tokens: 32000, uptime: 3600 },
    { id: 'exec-2', name: 'executor-2', role: 'executor', status: 'busy', load: 78, tasks: 3, errorRate: 1.2, tokens: 85000, uptime: 7200 },
    { id: 'rev-1', name: 'reviewer-1', role: 'reviewer', status: 'idle', load: 0, tasks: 0, errorRate: 0, tokens: 12000, uptime: 1800 },
    { id: 'test-3', name: 'tester-3', role: 'tester', status: 'error', load: 12, tasks: 1, errorRate: 15, tokens: 5000, uptime: 900 },
    { id: 'arch-1', name: 'architect-1', role: 'architect', status: 'idle', load: 5, tasks: 0, errorRate: 0, tokens: 45000, uptime: 5400 },
  ];

  const getStatusColor = (status: Agent['status']) => {
    switch (status) {
      case 'idle': return '#2ecc71';
      case 'busy': return '#f1c40f';
      case 'error': return '#e74c3c';
    }
  };

  const formatUptime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  };

  return (
    <div className="bottom-panel-container">
      <div className="panel-tabs">
        <button className={activeTab === 'stats' ? 'active' : ''} onClick={() => setActiveTab('stats')}>Task Stats</button>
        <button className={activeTab === 'agents' ? 'active' : ''} onClick={() => setActiveTab('agents')}>Agent Management</button>
        <button className={activeTab === 'load' ? 'active' : ''} onClick={() => setActiveTab('load')}>Load Monitor</button>
        <button className={activeTab === 'config' ? 'active' : ''} onClick={() => setActiveTab('config')}>Config</button>
      </div>

      <div className="panel-content">
        {activeTab === 'stats' && (
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-label">Total Tasks</div>
              <div className="stat-value">{stats.total}</div>
              <div className="stat-sub">+{stats.today} today</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Completed</div>
              <div className="stat-value">{stats.completed}</div>
              <div className="stat-sub">{((stats.completed / stats.total) * 100).toFixed(0)}% rate</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Active Agents</div>
              <div className="stat-value">{stats.activeAgents}/{stats.totalAgents}</div>
              <div className="stat-sub">{stats.totalAgents - stats.activeAgents} idle</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Error Rate</div>
              <div className="stat-value">{stats.errorRate}%</div>
              <div className="stat-sub">Last 1h</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Token Usage</div>
              <div className="stat-value">{stats.tokens}M</div>
              <div className="stat-sub">Est. ${((stats.tokens * 0.002)).toFixed(2)}</div>
            </div>
          </div>
        )}

        {activeTab === 'agents' && (
          <div className="agents-container">
            <div className="agents-grid">
              {agents.map((agent) => (
                <div key={agent.id} className={`agent-card ${agent.status}`}>
                  <div className="agent-header">
                    <span className="agent-dot" style={{ background: getStatusColor(agent.status) }} />
                    <span className="agent-name">{agent.name}</span>
                    <span className="agent-role">{agent.role}</span>
                  </div>
                  <div className="agent-metrics">
                    <div className="metric">
                      <span className="metric-label">Load</span>
                      <span className="metric-value">{agent.load}%</span>
                    </div>
                    <div className="metric">
                      <span className="metric-label">Tasks</span>
                      <span className="metric-value">{agent.tasks}</span>
                    </div>
                    <div className="metric">
                      <span className="metric-label">Errors</span>
                      <span className="metric-value">{agent.errorRate}%</span>
                    </div>
                    <div className="metric">
                      <span className="metric-label">Tokens</span>
                      <span className="metric-value">{(agent.tokens / 1000).toFixed(0)}k</span>
                    </div>
                    <div className="metric">
                      <span className="metric-label">Uptime</span>
                      <span className="metric-value">{formatUptime(agent.uptime)}</span>
                    </div>
                  </div>
                  <button className="add-to-canvas-btn">+ Add to Canvas</button>
                </div>
              ))}
            </div>
            <button className="add-agent-btn">+ New Agent</button>
          </div>
        )}

        {activeTab === 'load' && (
          <div className="load-container">
            <div className="load-bars">
              {agents.map((agent) => (
                <div key={agent.id} className="load-row">
                  <span className="load-name">{agent.name}</span>
                  <div className="load-bar-bg">
                    <div 
                      className="load-bar-fill" 
                      style={{ 
                        width: `${agent.load}%`,
                        background: agent.load > 80 ? '#e74c3c' : agent.load > 50 ? '#f1c40f' : '#2ecc71'
                      }} 
                    />
                  </div>
                  <span className="load-value">{agent.load}%</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'config' && (
          <div className="config-container">
            <div className="config-item">
              <label>Max Concurrent Tasks</label>
              <input type="number" defaultValue={5} />
            </div>
            <div className="config-item">
              <label>Auto-retry on Error</label>
              <input type="checkbox" defaultChecked />
            </div>
            <div className="config-item">
              <label>Task Timeout (minutes)</label>
              <input type="number" defaultValue={30} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
