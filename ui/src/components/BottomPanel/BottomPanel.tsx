import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentConfigSummary,
  AgentRuntimeInstance,
  AgentRuntimePanelAgent,
  OrchestrationConfigState,
  AgentStartupTarget,
  AgentStartupTemplate,
} from '../../hooks/useAgentRuntimePanel.js';
import { findConfigForAgent, isActiveInstanceStatus } from './agentRuntimeUtils.js';
import './BottomPanel.css';

type Tab = 'overview' | 'startup' | 'agents' | 'instances';

interface BottomPanelProps {
  agents: AgentRuntimePanelAgent[];
  instances: AgentRuntimeInstance[];
  configs: AgentConfigSummary[];
  startupTargets?: AgentStartupTarget[];
  startupTemplates?: AgentStartupTemplate[];
  orchestrationConfig?: OrchestrationConfigState | null;
  debugMode?: boolean;
  selectedAgentId?: string | null;
  currentSessionId?: string | null;
  focusedRuntimeInstanceId?: string | null;
  isLoading?: boolean;
  error?: string | null;
  onSelectAgent?: (agentId: string) => void;
  onSelectInstance?: (instance: AgentRuntimeInstance) => void;
  onSetDebugMode?: (enabled: boolean) => Promise<void> | void;
  onStartTemplate?: (templateId: string) => Promise<void> | void;
  onSwitchOrchestrationProfile?: (profileId: string) => Promise<void> | void;
  onSaveOrchestrationConfig?: (config: unknown) => Promise<void> | void;
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
  if (normalized === 'queued') return '排队中';
  if (normalized === 'waiting_input') return '等待输入';
  if (normalized === 'completed') return '已完成';
  if (normalized === 'failed') return '失败';
  if (normalized === 'interrupted') return '已中断';
  if (normalized === 'deployed') return '已部署';
  if (normalized === 'busy' || normalized === 'running') return '运行中';
  if (normalized === 'blocked') return '阻塞';
  if (normalized === 'error') return '异常';
  if (normalized === 'released') return '已释放';
  return '空闲';
}

function isProblemInstanceStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === 'failed'
    || normalized === 'error'
    || normalized === 'blocked'
    || normalized === 'interrupted';
}

function resolveRuntimeToneClass(status: string): 'idle' | 'running' | 'error' {
  if (isProblemInstanceStatus(status)) return 'error';
  if (isActiveInstanceStatus(status)) return 'running';
  return 'idle';
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function formatQuotaSource(source: string): string {
  if (source === 'workflow') return 'workflow';
  if (source === 'project') return 'project';
  if (source === 'deployment') return 'deployment';
  return 'default';
}

type ProfileReviewPolicy = {
  enabled: boolean;
  stages: string[];
  strictness?: string;
};

type RuntimeConnection = {
  key: string;
  agentId: string | null;
  runtimeId: string;
  tone: 'idle' | 'running' | 'error';
};

type ConnectionSegment = {
  key: string;
  tone: 'idle' | 'running' | 'error';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

const REVIEW_STAGE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'plan', label: '计划阶段' },
  { id: 'execution_pre', label: '执行前' },
  { id: 'execution_post', label: '执行后' },
  { id: 'deliverables', label: '交付前' },
];
const REVIEW_STAGE_IDS = new Set(REVIEW_STAGE_OPTIONS.map((item) => item.id));
const DEFAULT_REVIEW_STAGE = 'execution_post';
const REVIEW_STRICTNESS_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'mainline', label: '主线' },
  { id: 'strict', label: '严格' },
];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseProfileReviewPolicy(raw: unknown): ProfileReviewPolicy {
  if (typeof raw !== 'object' || raw === null) {
    return { enabled: false, stages: [] };
  }
  const record = raw as Record<string, unknown>;
  const stages = Array.isArray(record.stages)
    ? Array.from(
        new Set(
          record.stages
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => item.length > 0 && REVIEW_STAGE_IDS.has(item)),
        ),
      )
    : [];
  const strictness = record.strictness === 'strict'
    ? 'strict'
    : record.strictness === 'mainline'
      ? 'mainline'
    : undefined;
  return {
    enabled: record.enabled === true,
    stages,
    ...(strictness ? { strictness } : {}),
  };
}

