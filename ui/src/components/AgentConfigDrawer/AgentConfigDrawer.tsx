import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { AgentConfig } from '../../api/types.js';
import type { AgentConfigSummary, AgentDebugAssertion, AgentRuntimeInstance, AgentRuntimePanelAgent } from '../../hooks/useAgentRuntimePanel.js';
import { isActiveInstanceStatus } from '../BottomPanel/agentRuntimeUtils.js';
import './AgentConfigDrawer.css';

interface AgentDeployDraft {
  mode: 'auto' | 'manual';
  provider: 'auto' | 'openai' | 'anthropic';
  model: string;
  permissionMode: 'default' | 'autoEdit' | 'yolo' | 'plan';
  maxRounds: number;
  enableReview: boolean;
  enabled: boolean;
  capabilitiesText: string;
  defaultQuota: number;
  projectQuotaText: string;
  workflowQuotaText: string;
  instanceCount: number;
}

interface AgentJsonState {
  text: string;
  filePath: string;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  dirty: boolean;
  missing: boolean;
}

interface AgentPromptMeta {
  role: string;
  source: string;
  path: string;
  editablePath: string;
  content: string;
}

interface AgentPromptState {
  system: AgentPromptMeta | null;
  developer: AgentPromptMeta | null;
  systemText: string;
  developerText: string;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  dirtySystem: boolean;
  dirtyDeveloper: boolean;
  hint: string | null;
}


const DRAWER_WIDTH_STORAGE_KEY = 'finger.agentConfigDrawer.width';
const MIN_DRAWER_WIDTH = 420;
const MAX_DRAWER_WIDTH = 860;
const DEFAULT_DRAWER_WIDTH = 560;

function clampDrawerWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_DRAWER_WIDTH;
  return Math.min(MAX_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, Math.round(width)));
}

function stringifyWorkflowQuota(workflowQuota: Record<string, number>): string {
  return Object.entries(workflowQuota)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([workflowId, quota]) => `${workflowId}=${quota}`)
    .join('\n');
}

function parseWorkflowQuotaText(text: string): Record<string, number> {
  const result: Record<string, number> = {};
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    const [workflowIdRaw, quotaRaw] = line.split('=');
    const workflowId = workflowIdRaw?.trim();
    const quota = Number(quotaRaw);
    if (!workflowId || !Number.isFinite(quota) || quota <= 0) continue;
    result[workflowId] = Math.max(1, Math.floor(quota));
  }
  return result;
}

