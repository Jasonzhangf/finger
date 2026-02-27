import { useEffect, useMemo, useState } from 'react';
import type { AgentConfig, AgentRuntime } from '../../api/types.js';
import type { AgentConfigSummary, AgentRuntimeInstance, AgentRuntimePanelAgent } from '../../hooks/useAgentRuntimePanel.js';
import { isActiveInstanceStatus } from '../BottomPanel/agentRuntimeUtils.js';
import './AgentConfigDrawer.css';

interface AgentDeployDraft {
  mode: 'auto' | 'manual';
  provider: 'iflow' | 'openai' | 'anthropic';
  model: string;
  permissionMode: 'default' | 'autoEdit' | 'yolo' | 'plan';
  maxRounds: number;
  enableReview: boolean;
  instanceCount: number;
}

interface AgentConfigDrawerProps {
  isOpen: boolean;
  agent: AgentRuntime | null;
  capabilities?: AgentRuntimePanelAgent['capabilities'] | null;
  config: AgentConfigSummary | null;
  instances: AgentRuntimeInstance[];
  currentSessionId?: string | null;
  onClose: () => void;
  onSwitchInstance?: (instance: AgentRuntimeInstance) => void;
  onDeployConfig?: (payload: { config: AgentConfig; instanceCount: number }) => Promise<void>;
  onControlAgent?: (payload: {
    action: 'status' | 'pause' | 'resume' | 'interrupt' | 'cancel';
    targetAgentId?: string;
    sessionId?: string;
    workflowId?: string;
    providerId?: string;
    hard?: boolean;
  }) => Promise<{
    ok: boolean;
    action?: string;
    status?: string;
    result?: unknown;
    error?: string;
  }>;
}

function toToolList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function pickDefaultDraft(agent: AgentRuntime | null): AgentDeployDraft {
  const sourceConfig = (agent?.config ?? {}) as AgentConfig;
  return {
    mode: sourceConfig.mode ?? 'auto',
    provider: sourceConfig.provider ?? 'iflow',
    model: sourceConfig.model ?? '',
    permissionMode: sourceConfig.permissionMode ?? 'default',
    maxRounds: Number.isFinite(sourceConfig.maxRounds) ? Math.max(1, Number(sourceConfig.maxRounds)) : 10,
    enableReview: sourceConfig.enableReview === true,
    instanceCount: Number.isFinite(agent?.instanceCount) ? Math.max(1, Number(agent?.instanceCount)) : 1,
  };
}