function findBoundAgentForInstance(
  agents: AgentRuntimePanelAgent[],
  instance: AgentRuntimeInstance,
): AgentRuntimePanelAgent | null {
  const normalizedAgentId = normalizeText(instance.agentId);
  const normalizedInstanceName = normalizeText(instance.name);
  const normalizedType = normalizeText(instance.type);
  const idLookup = new Map(agents.map((agent) => [normalizeText(agent.id), agent]));
  const nameLookup = new Map(agents.map((agent) => [normalizeText(agent.name), agent]));

  let boundAgent = idLookup.get(normalizedAgentId) ?? null;
  if (!boundAgent) boundAgent = nameLookup.get(normalizedAgentId) ?? null;
  if (!boundAgent && normalizedAgentId.length > 0) {
    boundAgent = agents.find((agent) => {
      const candidateId = normalizeText(agent.id);
      if (candidateId.length === 0) return false;
      return candidateId.includes(normalizedAgentId) || normalizedAgentId.includes(candidateId);
    }) ?? null;
  }
  if (!boundAgent && normalizedInstanceName.length > 0) {
    boundAgent = agents.find((agent) => normalizeText(agent.name) === normalizedInstanceName) ?? null;
  }
  if (!boundAgent) {
    boundAgent = agents.find((agent) => normalizeText(agent.type) === normalizedType) ?? null;
  }
  return boundAgent;
}

