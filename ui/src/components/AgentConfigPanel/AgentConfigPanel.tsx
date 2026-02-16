import React, { useState } from 'react';
import type { AgentConfig, ModuleInfo } from '../../api/types.js';
import './AgentConfigPanel.css';

interface AgentConfigPanelProps {
  isOpen: boolean;
  onClose: () => void;
  agent: ModuleInfo | null;
  onDeploy: (config: AgentConfig & { instanceCount: number }) => Promise<void>;
}

export const AgentConfigPanel: React.FC<AgentConfigPanelProps> = ({
  isOpen,
  onClose,
  agent,
  onDeploy,
}) => {
  const [config, setConfig] = useState<AgentConfig & { instanceCount: number }>({
    name: agent?.name || '',
    mode: 'auto',
    provider: 'iflow',
    model: '',
    systemPrompt: '',
    allowedTools: [],
    disallowedTools: [],
    permissionMode: 'default',
    maxTurns: 10,
    maxIterations: 5,
    maxRounds: 10,
    enableReview: false,
    cwd: '',
    resumeSession: false,
    instanceCount: 1,
  });
  
  const [isDeploying, setIsDeploying] = useState(false);
  const [activeTab, setActiveTab] = useState<'basic' | 'advanced' | 'runtime'>('basic');

  if (!isOpen || !agent) return null;

  const handleDeploy = async () => {
    setIsDeploying(true);
    try {
      await onDeploy(config);
      onClose();
    } finally {
      setIsDeploying(false);
    }
  };

  const toolsList = [
    'web_search', 'fetch_url', 'read_file', 'write_file', 'shell_exec',
    'code_edit', 'git_commit', 'test_run', 'deploy',
  ];

  return (
    <div className="agent-config-overlay" onClick={onClose}>
      <div className="agent-config-panel" onClick={(e) => e.stopPropagation()}>
        <div className="agent-config-header">
          <h2>配置 Agent: {agent.name}</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="agent-config-tabs">
          <button
            className={activeTab === 'basic' ? 'active' : ''}
            onClick={() => setActiveTab('basic')}
          >
            基础配置
          </button>
          <button
            className={activeTab === 'advanced' ? 'active' : ''}
            onClick={() => setActiveTab('advanced')}
          >
            高级参数
          </button>
          <button
            className={activeTab === 'runtime' ? 'active' : ''}
            onClick={() => setActiveTab('runtime')}
          >
            运行时
          </button>
        </div>

        <div className="agent-config-content">
          {activeTab === 'basic' && (
            <div className="config-section">
              <div className="form-group">
                <label>名称</label>
                <input
                  type="text"
                  value={config.name}
                  onChange={(e) => setConfig({ ...config, name: e.target.value })}
                  placeholder="Agent 名称"
                />
              </div>

              <div className="form-group">
                <label>模式</label>
                <select
                  value={config.mode}
                  onChange={(e) => setConfig({ ...config, mode: e.target.value as 'auto' | 'manual' })}
                >
                  <option value="auto">自动 (Auto)</option>
                  <option value="manual">手动 (Manual)</option>
                </select>
              </div>

              <div className="form-group">
                <label>Provider</label>
                <select
                  value={config.provider}
                  onChange={(e) => setConfig({ ...config, provider: e.target.value as 'iflow' | 'openai' | 'anthropic' })}
                >
                  <option value="iflow">iFlow</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                </select>
              </div>

              <div className="form-group">
                <label>模型</label>
                <input
                  type="text"
                  value={config.model}
                  onChange={(e) => setConfig({ ...config, model: e.target.value })}
                  placeholder="gpt-4, claude-3-opus, 等"
                />
              </div>

              <div className="form-group">
                <label>系统提示词 (System Prompt)</label>
                <textarea
                  value={config.systemPrompt}
                  onChange={(e) => setConfig({ ...config, systemPrompt: e.target.value })}
                  rows={6}
                  placeholder="定义 Agent 的角色和行为..."
                />
              </div>
            </div>
          )}

          {activeTab === 'advanced' && (
            <div className="config-section">
              <div className="form-row">
                <div className="form-group">
                  <label>最大轮次 (Max Rounds)</label>
                  <input
                    type="number"
                    value={config.maxRounds}
                    onChange={(e) => setConfig({ ...config, maxRounds: parseInt(e.target.value) })}
                    min={1}
                    max={50}
                  />
                </div>
                <div className="form-group">
                  <label>最大迭代 (Max Iterations)</label>
                  <input
                    type="number"
                    value={config.maxIterations}
                    onChange={(e) => setConfig({ ...config, maxIterations: parseInt(e.target.value) })}
                    min={1}
                    max={20}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>权限模式</label>
                <select
                  value={config.permissionMode}
                  onChange={(e) => setConfig({ ...config, permissionMode: e.target.value as any })}
                >
                  <option value="default">默认</option>
                  <option value="autoEdit">自动编辑</option>
                  <option value="yolo">YOLO (无确认)</option>
                  <option value="plan">计划模式</option>
                </select>
              </div>

              <div className="form-group">
                <label>启用审查 (Enable Review)</label>
                <input
                  type="checkbox"
                  checked={config.enableReview}
                  onChange={(e) => setConfig({ ...config, enableReview: e.target.checked })}
                />
              </div>

              <div className="form-group">
                <label>允许的工具</label>
                <div className="tools-grid">
                  {toolsList.map((tool) => (
                    <label key={tool} className="tool-checkbox">
                      <input
                        type="checkbox"
                        checked={config.allowedTools?.includes(tool)}
                        onChange={(e) => {
                          const tools = e.target.checked
                            ? [...(config.allowedTools || []), tool]
                            : (config.allowedTools || []).filter((t) => t !== tool);
                          setConfig({ ...config, allowedTools: tools });
                        }}
                      />
                      {tool}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'runtime' && (
            <div className="config-section">
              <div className="form-group">
                <label>工作目录 (CWD)</label>
                <input
                  type="text"
                  value={config.cwd}
                  onChange={(e) => setConfig({ ...config, cwd: e.target.value })}
                  placeholder="/path/to/project"
                />
              </div>

              <div className="form-group">
                <label>恢复会话</label>
                <input
                  type="checkbox"
                  checked={config.resumeSession}
                  onChange={(e) => setConfig({ ...config, resumeSession: e.target.checked })}
                />
              </div>

              <div className="form-group highlight">
                <label>部署实例数量</label>
                <div className="instance-control">
                  <button
                    onClick={() => setConfig({ ...config, instanceCount: Math.max(1, config.instanceCount - 1) })}
                  >
                    −
                  </button>
                  <span className="instance-count">{config.instanceCount}</span>
                  <button
                    onClick={() => setConfig({ ...config, instanceCount: Math.min(10, config.instanceCount + 1) })}
                  >
                    +
                  </button>
                </div>
                <small>将创建 {config.instanceCount} 个并行 Agent 实例</small>
              </div>
            </div>
          )}
        </div>

        <div className="agent-config-footer">
          <button className="btn-secondary" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" onClick={handleDeploy} disabled={isDeploying}>
            {isDeploying ? '部署中...' : `部署到 Canvas (${config.instanceCount} 实例)`}
          </button>
        </div>
      </div>
    </div>
  );
};