export const AgentConfigDrawer = ({
  isOpen,
  agent,
  capabilities,
  config,
  instances,
  currentSessionId,
  onClose,
  onSwitchInstance,
  onDeployConfig,
  onControlAgent,
}: AgentConfigDrawerProps) => {
  const [draft, setDraft] = useState<AgentDeployDraft>(() => pickDefaultDraft(agent));
  const [isDeploying, setIsDeploying] = useState(false);
  const [isControlling, setIsControlling] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    setDraft(pickDefaultDraft(agent));
    setHint(null);
  }, [agent?.id]);

  const allowTools = useMemo(
    () =>
      capabilities?.governance?.whitelist
      ?? toToolList(
        config?.tools
        && (((config.tools as Record<string, unknown>).whitelist) ?? (config.tools as Record<string, unknown>).allow),
      ),
    [capabilities?.governance?.whitelist, config?.tools],
  );
  const denyTools = useMemo(
    () =>
      capabilities?.governance?.blacklist
      ?? toToolList(
        config?.tools
        && (((config.tools as Record<string, unknown>).blacklist) ?? (config.tools as Record<string, unknown>).deny),
      ),
    [capabilities?.governance?.blacklist, config?.tools],
  );
  const authTools = useMemo(
    () => capabilities?.governance?.authorizationRequired ?? [],
    [capabilities?.governance?.authorizationRequired],
  );
  const exposedTools = useMemo(
    () => capabilities?.execution?.exposedTools ?? [],
    [capabilities?.execution?.exposedTools],
  );
  const dispatchTargets = useMemo(
    () => capabilities?.execution?.dispatchTargets ?? [],
    [capabilities?.execution?.dispatchTargets],
  );
  const capabilityTags = useMemo(
    () => capabilities?.summary?.tags ?? [],
    [capabilities?.summary?.tags],
  );
  const activeInstance = useMemo(
    () => instances.find((instance) => instance.sessionId === currentSessionId) ?? instances[0] ?? null,
    [currentSessionId, instances],
  );
  const deployedCount = useMemo(() => instances.filter((instance) => isActiveInstanceStatus(instance.status)).length, [instances]);

  if (!isOpen || !agent) return null;

  const handleDeploy = async (): Promise<void> => {
    if (!onDeployConfig) return;
    setIsDeploying(true);
    setHint(null);
    try {
      await onDeployConfig({
        config: {
          id: agent.id,
          name: agent.name,
          mode: draft.mode,
          provider: draft.provider,
          model: draft.model.trim() || undefined,
          permissionMode: draft.permissionMode,
          maxRounds: draft.maxRounds,
          enableReview: draft.enableReview,
        },
        instanceCount: draft.instanceCount,
      });
      setHint('部署请求已提交');
    } catch (error) {
      setHint(error instanceof Error ? error.message : '部署失败');
    } finally {
      setIsDeploying(false);
    }
  };

  const handleControl = async (action: 'status' | 'pause' | 'resume' | 'interrupt' | 'cancel'): Promise<void> => {
    if (!onControlAgent) return;
    setIsControlling(true);
    setHint(null);
    try {
      const result = await onControlAgent({
        action,
        targetAgentId: agent.id,
        ...(activeInstance?.sessionId ? { sessionId: activeInstance.sessionId } : currentSessionId ? { sessionId: currentSessionId } : {}),
        ...(activeInstance?.workflowId ? { workflowId: activeInstance.workflowId } : {}),
      });
      if (result.ok) {
        setHint(`${action} 完成 (${result.status ?? 'completed'})`);
      } else {
        setHint(result.error ?? `${action} 失败`);
      }
    } catch (error) {
      setHint(error instanceof Error ? error.message : `${action} 失败`);
    } finally {
      setIsControlling(false);
    }
  };

  return (
    <div className="agent-drawer-overlay" onClick={onClose}>
      <aside className="agent-drawer" onClick={(event) => event.stopPropagation()}>
        <header className="agent-drawer-header">
          <div className="agent-drawer-title">
            <div className="agent-drawer-name">{agent.name}</div>
            <div className="agent-drawer-meta">{agent.id} · {agent.type}</div>
          </div>
          <button type="button" className="agent-drawer-close" onClick={onClose}>关闭</button>
        </header>

        <section className="agent-drawer-section">
          <div className="agent-stat-grid">
            <div className="agent-stat">
              <span className="label">状态</span>
              <span className="value">{agent.status}</span>
            </div>
            <div className="agent-stat">
              <span className="label">实例总数</span>
              <span className="value">{instances.length}</span>
            </div>
            <div className="agent-stat">
              <span className="label">已部署</span>
              <span className="value">{deployedCount}</span>
            </div>
            <div className="agent-stat">
              <span className="label">配置来源</span>
              <span className="value">{config?.filePath ?? 'runtime'}</span>
            </div>
          </div>
        </section>

        <section className="agent-drawer-section">
          <div className="agent-form-title">配置</div>
          <label className="agent-form-row">
            <span>Mode</span>
            <select value={draft.mode} onChange={(event) => setDraft((prev) => ({ ...prev, mode: event.target.value as AgentDeployDraft['mode'] }))}>
              <option value="auto">auto</option>
              <option value="manual">manual</option>
            </select>
          </label>
          <label className="agent-form-row">
            <span>Provider</span>
            <select value={draft.provider} onChange={(event) => setDraft((prev) => ({ ...prev, provider: event.target.value as AgentDeployDraft['provider'] }))}>
              <option value="iflow">iflow</option>
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </select>
          </label>
          <label className="agent-form-row">
            <span>Model</span>
            <input value={draft.model} onChange={(event) => setDraft((prev) => ({ ...prev, model: event.target.value }))} placeholder="可选" />
          </label>
          <label className="agent-form-row">
            <span>权限</span>
            <select
              value={draft.permissionMode}
              onChange={(event) => setDraft((prev) => ({ ...prev, permissionMode: event.target.value as AgentDeployDraft['permissionMode'] }))}
            >
              <option value="default">default</option>
              <option value="autoEdit">autoEdit</option>
              <option value="yolo">yolo</option>
              <option value="plan">plan</option>
            </select>
          </label>
          <label className="agent-form-row">
            <span>Max Rounds</span>
            <input
              type="number"
              min={1}
              max={50}
              value={draft.maxRounds}
              onChange={(event) => setDraft((prev) => ({ ...prev, maxRounds: Math.max(1, Number(event.target.value) || 1) }))}
            />
          </label>
          <label className="agent-form-row">
            <span>实例数</span>
            <input
              type="number"
              min={1}
              max={20}
              value={draft.instanceCount}
              onChange={(event) => setDraft((prev) => ({ ...prev, instanceCount: Math.max(1, Number(event.target.value) || 1) }))}
            />
          </label>
          <label className="agent-form-row checkbox">
            <span>启用 Review</span>
            <input
              type="checkbox"
              checked={draft.enableReview}
              onChange={(event) => setDraft((prev) => ({ ...prev, enableReview: event.target.checked }))}
            />
          </label>
          <button
            type="button"
            className="agent-deploy-btn"
            onClick={() => { void handleDeploy(); }}
            disabled={!onDeployConfig || isDeploying}
          >
            {isDeploying ? '部署中...' : '应用并部署'}
          </button>
          {hint && <div className="agent-hint-line">{hint}</div>}
        </section>

        <section className="agent-drawer-section">
          <div className="agent-form-title">工具策略</div>
          <div className="tool-line">tags: {capabilityTags.length > 0 ? capabilityTags.join(', ') : '(none)'}</div>
          <div className="tool-line">exposed: {exposedTools.length > 0 ? exposedTools.join(', ') : '(empty)'}</div>
          <div className="tool-line">allow: {allowTools.length > 0 ? allowTools.join(', ') : '(empty)'}</div>
          <div className="tool-line">deny: {denyTools.length > 0 ? denyTools.join(', ') : '(empty)'}</div>
          <div className="tool-line">auth required: {authTools.length > 0 ? authTools.join(', ') : '(none)'}</div>
          <div className="tool-line">
            dispatch targets: {dispatchTargets.length > 0 ? `${dispatchTargets.length} 个` : '0 个'}
          </div>
          {dispatchTargets.length > 0 && (
            <div className="tool-line">targets: {dispatchTargets.slice(0, 8).join(', ')}{dispatchTargets.length > 8 ? ' ...' : ''}</div>
          )}
        </section>

        <section className="agent-drawer-section">
          <div className="agent-form-title">运行控制</div>
          <div className="drawer-control-grid">
            <button type="button" className="drawer-control-btn" disabled={isControlling || !onControlAgent} onClick={() => { void handleControl('status'); }}>
              状态
            </button>
            <button type="button" className="drawer-control-btn" disabled={isControlling || !onControlAgent} onClick={() => { void handleControl('pause'); }}>
              暂停
            </button>
            <button type="button" className="drawer-control-btn" disabled={isControlling || !onControlAgent} onClick={() => { void handleControl('resume'); }}>
              恢复
            </button>
            <button type="button" className="drawer-control-btn danger" disabled={isControlling || !onControlAgent} onClick={() => { void handleControl('interrupt'); }}>
              中断
            </button>
          </div>
          {activeInstance?.sessionId && <div className="tool-line">scope session: {activeInstance.sessionId}</div>}
          {activeInstance?.workflowId && <div className="tool-line">scope workflow: {activeInstance.workflowId}</div>}
        </section>

        <section className="agent-drawer-section">
          <div className="agent-form-title">实例列表</div>
          {instances.length === 0 && <div className="tool-line">暂无实例</div>}
          {instances.map((instance) => {
            const switchable = typeof instance.sessionId === 'string' && instance.sessionId.length > 0;
            const active = switchable && instance.sessionId === currentSessionId;
            return (
              <button
                key={instance.id}
                type="button"
                className={`drawer-instance-row ${active ? 'active' : ''}`}
                disabled={!switchable}
                onClick={() => onSwitchInstance?.(instance)}
              >
                <span className="instance-name">{instance.name}</span>
                <span className="instance-meta">
                  {instance.id} · {instance.status}
                  {instance.sessionId ? ` · ${instance.sessionId}` : ''}
                </span>
              </button>
            );
          })}
        </section>
      </aside>
    </div>
  );
};