interface AgentConfigDrawerProps {
  isOpen: boolean;
  agent: AgentRuntimePanelAgent | null;
  capabilities?: AgentRuntimePanelAgent['capabilities'] | null;
  config: AgentConfigSummary | null;
  instances: AgentRuntimeInstance[];
  assertions?: AgentDebugAssertion[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePromptMeta(raw: unknown): AgentPromptMeta | null {
  if (!isRecord(raw)) return null;
  const role = typeof raw.role === 'string' ? raw.role : '';
  const source = typeof raw.source === 'string' ? raw.source : '';
  const path = typeof raw.path === 'string' ? raw.path : '';
  const editablePath = typeof raw.editablePath === 'string' ? raw.editablePath : '';
  const content = typeof raw.content === 'string' ? raw.content : '';
  return {
    role,
    source,
    path,
    editablePath,
    content,
  };
}

function pickDefaultDraft(
  agent: AgentRuntimePanelAgent | null,
  config: AgentConfigSummary | null,
  capabilitiesInfo: AgentRuntimePanelAgent['capabilities'] | null | undefined,
): AgentDeployDraft {
  const sourceConfig = {} as AgentConfig;
  const defaultQuota = agent?.defaultQuota
    ?? (typeof config?.defaultQuota === 'number' ? Math.max(1, Math.floor(config.defaultQuota)) : 1);
  const projectQuota = agent?.quotaPolicy.projectQuota
    ?? config?.quotaPolicy?.projectQuota;
  const workflowQuota = agent?.quotaPolicy.workflowQuota
    ?? config?.quotaPolicy?.workflowQuota
    ?? {};
  const capabilityFromAgent = Array.isArray(agent?.runtimeCapabilities) ? agent.runtimeCapabilities : [];
  const capabilityFromConfig = Array.isArray(config?.capabilities) ? config.capabilities : [];
  const capabilities = capabilityFromAgent.length > 0 ? capabilityFromAgent : capabilityFromConfig;
  const providerHint = capabilitiesInfo?.governance?.provider;
  const provider = providerHint === 'openai' || providerHint === 'anthropic'
    ? providerHint
    : 'auto';
  const approvalHint = capabilitiesInfo?.governance?.iflowApprovalMode;
  const permissionMode = approvalHint === 'autoEdit' || approvalHint === 'yolo' || approvalHint === 'plan' || approvalHint === 'default'
    ? approvalHint
    : (sourceConfig.permissionMode ?? 'default');
  return {
    mode: sourceConfig.mode ?? 'auto',
    provider,
    model: sourceConfig.model ?? '',
    permissionMode,
    maxRounds: Number.isFinite(sourceConfig.maxRounds) ? Math.max(1, Number(sourceConfig.maxRounds)) : 10,
    enableReview: sourceConfig.enableReview === true,
    enabled: agent?.enabled !== false,
    capabilitiesText: capabilities.join(', '),
    defaultQuota,
    projectQuotaText: projectQuota ? String(projectQuota) : '',
    workflowQuotaText: stringifyWorkflowQuota(workflowQuota),
    instanceCount: Number.isFinite(agent?.instanceCount) ? Math.max(1, Number(agent?.instanceCount)) : 1,
  };
}

export const AgentConfigDrawer = ({
  isOpen,
  agent,
  capabilities,
  config,
  instances,
  assertions = [],
  currentSessionId,
  onClose,
  onSwitchInstance,
  onDeployConfig,
  onControlAgent,
}: AgentConfigDrawerProps) => {
  const [draft, setDraft] = useState<AgentDeployDraft>(() => pickDefaultDraft(agent, config, capabilities));
  const [drawerWidth, setDrawerWidth] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_DRAWER_WIDTH;
    const saved = Number(window.localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY));
    return clampDrawerWidth(saved);
  });
  const [isDrawerResizing, setIsDrawerResizing] = useState(false);
  const drawerResizeOriginRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [isDeploying, setIsDeploying] = useState(false);
  const [isControlling, setIsControlling] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [agentJson, setAgentJson] = useState<AgentJsonState>({
    text: '',
    filePath: '',
    isLoading: false,
    isSaving: false,
    error: null,
    dirty: false,
    missing: false,
  });
  const [prompts, setPrompts] = useState<AgentPromptState>({
    system: null,
    developer: null,
    systemText: '',
    developerText: '',
    isLoading: false,
    isSaving: false,
    error: null,
    dirtySystem: false,
    dirtyDeveloper: false,
    hint: null,
  });

  useEffect(() => {
    setDraft(pickDefaultDraft(agent, config, capabilities));
    setHint(null);
  }, [agent?.id, config?.id, capabilities]);

  const loadAgentJson = useCallback(async () => {
    if (!agent?.id) return;
    setAgentJson((prev) => ({
      ...prev,
      isLoading: true,
      error: null,
    }));
    setPrompts((prev) => ({
      ...prev,
      isLoading: true,
      error: null,
      hint: null,
    }));
    const agentId = encodeURIComponent(agent.id);
    const [jsonRes, promptRes] = await Promise.allSettled([
      fetch(`/api/v1/agents/configs/${agentId}`),
      fetch(`/api/v1/agents/configs/${agentId}/prompts`),
    ]);

    if (jsonRes.status === 'fulfilled') {
      const res = jsonRes.value;
      if (res.ok) {
        try {
          const payload = await res.json() as { filePath?: string; config?: unknown; missing?: boolean };
          const text = JSON.stringify(payload.config ?? {}, null, 2);
          const missing = payload.missing === true;
          setAgentJson({
            text,
            filePath: typeof payload.filePath === 'string' ? payload.filePath : '',
            isLoading: false,
            isSaving: false,
            error: null,
            dirty: missing,
            missing,
          });
        } catch (error) {
          setAgentJson((prev) => ({
            ...prev,
            isLoading: false,
            error: error instanceof Error ? error.message : '加载 agent.json 失败',
          }));
        }
      } else {
        const message = await res.text().catch(() => `HTTP ${res.status}`);
        setAgentJson((prev) => ({
          ...prev,
          isLoading: false,
          error: message || `HTTP ${res.status}`,
        }));
      }
    } else {
      setAgentJson((prev) => ({
        ...prev,
        isLoading: false,
        error: '加载 agent.json 失败',
      }));
    }

    if (promptRes.status === 'fulfilled') {
      const res = promptRes.value;
      if (res.ok) {
        try {
          const payload = await res.json() as { prompts?: unknown };
          const promptRecord = isRecord(payload.prompts) ? payload.prompts as Record<string, unknown> : null;
          const systemPrompt = parsePromptMeta(promptRecord?.system);
          const developerPrompt = parsePromptMeta(promptRecord?.developer);
          setPrompts((prev) => ({
            ...prev,
            system: systemPrompt,
            developer: developerPrompt,
            systemText: systemPrompt?.content ?? '',
            developerText: developerPrompt?.content ?? '',
            isLoading: false,
            error: null,
            dirtySystem: false,
            dirtyDeveloper: false,
          }));
        } catch (error) {
          setPrompts((prev) => ({
            ...prev,
            isLoading: false,
            error: error instanceof Error ? error.message : '加载 prompt 失败',
          }));
        }
      } else {
        const message = await res.text().catch(() => `HTTP ${res.status}`);
        setPrompts((prev) => ({
          ...prev,
          isLoading: false,
          error: message || `HTTP ${res.status}`,
        }));
      }
    } else {
      setPrompts((prev) => ({
        ...prev,
        isLoading: false,
        error: '加载 prompt 失败',
      }));
    }
  }, [agent?.id]);

  useEffect(() => {
    if (!isOpen || !agent?.id) return;
    void loadAgentJson();
  }, [agent?.id, isOpen, loadAgentJson]);


  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, String(clampDrawerWidth(drawerWidth)));
  }, [drawerWidth]);

  useEffect(() => {
    if (!isDrawerResizing) return undefined;
    const onPointerMove = (event: PointerEvent): void => {
      const origin = drawerResizeOriginRef.current;
      if (!origin) return;
      const nextWidth = clampDrawerWidth(origin.startWidth + (event.clientX - origin.startX));
      setDrawerWidth(nextWidth);
    };
    const stopResize = (): void => {
      drawerResizeOriginRef.current = null;
      setIsDrawerResizing(false);
      document.body.style.removeProperty('user-select');
      document.body.style.removeProperty('cursor');
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
      document.body.style.removeProperty('user-select');
      document.body.style.removeProperty('cursor');
    };
  }, [isDrawerResizing]);

  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    drawerResizeOriginRef.current = {
      startX: event.clientX,
      startWidth: drawerWidth,
    };
    setIsDrawerResizing(true);
  }, [drawerWidth]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

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

  const handleSaveAgentJson = async (): Promise<void> => {
    if (!agentJson.dirty || agentJson.isSaving) return;
    setAgentJson((prev) => ({ ...prev, isSaving: true, error: null }));
    try {
      const parsed = JSON.parse(agentJson.text);
      const res = await fetch(`/api/v1/agents/configs/${encodeURIComponent(agent.id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: parsed }),
        });
      if (!res.ok) {
        const message = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(message || `HTTP ${res.status}`);
      }
      setAgentJson((prev) => ({ ...prev, isSaving: false, dirty: false, missing: false }));
      setHint('agent.json 已保存，下一次任务开始会加载');
    } catch (error) {
      setAgentJson((prev) => ({
        ...prev,
        isSaving: false,
        error: error instanceof Error ? error.message : '保存 agent.json 失败',
      }));
    }
  };

  const handleDeploy = async (): Promise<void> => {
    if (!onDeployConfig) return;
    setIsDeploying(true);
    setHint(null);
    const capabilitiesNormalized = draft.capabilitiesText
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    const projectQuotaRaw = Number(draft.projectQuotaText);
    const projectQuota = Number.isFinite(projectQuotaRaw) && projectQuotaRaw > 0
      ? Math.max(1, Math.floor(projectQuotaRaw))
      : undefined;
    const workflowQuota = parseWorkflowQuotaText(draft.workflowQuotaText);
    try {
      await onDeployConfig({
        config: {
          id: agent.id,
          name: agent.name,
          mode: draft.mode,
          ...(draft.provider !== 'auto'
            ? {
                provider: draft.provider,
                model: draft.model.trim() || undefined,
              }
            : {}),
          permissionMode: draft.permissionMode,
          maxRounds: draft.maxRounds,
          enableReview: draft.enableReview,
          ...(agent.type ? { role: agent.type } : {}),
          enabled: draft.enabled,
          capabilities: capabilitiesNormalized,
          defaultQuota: draft.defaultQuota,
          quotaPolicy: {
            ...(projectQuota !== undefined ? { projectQuota } : {}),
            workflowQuota,
          },
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

  const handleSavePrompts = async (): Promise<void> => {
    if (prompts.isSaving) return;
    const shouldSaveSystem = prompts.dirtySystem;
    const shouldSaveDeveloper = prompts.dirtyDeveloper;
    if (!shouldSaveSystem && !shouldSaveDeveloper) return;
    setPrompts((prev) => ({
      ...prev,
      isSaving: true,
      error: null,
      hint: null,
    }));
    try {
      const payload: Record<string, unknown> = {
        ...(shouldSaveSystem ? { systemPrompt: prompts.systemText } : {}),
        ...(shouldSaveDeveloper ? { developerPrompt: prompts.developerText } : {}),
        ...(prompts.developer?.role ? { developerRole: prompts.developer.role } : {}),
      };
      const res = await fetch(`/api/v1/agents/configs/${encodeURIComponent(agent.id)}/prompts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const message = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(message || `HTTP ${res.status}`);
      }
      setPrompts((prev) => ({
        ...prev,
        isSaving: false,
        dirtySystem: false,
        dirtyDeveloper: false,
        hint: '提示词已保存，下一次任务开始生效。',
      }));
    } catch (error) {
      setPrompts((prev) => ({
        ...prev,
        isSaving: false,
        error: error instanceof Error ? error.message : '保存提示词失败',
      }));
    }
  };

  const handleAgentJsonChange = (value: string): void => {
    setAgentJson((prev) => ({
      ...prev,
      text: value,
      dirty: true,
    }));
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
      <aside className={`agent-drawer ${isDrawerResizing ? 'resizing' : ''}`} style={{ width: `${drawerWidth}px` }} onClick={(event) => event.stopPropagation()}>
        <div
          className="agent-drawer-resize-handle"
          onPointerDown={handleResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整抽屉宽度"
        />
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
          <div className="agent-form-title">提示词编辑</div>
          <div className="agent-prompt-meta">
            <div>System Prompt · role: {prompts.system?.role || agent.type}</div>
            <div>来源: {prompts.system?.source || 'inline'} {prompts.system?.path ? `· ${prompts.system.path}` : ''}</div>
            <div>可写路径: {prompts.system?.editablePath || '未初始化'}</div>
          </div>
          {prompts.error && <div className="agent-prompt-error">{prompts.error}</div>}
          <textarea
            className="agent-prompt-editor"
            value={prompts.systemText}
            onChange={(event) => setPrompts((prev) => ({
              ...prev,
              systemText: event.target.value,
              dirtySystem: true,
            }))}
            placeholder="System Prompt"
            rows={8}
          />
          <div className="agent-prompt-meta">
            <div>Developer Prompt · role: {prompts.developer?.role || agent.type}</div>
            <div>来源: {prompts.developer?.source || 'inline'} {prompts.developer?.path ? `· ${prompts.developer.path}` : ''}</div>
            <div>可写路径: {prompts.developer?.editablePath || '未初始化'}</div>
          </div>
          <textarea
            className="agent-prompt-editor"
            value={prompts.developerText}
            onChange={(event) => setPrompts((prev) => ({
              ...prev,
              developerText: event.target.value,
              dirtyDeveloper: true,
            }))}
            placeholder="Developer Prompt"
            rows={10}
          />
          <div className="agent-prompt-actions">
            <button type="button" onClick={() => { void loadAgentJson(); }} disabled={prompts.isLoading}>
              重新加载
            </button>
            <button
              type="button"
              className="agent-prompt-save"
              onClick={() => { void handleSavePrompts(); }}
              disabled={prompts.isSaving || (!prompts.dirtySystem && !prompts.dirtyDeveloper)}
            >
              {prompts.isSaving ? '保存中...' : '保存提示词'}
            </button>
          </div>
          {prompts.hint && <div className="agent-prompt-hint">{prompts.hint}</div>}
          <div className="agent-prompt-hint">保存后写入 prompts，下一次任务开始生效。</div>
        </section>

        <section className="agent-drawer-section">
          <div className="agent-form-title">运行配置（部署）</div>
          <div className="agent-form-subtitle">仅影响部署/运行参数，不会写入 agent.json。</div>

          <label className="agent-form-row checkbox">
            <span>启用</span>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
          </label>
          <label className="agent-form-row">
            <span>能力</span>
            <input
              value={draft.capabilitiesText}
              onChange={(event) => setDraft((prev) => ({ ...prev, capabilitiesText: event.target.value }))}
              placeholder="execution, review"
            />
          </label>
          <label className="agent-form-row">
            <span>Default Quota</span>
            <input
              type="number"
              min={1}
              max={50}
              value={draft.defaultQuota}
              onChange={(event) => setDraft((prev) => ({ ...prev, defaultQuota: Math.max(1, Number(event.target.value) || 1) }))}
            />
          </label>
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
              <option value="auto">auto</option>
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </select>
          </label>
          <div className="agent-form-hint">auto = 不覆写 runtime provider</div>
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
        </section>

        <section className="agent-drawer-section">
          <div className="agent-form-title">Project Quota</div>
          <label className="agent-form-row">
            <span>projectQuota</span>
            <input
              type="number"
              min={1}
              placeholder="留空=未设置"
              value={draft.projectQuotaText}
              onChange={(event) => setDraft((prev) => ({ ...prev, projectQuotaText: event.target.value }))}
            />
          </label>
        </section>

        <section className="agent-drawer-section">
          <div className="agent-form-title">Workflow Quota</div>
          <label className="agent-form-row">
            <span>workflowId=quota</span>
            <textarea
              value={draft.workflowQuotaText}
              onChange={(event) => setDraft((prev) => ({ ...prev, workflowQuotaText: event.target.value }))}
              placeholder={'wf-1=1\nwf-2=2'}
              rows={4}
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
          <div className="agent-form-title">agent.json 编辑</div>
          <div className="agent-json-meta">
            <div>文件: {agentJson.filePath || config?.filePath || '未加载'}</div>
            {agentJson.missing && <div className="agent-json-missing">未找到配置，保存后将创建</div>}
            <div className="agent-json-actions">
              <button type="button" onClick={() => { void loadAgentJson(); }} disabled={agentJson.isLoading}>
                重新加载
              </button>
              <button
                type="button"
                className="agent-json-save"
                onClick={() => { void handleSaveAgentJson(); }}
                disabled={!agentJson.dirty || agentJson.isSaving}
              >
                {agentJson.isSaving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
          {agentJson.error && <div className="agent-json-error">{agentJson.error}</div>}
          <textarea
            className="agent-json-editor"
            value={agentJson.text}
            onChange={(event) => handleAgentJsonChange(event.target.value)}
            placeholder={`{\n  "id": "agent-id",\n  "provider": {\n    "type": "openai"\n  },\n  "tools": {\n    "whitelist": []\n  },\n  "metadata": {\n    "systemPrompt": "..."\n  }\n}`}
            rows={14}
          />
          <div className="agent-json-hint">保存后会写入 agent.json，下一次任务开始生效。</div>
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
          <div className="agent-form-title">调试断言</div>
          {assertions.length === 0 && <div className="tool-line">暂无断言记录</div>}
          {assertions.slice(0, 6).map((assertion) => (
            <div key={assertion.id} className="tool-line">
              [{assertion.result.ok ? 'OK' : 'ERR'}] {assertion.result.summary}
            </div>
          ))}
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