export const BottomPanel: React.FC<BottomPanelProps> = ({
  agents,
  instances,
  configs,
  startupTargets = [],
  startupTemplates = [],
  orchestrationConfig = null,
  debugMode = false,
  selectedAgentId,
  currentSessionId,
  focusedRuntimeInstanceId = null,
  isLoading = false,
  error = null,
  onSelectAgent,
  onSelectInstance,
  onSetDebugMode,
  onStartTemplate,
  onSwitchOrchestrationProfile,
  onSaveOrchestrationConfig,
  onRefresh,
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('agents');
  const [isTogglingDebug, setIsTogglingDebug] = useState(false);
  const [startingTemplateId, setStartingTemplateId] = useState<string | null>(null);
  const [launchingProfile, setLaunchingProfile] = useState<'default' | 'mock' | 'full_mock' | null>(null);
  const [switchingProfileId, setSwitchingProfileId] = useState<string | null>(null);
  const [selectedOrchestrationProfileId, setSelectedOrchestrationProfileId] = useState<string>('');
  const [orchestrationDraft, setOrchestrationDraft] = useState<string>('');
  const [isOrchestrationDraftDirty, setIsOrchestrationDraftDirty] = useState(false);
  const [isSavingOrchestrationConfig, setIsSavingOrchestrationConfig] = useState(false);
  const [startupHint, setStartupHint] = useState<string | null>(null);
  const [connectionSegments, setConnectionSegments] = useState<ConnectionSegment[]>([]);

  const linkageRef = useRef<HTMLDivElement | null>(null);
  const agentCardRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const runtimeCardRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const overview = useMemo(() => {
    const activeInstances = instances.filter((instance) => isActiveInstanceStatus(instance.status)).length;
    const boundSessions = instances.filter((instance) => typeof instance.sessionId === 'string' && instance.sessionId.length > 0).length;
    const erroredInstances = instances.filter((instance) => {
      const status = instance.status.toLowerCase();
      return status === 'error' || status === 'failed';
    }).length;
    const totalRunning = agents.reduce((sum, agent) => sum + agent.runningCount, 0);
    const totalQueued = agents.reduce((sum, agent) => sum + agent.queuedCount, 0);
    return {
      totalAgents: agents.length,
      totalInstances: instances.length,
      activeInstances,
      idleInstances: Math.max(0, instances.length - activeInstances),
      boundSessions,
      erroredInstances,
      totalRunning,
      totalQueued,
      totalConfigs: configs.length,
    };
  }, [agents, configs.length, instances]);

  const focusedRuntimeId = useMemo(() => {
    if (focusedRuntimeInstanceId && instances.some((item) => item.id === focusedRuntimeInstanceId)) {
      return focusedRuntimeInstanceId;
    }
    const orchestratorRuntime = instances.find((instance) => instance.type === 'orchestrator');
    if (orchestratorRuntime) return orchestratorRuntime.id;
    const bySession = instances.find((instance) => (
      typeof currentSessionId === 'string'
      && currentSessionId.length > 0
      && instance.sessionId === currentSessionId
    ));
    if (bySession) return bySession.id;
    return instances[0]?.id ?? null;
  }, [currentSessionId, focusedRuntimeInstanceId, instances]);

  const runtimeConnections = useMemo<RuntimeConnection[]>(() => {
    return instances.map((instance) => {
      const boundAgent = findBoundAgentForInstance(agents, instance);
      return {
        key: `${boundAgent?.id ?? 'unbound'}=>${instance.id}`,
        agentId: boundAgent?.id ?? null,
        runtimeId: instance.id,
        tone: resolveRuntimeToneClass(instance.status),
      };
    });
  }, [agents, instances]);

  useLayoutEffect(() => {
    if (activeTab !== 'agents') {
      setConnectionSegments([]);
      return;
    }
    const container = linkageRef.current;
    if (!container) return;

    let frame = 0;
    const updateSegments = (): void => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const containerRect = container.getBoundingClientRect();
        const next: ConnectionSegment[] = [];

        runtimeConnections.forEach((connection) => {
          if (!connection.agentId) return;
          const fromNode = agentCardRefs.current[connection.agentId];
          const toNode = runtimeCardRefs.current[connection.runtimeId];
          if (!fromNode || !toNode) return;

          const fromRect = fromNode.getBoundingClientRect();
          const toRect = toNode.getBoundingClientRect();
          next.push({
            key: connection.key,
            tone: connection.tone,
            x1: fromRect.left + (fromRect.width / 2) - containerRect.left,
            y1: fromRect.bottom - containerRect.top,
            x2: toRect.left + (toRect.width / 2) - containerRect.left,
            y2: toRect.top - containerRect.top,
          });
        });
        setConnectionSegments(next);
      });
    };

    updateSegments();
    window.addEventListener('resize', updateSegments);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateSegments);
      observer.observe(container);
      Object.values(agentCardRefs.current).forEach((node) => {
        if (node) observer?.observe(node);
      });
      Object.values(runtimeCardRefs.current).forEach((node) => {
        if (node) observer?.observe(node);
      });
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateSegments);
      observer?.disconnect();
    };
  }, [activeTab, runtimeConnections, agents, instances]);

  useEffect(() => {
    if (!orchestrationConfig) {
      setSelectedOrchestrationProfileId('');
      setOrchestrationDraft('');
      setIsOrchestrationDraftDirty(false);
      return;
    }
    if (isOrchestrationDraftDirty) return;
    setSelectedOrchestrationProfileId(orchestrationConfig.activeProfileId);
    setOrchestrationDraft(`${JSON.stringify(orchestrationConfig, null, 2)}\n`);
  }, [isOrchestrationDraftDirty, orchestrationConfig]);

  const draftConfig = useMemo<Record<string, unknown> | null>(() => {
    if (orchestrationDraft.trim().length === 0) return null;
    try {
      const parsed = JSON.parse(orchestrationDraft) as unknown;
      return isObjectRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }, [orchestrationDraft]);

  const selectedProfileReviewPolicy = useMemo<ProfileReviewPolicy>(() => {
    if (draftConfig && Array.isArray(draftConfig.profiles)) {
      const fromDraft = draftConfig.profiles.find((profile) => (
        isObjectRecord(profile)
        && typeof profile.id === 'string'
        && profile.id.trim() === selectedOrchestrationProfileId
      )) as Record<string, unknown> | undefined;
      if (fromDraft) {
        return parseProfileReviewPolicy(fromDraft.reviewPolicy);
      }
    }
    const fallback = orchestrationConfig?.profiles.find((profile) => profile.id === selectedOrchestrationProfileId);
    return parseProfileReviewPolicy(fallback?.reviewPolicy);
  }, [draftConfig, orchestrationConfig, selectedOrchestrationProfileId]);

  const updateDraftReviewPolicy = (updater: (current: ProfileReviewPolicy) => ProfileReviewPolicy): void => {
    if (!draftConfig || !Array.isArray(draftConfig.profiles)) {
      setStartupHint('当前 orchestration.json 不是合法 JSON，无法修改 review policy');
      return;
    }
    const nextProfiles = [...draftConfig.profiles];
    const targetIndex = nextProfiles.findIndex((profile) => (
      isObjectRecord(profile)
      && typeof profile.id === 'string'
      && profile.id.trim() === selectedOrchestrationProfileId
    ));
    if (targetIndex < 0) {
      setStartupHint(`未找到 profile: ${selectedOrchestrationProfileId}`);
      return;
    }
    const targetProfile = nextProfiles[targetIndex];
    if (!isObjectRecord(targetProfile)) {
      setStartupHint(`profile 结构非法: ${selectedOrchestrationProfileId}`);
      return;
    }
    const nextPolicy = parseProfileReviewPolicy(updater(parseProfileReviewPolicy(targetProfile.reviewPolicy)));
    const nextProfile: Record<string, unknown> = {
      ...targetProfile,
      reviewPolicy: {
        enabled: nextPolicy.enabled,
        stages: nextPolicy.stages,
        ...(nextPolicy.strictness ? { strictness: nextPolicy.strictness } : {}),
      },
    };
    nextProfiles[targetIndex] = nextProfile;
    setOrchestrationDraft(`${JSON.stringify({ ...draftConfig, profiles: nextProfiles }, null, 2)}\n`);
    setIsOrchestrationDraftDirty(true);
    setStartupHint(null);
  };

  const handleToggleDebugMode = async (enabled: boolean): Promise<void> => {
    if (!onSetDebugMode) return;
    setIsTogglingDebug(true);
    setStartupHint(null);
    try {
      await onSetDebugMode(enabled);
      setStartupHint(`Debug mode 已${enabled ? '开启' : '关闭'}`);
    } catch (toggleError) {
      setStartupHint(toggleError instanceof Error ? toggleError.message : '切换 Debug mode 失败');
    } finally {
      setIsTogglingDebug(false);
    }
  };

  const handleStartTemplate = async (templateId: string): Promise<void> => {
    if (!onStartTemplate) return;
    setStartingTemplateId(templateId);
    setStartupHint(null);
    try {
      await onStartTemplate(templateId);
      setStartupHint(`模板 ${templateId} 启动请求已提交`);
    } catch (startError) {
      setStartupHint(startError instanceof Error ? startError.message : `模板 ${templateId} 启动失败`);
    } finally {
      setStartingTemplateId(null);
    }
  };

  const handleLaunchProfile = async (mode: 'default' | 'mock' | 'full_mock'): Promise<void> => {
    if (mode === 'full_mock') {
      if (!onSwitchOrchestrationProfile) {
        setStartupHint('缺少 profile 切换能力，无法启动 Full Mock');
        return;
      }
      setLaunchingProfile(mode);
      setStartupHint(null);
      try {
        await onSwitchOrchestrationProfile('full_mock');
        setIsOrchestrationDraftDirty(false);
        setStartupHint('已切换到 Full Mock profile（建议配合 FINGER_FULL_MOCK_MODE=1）');
      } catch (launchError) {
        setStartupHint(launchError instanceof Error ? launchError.message : 'Full Mock profile 切换失败');
      } finally {
        setLaunchingProfile(null);
      }
      return;
    }

    if (!onStartTemplate) return;
    const orchestratorTemplate = startupTemplates.find((template) => template.role === 'orchestrator');
    const executorTemplates = startupTemplates.filter((template) => template.role === 'executor');
    const executorTemplate = mode === 'mock'
      ? executorTemplates.find((template) => template.id.includes('debug')) ?? executorTemplates[0]
      : executorTemplates.find((template) => !template.id.includes('debug')) ?? executorTemplates[0];
    if (!orchestratorTemplate || !executorTemplate) {
      setStartupHint('最小编排模板不完整，请先检查 startupTemplates');
      return;
    }

    setLaunchingProfile(mode);
    setStartupHint(null);
    try {
      if (mode === 'mock' && onSetDebugMode) {
        await onSetDebugMode(true);
      }
      await onStartTemplate(orchestratorTemplate.id);
      await onStartTemplate(executorTemplate.id);
      setStartupHint(
        mode === 'mock'
          ? '已启动最小编排: orchestrator + mock executor'
          : '已启动最小编排: orchestrator + executor',
      );
    } catch (launchError) {
      setStartupHint(launchError instanceof Error ? launchError.message : '最小编排启动失败');
    } finally {
      setLaunchingProfile(null);
    }
  };

  const handleSwitchOrchestrationProfile = async (): Promise<void> => {
    if (!onSwitchOrchestrationProfile) return;
    const profileId = selectedOrchestrationProfileId.trim();
    if (!profileId) {
      setStartupHint('请选择 profile');
      return;
    }
    setSwitchingProfileId(profileId);
    setStartupHint(null);
    try {
      await onSwitchOrchestrationProfile(profileId);
      setIsOrchestrationDraftDirty(false);
      setStartupHint(`已切换 orchestration profile: ${profileId}`);
    } catch (switchError) {
      setStartupHint(switchError instanceof Error ? switchError.message : '切换 orchestration profile 失败');
    } finally {
      setSwitchingProfileId(null);
    }
  };

  const handleSaveOrchestrationConfig = async (): Promise<void> => {
    if (!onSaveOrchestrationConfig) return;
    setIsSavingOrchestrationConfig(true);
    setStartupHint(null);
    try {
      const parsed = JSON.parse(orchestrationDraft);
      await onSaveOrchestrationConfig(parsed);
      setIsOrchestrationDraftDirty(false);
      setStartupHint('orchestration.json 已保存并应用');
    } catch (saveError) {
      setStartupHint(saveError instanceof Error ? saveError.message : '保存 orchestration.json 失败');
    } finally {
      setIsSavingOrchestrationConfig(false);
    }
  };

  return (
    <div className="bottom-panel-container">
      <div className="panel-tabs">
        <button className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>Overview</button>
        <button className={activeTab === 'startup' ? 'active' : ''} onClick={() => setActiveTab('startup')}>Startup</button>
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
              <div className="stat-value">{overview.totalRunning}</div>
              <div className="stat-sub">运行中任务</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Queued</div>
              <div className="stat-value">{overview.totalQueued}</div>
              <div className="stat-sub">排队任务</div>
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

        {activeTab === 'startup' && (
          <div className="startup-container">
            <div className="startup-debug-row">
              <div className="startup-debug-main">
                <div className="startup-title">Debug Mode</div>
                <div className="startup-sub">启用后可注入 mock reviewer/executor runtime，用于派发断言联调。</div>
              </div>
              <label className="startup-switch">
                <input
                  aria-label="Debug mode"
                  type="checkbox"
                  checked={debugMode}
                  disabled={isTogglingDebug || !onSetDebugMode}
                  onChange={(event) => { void handleToggleDebugMode(event.target.checked); }}
                />
                <span>{debugMode ? 'ON' : 'OFF'}</span>
              </label>
            </div>

            <div className="startup-template-grid">
              <div className="startup-template-card startup-profile-card">
                <div className="startup-template-header">
                  <span className="startup-template-name">最小编排模板</span>
                  <span className="startup-template-role">profile</span>
                </div>
                <div className="startup-template-meta">标准: orchestrator + executor</div>
                <div className="startup-template-meta">Mock: orchestrator + executor-debug</div>
                <div className="startup-template-meta">Full Mock: orchestrator + loop mocks (env controlled)</div>
                <div className="startup-profile-actions">
                  <button
                    type="button"
                    className="startup-template-btn"
                    disabled={!onStartTemplate || launchingProfile !== null}
                    onClick={() => { void handleLaunchProfile('default'); }}
                  >
                    {launchingProfile === 'default' ? '启动中...' : '启动标准最小编排'}
                  </button>
                  <button
                    type="button"
                    className="startup-template-btn"
                    disabled={!onStartTemplate || launchingProfile !== null}
                    onClick={() => { void handleLaunchProfile('mock'); }}
                  >
                    {launchingProfile === 'mock' ? '启动中...' : '启动 Mock 最小编排'}
                  </button>
                  <button
                    type="button"
                    className="startup-template-btn"
                    disabled={!onSwitchOrchestrationProfile || launchingProfile !== null}
                    onClick={() => { void handleLaunchProfile('full_mock'); }}
                  >
                    {launchingProfile === 'full_mock' ? '启动中...' : '启动 Full Mock'}
                  </button>
                </div>
              </div>
              {startupTemplates.map((template) => (
                <div className="startup-template-card" key={template.id}>
                  <div className="startup-template-header">
                    <span className="startup-template-name">{template.name}</span>
                    <span className="startup-template-role">{template.role}</span>
                  </div>
                  <div className="startup-template-meta">id: {template.id}</div>
                  <div className="startup-template-meta">module: {template.defaultModuleId}</div>
                  <div className="startup-template-meta">
                    implementation: {template.defaultImplementationId}
                  </div>
                  <div className="startup-template-meta">
                    instances: {template.defaultInstanceCount} · mode: {template.launchMode}
                  </div>
                  <button
                    type="button"
                    className="startup-template-btn"
                    disabled={!onStartTemplate || startingTemplateId === template.id}
                    onClick={() => { void handleStartTemplate(template.id); }}
                  >
                    {startingTemplateId === template.id ? '启动中...' : '启动模板'}
                  </button>
                </div>
              ))}
            </div>
            {startupTemplates.length === 0 && (
              <div className="empty-state">暂无默认启动模板</div>
            )}

            <div className="startup-targets">
              <div className="startup-title">Startup Targets</div>
              <div className="startup-target-list">
                {startupTargets.length === 0 && <span>当前无可启动目标</span>}
                {startupTargets.map((target) => (
                  <span key={target.id} className="startup-target-item">
                    {target.name} ({target.role})
                  </span>
                ))}
              </div>
            </div>

            <div className="startup-targets">
              <div className="startup-title">orchestration.json</div>
              <div className="startup-sub">
                多组待机编排统一保存在该文件，切换 profile 不改流程结构，仅改配置。
              </div>
              <div className="orchestration-switch-row">
                <select
                  aria-label="Orchestration profile"
                  className="orchestration-profile-select"
                  value={selectedOrchestrationProfileId}
                  onChange={(event) => setSelectedOrchestrationProfileId(event.target.value)}
                  disabled={!orchestrationConfig || !onSwitchOrchestrationProfile || switchingProfileId !== null}
                >
                  {(orchestrationConfig?.profiles ?? []).map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} ({profile.id})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="startup-template-btn"
                  disabled={!onSwitchOrchestrationProfile || switchingProfileId !== null || !selectedOrchestrationProfileId}
                  onClick={() => { void handleSwitchOrchestrationProfile(); }}
                >
                  {switchingProfileId ? '切换中...' : '快速切换'}
                </button>
              </div>
              <div className="orchestration-review-panel">
                <div className="orchestration-review-row">
                  <div>
                    <div className="startup-title">Review Policy（当前 profile）</div>
                    <div className="startup-sub">勾选后将写入 selected profile.reviewPolicy，新会话默认生效。</div>
                  </div>
                  <label className="startup-switch">
                    <input
                      aria-label="启用 profile review policy"
                      type="checkbox"
                      checked={selectedProfileReviewPolicy.enabled}
                      disabled={!draftConfig || selectedOrchestrationProfileId.trim().length === 0}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        updateDraftReviewPolicy((current) => ({
                          ...current,
                          enabled: checked,
                          stages: checked
                            ? (current.stages.length > 0 ? current.stages : [DEFAULT_REVIEW_STAGE])
                            : current.stages,
                          strictness: current.strictness ?? 'mainline',
                        }));
                      }}
                    />
                    <span>{selectedProfileReviewPolicy.enabled ? 'ON' : 'OFF'}</span>
                  </label>
                </div>
                <div className="orchestration-review-stage-list">
                  {REVIEW_STAGE_OPTIONS.map((option) => (
                    <label
                      key={option.id}
                      className={`orchestration-review-stage-item ${selectedProfileReviewPolicy.enabled ? '' : 'disabled'}`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedProfileReviewPolicy.stages.includes(option.id)}
                        disabled={!draftConfig || selectedOrchestrationProfileId.trim().length === 0}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          updateDraftReviewPolicy((current) => {
                            const nextStages = checked
                              ? Array.from(new Set([...current.stages, option.id]))
                              : current.stages.filter((item) => item !== option.id);
                            return {
                              ...current,
                              enabled: nextStages.length > 0,
                              stages: REVIEW_STAGE_OPTIONS
                                .map((item) => item.id)
                                .filter((item) => nextStages.includes(item)),
                              strictness: current.strictness ?? 'mainline',
                            };
                          });
                        }}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
                <label className="orchestration-review-strictness">
                  <span>审查强度</span>
                  <select
                    aria-label="Review strictness"
                    value={selectedProfileReviewPolicy.strictness ?? 'mainline'}
                    disabled={!draftConfig || selectedOrchestrationProfileId.trim().length === 0}
                    onChange={(event) => {
                      const strictness = event.target.value === 'strict' ? 'strict' : 'mainline';
                      updateDraftReviewPolicy((current) => ({
                        ...current,
                        strictness,
                      }));
                    }}
                  >
                    {REVIEW_STRICTNESS_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <textarea
                className="orchestration-editor"
                value={orchestrationDraft}
                onChange={(event) => {
                  setOrchestrationDraft(event.target.value);
                  setIsOrchestrationDraftDirty(true);
                }}
                placeholder="orchestration.json"
                rows={14}
              />
              <button
                type="button"
                className="startup-template-btn"
                disabled={!onSaveOrchestrationConfig || isSavingOrchestrationConfig || orchestrationDraft.trim().length === 0}
                onClick={() => { void handleSaveOrchestrationConfig(); }}
              >
                {isSavingOrchestrationConfig ? '保存中...' : '保存并应用配置'}
              </button>
            </div>

            {startupHint && <div className="startup-hint">{startupHint}</div>}
          </div>
        )}

        {activeTab === 'agents' && (
          <div className="agents-container">
            <div className="agents-link-stage" ref={linkageRef}>
              {runtimeConnections.length > 0 && (
                <svg className="agent-connection-overlay" aria-label="agent-runtime-connections">
                  {connectionSegments.map((segment) => {
                    const midY = segment.y1 + ((segment.y2 - segment.y1) * 0.52);
                    const path = `M ${segment.x1} ${segment.y1} C ${segment.x1} ${midY}, ${segment.x2} ${midY}, ${segment.x2} ${segment.y2}`;
                    return (
                      <g key={segment.key}>
                        <path d={path} className={`agent-connection-path ${segment.tone}`} />
                        <circle className={`agent-connection-dot ${segment.tone}`} cx={segment.x1} cy={segment.y1} r={3.2} />
                        <circle className={`agent-connection-dot ${segment.tone}`} cx={segment.x2} cy={segment.y2} r={3.2} />
                      </g>
                    );
                  })}
                </svg>
              )}

              <div className="layer-title">Static Agent</div>
              <div className="agents-grid static-agent-grid">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    ref={(node) => { agentCardRefs.current[agent.id] = node; }}
                    className={`agent-card static-agent-card ${agent.status} ${selectedAgentId === agent.id ? 'selected' : ''}`}
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
                        <span className="metric-label">Running</span>
                        <span className="metric-value">{agent.runningCount}</span>
                      </div>
                      <div className="metric">
                        <span className="metric-label">Queued</span>
                        <span className="metric-value">{agent.queuedCount}</span>
                      </div>
                      <div className="metric">
                        <span className="metric-label">Quota</span>
                        <span className="metric-value">
                          {agent.quota.effective} ({formatQuotaSource(agent.quota.source)})
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
                    <div className="agent-config-ref">
                      Last Event: {agent.lastEvent?.summary ?? '暂无'}
                    </div>
                    {agent.debugAssertions.length > 0 && (
                      <div className="agent-config-ref">
                        Assert: {agent.debugAssertions[0].result.summary}
                      </div>
                    )}
                  </button>
                ))}
              </div>
              <div className="layer-title">Runtime</div>
              <div className="runtime-grid">
                {instances.map((instance) => {
                  const switchable = typeof instance.sessionId === 'string' && instance.sessionId.length > 0;
                  const focused = focusedRuntimeId === instance.id;
                  const toneClass = resolveRuntimeToneClass(instance.status);
                  const boundAgent = findBoundAgentForInstance(agents, instance);
                  const boundConfig = boundAgent ? findConfigForAgent(boundAgent, configs) : null;
                  return (
                    <button
                      key={instance.id}
                      ref={(node) => { runtimeCardRefs.current[instance.id] = node; }}
                      type="button"
                      className={`runtime-card ${toneClass} ${focused ? 'focused' : ''}`}
                      disabled={!switchable}
                      onClick={() => onSelectInstance?.(instance)}
                    >
                      <div className="runtime-card-header">
                        <span className="runtime-card-name">{instance.name}</span>
                        <span className="runtime-card-role">{instance.type}</span>
                      </div>
                      <div className="runtime-card-meta">
                        {formatInstanceStatus(instance.status)}
                        {instance.sessionId ? ` · session ${instance.sessionId}` : ' · 无会话'}
                      </div>
                      <div className="runtime-card-meta">
                        Agent: {boundAgent?.name ?? instance.agentId}
                        {boundConfig ? ` · 配置 ${boundConfig.id}` : ' · 未映射配置（未找到对应 agent.json）'}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
            {instances.length === 0 && <div className="empty-state">当前没有 Runtime 实例</div>}
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
            上层为静态 Agent 配置（蓝色），下层为 Runtime 实例：运行中绿色、空闲蓝色、异常红色。
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

        {activeTab === 'startup' && (
          <div className="overview-hint">
            默认模板用于快速启动 `orchestrator / reviewer / executor`。
          </div>
        )}
      </div>
    </div>
  );
};
