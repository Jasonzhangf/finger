import React, { useMemo, useEffect, useState, useCallback, useRef } from 'react';
import { useSystemMonitor } from '../../hooks/useSystemMonitor.js';
import { PerformanceCard } from '../PerformanceCard/PerformanceCard.js';
import type { InputCapability } from '../ChatInterface/ChatInterface.js';
import { AppLayout } from '../layout/AppLayout.js';
import { LeftSidebar } from '../LeftSidebar/LeftSidebar.js';
import { AgentConfigDrawer } from '../AgentConfigDrawer/AgentConfigDrawer.js';
import { SessionResumeDialog } from '../SessionResumeDialog/SessionResumeDialog.js';
import { useSessionResume } from '../../hooks/useSessionResume.js';
import { SYSTEM_PROJECT_PATH } from '../../hooks/useWorkflowExecution.constants.js';
import { useSessions } from '../../hooks/useSessions.js';
import { useWorkflowExecution } from '../../hooks/useWorkflowExecution.js';
import { useAgents } from '../../hooks/useAgents.js';
import { useAgentRuntimePanel } from '../../hooks/useAgentRuntimePanel.js';
import { AgentSessionPanel } from '../AgentSessionPanel/AgentSessionPanel.js';
import LedgerMonitor from '../LedgerMonitor/LedgerMonitor.js';
import { AgentPromptStrip } from '../BottomPanel/AgentPromptStrip.js';
import { findConfigForAgent, matchInstanceToAgent } from '../BottomPanel/agentRuntimeUtils.js';
import ContextMonitor from '../ContextMonitor/ContextMonitor.js';
import type { AgentConfig, AgentRuntime } from '../../api/types.js';
import type { AgentRuntimeInstance } from '../../hooks/useAgentRuntimePanel.js';

interface ResumeCheckResult {
  sessionId: string;
  timestamp: string;
  originalTask: string;
  progress: number;
}

const CHAT_GATEWAY_ID = 'finger-orchestrator-gateway';
type ViewMode = 'workflow' | 'system-monitor';
const WORKDIR_STORAGE_KEY = 'finger-ui-workdir';
const PANEL_FREEZE_STORAGE_KEY = 'finger-ui-panel-freeze';
const DISABLE_ANIMATIONS_STORAGE_KEY = 'finger-ui-disable-animations';
const UI_DISABLE_STORAGE_KEY = 'finger-ui-disable-flags';
const MONITOR_LIVE_UPDATES_STORAGE_KEY = 'finger-ui-monitor-live-updates';

type PanelFreezeKey = 'left' | 'canvas' | 'right' | 'bottom' | 'performance';
type PanelFreezeState = Record<PanelFreezeKey, boolean>;
type UiDisableKey = 'realtime' | 'polling' | 'canvas' | 'right' | 'bottom' | 'performance';
type UiDisableState = Record<UiDisableKey, boolean>;

const DEFAULT_PANEL_FREEZE: PanelFreezeState = {
  left: false,
  canvas: false,
  right: false,
  bottom: false,
  performance: false,
};

const DEFAULT_UI_DISABLE: UiDisableState = {
  realtime: false,
  polling: false,
  canvas: false,
  right: false,
  bottom: false,
  performance: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseInputCapability(value: unknown): InputCapability | null {
  if (!isRecord(value)) return null;
  if (typeof value.acceptText !== 'boolean') return null;
  if (typeof value.acceptImages !== 'boolean') return null;
  if (typeof value.acceptFiles !== 'boolean') return null;
  const prefixes = Array.isArray(value.acceptedFileMimePrefixes)
    ? value.acceptedFileMimePrefixes.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : undefined;
  return {
    acceptText: value.acceptText,
    acceptImages: value.acceptImages,
    acceptFiles: value.acceptFiles,
    ...(prefixes && prefixes.length > 0 ? { acceptedFileMimePrefixes: prefixes } : {}),
  };
}

function resolveChatInputCapability(modules: Array<{ id: string; metadata?: Record<string, unknown> }>): InputCapability {
  const module = modules.find((item) => item.id === CHAT_GATEWAY_ID);
  const parsed = parseInputCapability(module?.metadata?.inputCapability);
  if (parsed) return parsed;
  return {
    acceptText: true,
    acceptImages: true,
    acceptFiles: false,
    acceptedFileMimePrefixes: ['image/'],
  };
}

function readPanelFreezeState(): PanelFreezeState {
  try {
    const raw = window.localStorage.getItem(PANEL_FREEZE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PANEL_FREEZE };
    const parsed = JSON.parse(raw) as Partial<PanelFreezeState>;
    return {
      left: parsed.left === true,
      canvas: parsed.canvas === true,
      right: parsed.right === true,
      bottom: parsed.bottom === true,
      performance: parsed.performance === true,
    };
  } catch {
    return { ...DEFAULT_PANEL_FREEZE };
  }
}

function readUiDisableState(): UiDisableState {
  try {
    const raw = window.localStorage.getItem(UI_DISABLE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_UI_DISABLE };
    const parsed = JSON.parse(raw) as Partial<UiDisableState>;
    return {
      realtime: parsed.realtime === true,
      polling: parsed.polling === true,
      canvas: parsed.canvas === true,
      right: parsed.right === true,
      bottom: parsed.bottom === true,
      performance: parsed.performance === true,
    };
  } catch {
    return { ...DEFAULT_UI_DISABLE };
  }
}

function useFrozenValue<T>(value: T, freeze: boolean): T {
  const ref = useRef(value);
  const initialized = useRef(false);
  if (!initialized.current) {
    ref.current = value;
    initialized.current = true;
  }
  if (!freeze) {
    ref.current = value;
  }
  return freeze ? ref.current : value;
}

function normalizeChatAgentStatus(status: string): AgentRuntime['status'] {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'running' || normalized === 'queued' || normalized === 'waiting_input') return 'running';
  if (normalized === 'error' || normalized === 'failed' || normalized === 'interrupted') return 'error';
  if (normalized === 'paused') return 'paused';
  return 'idle';
}

/** Check if a session is a system session (used for System Agent panel) */
function isSystemSession(s: { projectPath?: string; sessionTier?: string; id?: string }): boolean {
  const pp = s.projectPath || '';
  const tier = s.sessionTier || '';
  const id = s.id || '';
  if (pp.endsWith('/.finger/system') || pp === '~/.finger/system') return true;
  if (tier === 'system') return true;
  if (id.startsWith('system-')) return true;
  return false;
}

function normalizeProjectPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isActiveRuntimeStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase().replace(/\s+/g, '_');
  return normalized === 'running'
    || normalized === 'queued'
    || normalized === 'waiting_input'
    || normalized === 'processing'
    || normalized === 'dispatching'
    || normalized === 'busy';
}

function isTeamMemberAgent(agentId: string): boolean {
  const id = agentId.trim().toLowerCase();
  if (!id) return false;
  if (id === 'finger-system-agent') return false;
  if (id.includes('orchestrator')) return false;
  if (id.includes('gateway')) return false;
  if (id.includes('context-agent')) return false;
  return true;
}

export const WorkflowContainer: React.FC = () => {
  const [viewMode, setViewMode] = React.useState<ViewMode>('workflow');
  const {
    currentSession,
    sessions,
    isLoading: isLoadingSessions,
    error: sessionError,
    create: createSession,
    remove: removeSession,
    rename: renameSession,
    switchSession,
    refresh: refreshSessions,
  } = useSessions();
  const { checkForResumeableSession } = useSessionResume();
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [resumeTarget, setResumeTarget] = useState<ResumeCheckResult | null>(null);
  const [panelFreeze, setPanelFreeze] = useState<PanelFreezeState>(() => {
    if (typeof window === 'undefined' || !window.localStorage) return { ...DEFAULT_PANEL_FREEZE };
    return readPanelFreezeState();
  });
  const [disableAnimations, setDisableAnimations] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    const raw = window.localStorage.getItem(DISABLE_ANIMATIONS_STORAGE_KEY);
    return raw === '1' || raw === 'true';
  });
  const [monitorLiveUpdatesEnabled, setMonitorLiveUpdatesEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.localStorage) return true;
    const raw = window.localStorage.getItem(MONITOR_LIVE_UPDATES_STORAGE_KEY);
    if (raw === null) return true;
    return raw === '1' || raw === 'true';
  });
  const [uiDisable] = useState<UiDisableState>(() => {
    if (typeof window === 'undefined' || !window.localStorage) return { ...DEFAULT_UI_DISABLE };
    return readUiDisableState();
  });
  const [contextMonitorCommand, setContextMonitorCommand] = useState<{
    id: string;
    action: 'focus_latest_round' | 'focus_latest_strategy_change' | 'step_compare_prev' | 'step_compare_next';
  } | null>(null);

  const orchestratorSessionId = currentSession?.sessionTier === 'runtime'
    ? (currentSession.rootSessionId || currentSession.parentSessionId || (sessions.length > 0 ? sessions[0].id : 'default-session'))
    : (currentSession?.id || (sessions.length > 0 ? sessions[0].id : 'default-session'));
  const systemAgentSessionId = isSystemSession(currentSession ?? {})
    ? currentSession!.id
    : (sessions.find((session) => isSystemSession(session))?.id
      || `system-${orchestratorSessionId}`);
  const [sessionBinding, setSessionBinding] = useState<{
    context: 'orchestrator' | 'runtime';
    sessionId: string;
    runtimeInstanceId?: string;
  }>({
    context: 'orchestrator',
    sessionId: orchestratorSessionId,
  });

  const activeSessionId = sessionBinding.context === 'runtime' ? sessionBinding.sessionId : orchestratorSessionId;
  const systemProjectPath = SYSTEM_PROJECT_PATH;


  // Check for resumeable session on mount
  useEffect(() => {
    const checkSession = async () => {
      try {
        // Check localStorage for last active session
        const lastSessionId = localStorage.getItem('finger-last-session-id');
        if (!lastSessionId) return;

        const res = await fetch(`/api/v1/session/${lastSessionId}/checkpoint/latest`);
        if (res.status === 404) return;
        if (!res.ok) return;

        const data = await res.json();
        const checkpoint = data.checkpoint || data;
        if (checkpoint && data.resumeContext?.estimatedProgress < 100) {
          setResumeTarget({
            sessionId: lastSessionId,
            timestamp: checkpoint.timestamp || new Date().toISOString(),
            originalTask: checkpoint.originalTask || '未命名任务',
            progress: data.resumeContext?.estimatedProgress || 0,
          });
          setShowResumeDialog(true);
        }
      } catch (err) {
        console.warn('[WorkflowContainer] Failed to check resume session:', err);
      }
    };
    checkSession();
  }, [checkForResumeableSession]);

  // Save current session ID to localStorage when it changes
  useEffect(() => {
    if (orchestratorSessionId && orchestratorSessionId !== 'default-session') {
      localStorage.setItem('finger-last-session-id', orchestratorSessionId);
    }
  }, [orchestratorSessionId]);

  useEffect(() => {
    if (!currentSession?.projectPath) return;
    localStorage.setItem(WORKDIR_STORAGE_KEY, currentSession.projectPath);
  }, [currentSession?.projectPath]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('freeze-animations', disableAnimations);
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(DISABLE_ANIMATIONS_STORAGE_KEY, disableAnimations ? '1' : '0');
    }
  }, [disableAnimations]);

  const updatePanelFreeze = useCallback((key: PanelFreezeKey, enabled: boolean) => {
    setPanelFreeze((prev) => {
      const next = { ...prev, [key]: enabled } as PanelFreezeState;
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(PANEL_FREEZE_STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    });
  }, []);

  const updateDisableAnimations = useCallback((enabled: boolean) => {
    setDisableAnimations(enabled);
  }, []);

  const updateMonitorLiveUpdates = useCallback((enabled: boolean) => {
    setMonitorLiveUpdatesEnabled(enabled);
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(MONITOR_LIVE_UPDATES_STORAGE_KEY, enabled ? '1' : '0');
    }
  }, []);

  const resetPanelFreeze = useCallback(() => {
    setPanelFreeze({ ...DEFAULT_PANEL_FREEZE });
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(PANEL_FREEZE_STORAGE_KEY, JSON.stringify(DEFAULT_PANEL_FREEZE));
    }
  }, []);

  useEffect(() => {
    setSessionBinding((prev) => {
      if (prev.context === 'runtime') return prev;
      if (prev.context === 'orchestrator' && prev.sessionId === orchestratorSessionId) return prev;
      return {
        context: 'orchestrator',
        sessionId: orchestratorSessionId,
      };
    });
  }, [orchestratorSessionId]);

  const handleResumeSession = () => {
    setShowResumeDialog(false);
    // The session will be loaded via useSessions hook
  };

  const handleStartFresh = () => {
    setShowResumeDialog(false);
    setResumeTarget(null);
    localStorage.removeItem('finger-last-session-id');
  };

  const {
    executionState,
    runtimeEvents,
    setSelectedAgentId,
    isLoading,
    error,
  } = useWorkflowExecution(activeSessionId, currentSession?.projectPath, {
    disableRealtime: uiDisable.realtime,
    disablePolling: uiDisable.polling,
  });

  const systemAgentExecution = useWorkflowExecution(systemAgentSessionId, systemProjectPath, {
    disableRealtime: uiDisable.realtime,
    disablePolling: uiDisable.polling,
  });

  useEffect(() => {
    if (sessionBinding.context !== 'runtime') return;
    setDrawerAgentId(null);
    setSelectedAgentId(null);
  }, [sessionBinding.context, setSelectedAgentId]);

  const {
    configAgents: configPanelAgents,
    runtimeAgents: runtimePanelAgents,
    catalogAgents: catalogPanelAgents,
    instances: runtimeInstances,
    configs: agentConfigItems,
    startupTargets,
    startupTemplates,
    orchestrationConfig,
    debugMode,
    isLoading: isLoadingAgentPanel,
    error: agentPanelError,
    refresh: refreshAgentPanel,
    controlAgent,
  } = useAgentRuntimePanel();
  const [drawerAgentId, setDrawerAgentId] = useState<string | null>(null);
  const effectiveDrawerAgentId = drawerAgentId;

  const nonSystemSessions = useMemo(
    () => sessions.filter(s => !isSystemSession(s)),
    [sessions],
  );

  const frozenSessions = useFrozenValue(nonSystemSessions, panelFreeze.left);
  const frozenCurrentSession = useFrozenValue(currentSession, panelFreeze.left);
  const frozenIsLoadingSessions = useFrozenValue(isLoadingSessions, panelFreeze.left);
  const frozenRuntimeInstancesForLeft = useFrozenValue(runtimeInstances, panelFreeze.left);
  const frozenFocusedRuntimeInstanceId = useFrozenValue(sessionBinding.runtimeInstanceId ?? null, panelFreeze.left);
  const frozenActiveRuntimeSessionId = useFrozenValue(
    sessionBinding.context === 'runtime' ? sessionBinding.sessionId : null,
    panelFreeze.left,
  );
  const frozenDrawerAgentIdForLeft = useFrozenValue(drawerAgentId, panelFreeze.left);

  const handleSwitchSessionFromSidebar = useCallback(async (sessionId: string): Promise<void> => {
    await switchSession(sessionId);
    setSessionBinding({
      context: 'orchestrator',
      sessionId,
    });
    setDrawerAgentId(null);
    setSelectedAgentId(null);
  }, [switchSession, setSelectedAgentId]);


  const { agents: agentModules } = useAgents();
  const chatInputCapability = useMemo(
    () => resolveChatInputCapability(agentModules),
    [agentModules],
  );

  // All hooks must be called before any conditional returns
  const chatAgents = React.useMemo(() => {
    const merged = new Map<string, AgentRuntime>();

    for (const agent of runtimePanelAgents) {
      merged.set(agent.id, {
        id: agent.id,
        name: agent.name,
        type: agent.type === 'searcher' ? 'executor' : agent.type,
        status: normalizeChatAgentStatus(agent.status),
        load: 0,
        errorRate: 0,
        requestCount: 0,
        tokenUsage: 0,
        ...(agent.instanceCount > 0 ? { instanceCount: agent.instanceCount } : {}),
      });
    }

    if (executionState?.agents) {
      for (const liveAgent of executionState.agents) {
        const current = merged.get(liveAgent.id);
        if (!current) {
          merged.set(liveAgent.id, liveAgent);
          continue;
        }
        merged.set(liveAgent.id, {
          ...current,
          ...liveAgent,
          instanceCount:
            typeof liveAgent.instanceCount === 'number'
              ? liveAgent.instanceCount
              : current.instanceCount,
        });
      }
    }

    return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [executionState?.agents, runtimePanelAgents]);

  const projectChatAgents = React.useMemo(
    () => chatAgents.filter((a) => a.id.startsWith('project:')),
    [chatAgents],
  );

  const systemChatAgents = React.useMemo(
    () => chatAgents.filter((a) => a.id === 'finger-system-agent'),
    [chatAgents],
  );

  const projectRuntimeAgents = React.useMemo(
    () => runtimePanelAgents.filter((a) => a.id.startsWith('project:')),
    [runtimePanelAgents],
  );

  const mirrorDisplayName = React.useMemo(
    () => runtimePanelAgents.find((agent) => agent.id === 'finger-system-agent')?.name
      || systemChatAgents[0]?.name
      || 'Mirror',
    [runtimePanelAgents, systemChatAgents],
  );

  // Phase 3: Auto-switch back to orchestrator when runtime finishes
  // 基于 RuntimeEvent 显式字段：runtimeEventType/runtimeStatus/runtimeInstanceId/runtimeSessionId
  useEffect(() => {
    // 只在 runtime context 下监听
    if (sessionBinding.context !== 'runtime') return;
    if (runtimeEvents.length === 0) return;

    // 找到最后一个 runtime_finished 事件
    const lastRuntimeEvent = [...runtimeEvents].reverse().find((event) => {
      return event.runtimeEventType === 'runtime_finished';
    });

    if (!lastRuntimeEvent) return;

    // 必须匹配当前绑定的 runtime session
    const matchesSession = sessionBinding.runtimeInstanceId
      ? lastRuntimeEvent.runtimeInstanceId === sessionBinding.runtimeInstanceId
      : (sessionBinding.sessionId && lastRuntimeEvent.runtimeSessionId === sessionBinding.sessionId);

    if (!matchesSession) return;

    // 检查终态：completed/failed/interrupted
    const isTerminalStatus = lastRuntimeEvent.runtimeStatus === 'completed'
      || lastRuntimeEvent.runtimeStatus === 'failed'
      || lastRuntimeEvent.runtimeStatus === 'interrupted';

    if (isTerminalStatus) {
      // 自动切回 orchestrator
      setSessionBinding({
        context: 'orchestrator',
        sessionId: orchestratorSessionId,
      });
      setSelectedAgentId(null);
    }
  }, [runtimeEvents, sessionBinding, orchestratorSessionId, setSelectedAgentId]);

  const selectedDrawerAgent = useMemo(
    () => configPanelAgents.find((agent) => agent.id === effectiveDrawerAgentId) ?? null,
    [configPanelAgents, effectiveDrawerAgentId],
  );

  const selectedDrawerConfig = useMemo(() => {
    if (selectedDrawerAgent) return findConfigForAgent(selectedDrawerAgent, agentConfigItems);
    if (effectiveDrawerAgentId) return agentConfigItems.find((item) => item.id === effectiveDrawerAgentId) ?? null;
    return null;
  }, [agentConfigItems, effectiveDrawerAgentId, selectedDrawerAgent]);

  const selectedDrawerCapabilities = useMemo(
    () => catalogPanelAgents.find((item) => item.id === effectiveDrawerAgentId)?.capabilities ?? null,
    [catalogPanelAgents, effectiveDrawerAgentId],
  );

  const handleSelectAgentConfig = useCallback((agentId: string) => {
    setDrawerAgentId(agentId);
  }, []);

  const selectedDrawerInstances = useMemo(
    () => (selectedDrawerAgent
      ? runtimeInstances.filter((instance) => matchInstanceToAgent(selectedDrawerAgent, instance))
      : []),
    [runtimeInstances, selectedDrawerAgent],
  );

  const handleSelectInstance = useCallback(async (instanceIdOrPayload: string | { id?: string; sessionId?: string }): Promise<void> => {
    const selectedInstance = typeof instanceIdOrPayload === 'string'
      ? runtimeInstances.find((item) => item.id === instanceIdOrPayload)
      : runtimeInstances.find((item) => (
          (typeof instanceIdOrPayload.id === 'string' && item.id === instanceIdOrPayload.id)
          || item.sessionId === instanceIdOrPayload.sessionId
        ));
    if (!selectedInstance) return;
    const sessionIdToSwitch = selectedInstance.sessionId
      || (selectedInstance.type === 'orchestrator' ? orchestratorSessionId : undefined);
    if (!sessionIdToSwitch) return;
    setDrawerAgentId(null);
    const shouldRestoreOrchestrator = selectedInstance.type === 'orchestrator' || sessionIdToSwitch === orchestratorSessionId;
    if (shouldRestoreOrchestrator) {
      await switchSession(sessionIdToSwitch);
      setSessionBinding({
        context: 'orchestrator',
        sessionId: sessionIdToSwitch,
      });
      setSelectedAgentId(null);
      return;
    }
    setSessionBinding({
      context: 'runtime',
      sessionId: sessionIdToSwitch,
      runtimeInstanceId: selectedInstance.id,
    });
    setSelectedAgentId(selectedInstance.agentId);
  }, [orchestratorSessionId, runtimeInstances, switchSession]);

  const handleSelectRuntimeSession = useCallback(async (instance: AgentRuntimeInstance): Promise<void> => {
    await handleSelectInstance(instance);
  }, [handleSelectInstance]);

  useEffect(() => {
  }, [sessionBinding, orchestratorSessionId, setSelectedAgentId]);
  useEffect(() => {
    if (sessionBinding.context !== 'runtime') return;
    const boundInstance = runtimeInstances.find((instance) => (
      (sessionBinding.runtimeInstanceId && instance.id === sessionBinding.runtimeInstanceId)
      || instance.sessionId === sessionBinding.sessionId
    ));
    if (!boundInstance) {
      setSessionBinding({
        context: 'orchestrator',
        sessionId: orchestratorSessionId,
      });
      setSelectedAgentId(null);
    }
  }, [orchestratorSessionId, runtimeInstances, sessionBinding, setSelectedAgentId]);

  const handleSaveAgentConfig = useCallback(async (payload: { config: AgentConfig; instanceCount: number }): Promise<void> => {
    const agentId = payload.config.id?.trim();
    if (!agentId) {
      throw new Error('agentId is required');
    }

    const response = await fetch(`/api/v1/agents/configs/${encodeURIComponent(agentId)}`);
    if (!response.ok) {
      const message = await response.text().catch(() => `HTTP ${response.status}`);
      throw new Error(message || `HTTP ${response.status}`);
    }

    const snapshot = await response.json() as { config?: Record<string, unknown> };
    const currentConfig = (snapshot.config && typeof snapshot.config === 'object') ? snapshot.config : { id: agentId };
    const nextConfig = {
      ...currentConfig,
      ...payload.config,
      id: agentId,
      instanceCount: payload.instanceCount,
      enabled: payload.config.enabled,
      capabilities: payload.config.capabilities,
      defaultQuota: payload.config.defaultQuota,
      quotaPolicy: payload.config.quotaPolicy,
    };

    const saveResponse = await fetch(`/api/v1/agents/configs/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: nextConfig }),
    });
    if (!saveResponse.ok) {
      const message = await saveResponse.text().catch(() => `HTTP ${saveResponse.status}`);
      throw new Error(message || `HTTP ${saveResponse.status}`);
    }

    await refreshAgentPanel();
  }, [refreshAgentPanel]);

  const handleAgentControl = useCallback(async (payload: {
    action: 'status' | 'pause' | 'resume' | 'interrupt' | 'cancel';
    targetAgentId?: string;
    sessionId?: string;
    workflowId?: string;
    providerId?: string;
    hard?: boolean;
  }) => {
    const result = await controlAgent(payload);
    await refreshAgentPanel();
    return result;
  }, [controlAgent, refreshAgentPanel]);


  const frozenBottomPayload = useFrozenValue({
    configAgents: configPanelAgents,
    runtimeAgents: runtimePanelAgents,
    instances: runtimeInstances,
    configs: agentConfigItems,
    startupTargets,
    startupTemplates,
    orchestrationConfig,
    debugMode,
    selectedAgentConfigId: drawerAgentId,
    currentSessionId: activeSessionId,
    focusedRuntimeInstanceId: sessionBinding.runtimeInstanceId ?? null,
    isLoading: isLoadingAgentPanel,
    error: agentPanelError,
  }, panelFreeze.bottom);
  const systemMonitor = useSystemMonitor();
  const handleContextCommand = useCallback((
    action: 'focus_latest_round' | 'focus_latest_strategy_change' | 'step_compare_prev' | 'step_compare_next',
  ) => {
    setContextMonitorCommand({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action,
    });
  }, []);

  const canvasElement = useMemo(() => {
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));
    const runtimeMembers = runtimeInstances
      .filter((instance) => isTeamMemberAgent(instance.agentId))
      .sort((a, b) => {
        const aActive = isActiveRuntimeStatus(a.status) ? 1 : 0;
        const bActive = isActiveRuntimeStatus(b.status) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return a.name.localeCompare(b.name);
      });

    const runtimeMemberAgentIds = new Set(runtimeMembers.map((instance) => instance.agentId));
    const standbyMembers = runtimePanelAgents
      .filter((agent) => isTeamMemberAgent(agent.id) && !runtimeMemberAgentIds.has(agent.id))
      .sort((a, b) => {
        const aActive = isActiveRuntimeStatus(a.status) ? 1 : 0;
        const bActive = isActiveRuntimeStatus(b.status) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return a.name.localeCompare(b.name);
      });

    type TeamCard =
      | {
          kind: 'runtime';
          key: string;
          name: string;
          status: string;
          sessionId: string;
          projectPath: string;
          sessions: Array<{ id: string; name: string }>;
        }
      | {
          kind: 'standby';
          key: string;
          name: string;
          status: string;
        };

    const teamCards: TeamCard[] = [];
    for (const member of runtimeMembers) {
      const sessionId = member.sessionId;
      if (!sessionId) {
        teamCards.push({
          kind: 'standby',
          key: `standby-runtime-${member.id}`,
          name: member.name,
          status: member.status,
        });
        continue;
      }
      const boundSession = sessionMap.get(sessionId);
      if (!boundSession) {
        teamCards.push({
          kind: 'standby',
          key: `standby-unbound-${member.id}`,
          name: member.name,
          status: `${member.status} · session pending`,
        });
        continue;
      }
      const projectPath = boundSession.projectPath || currentSession?.projectPath || SYSTEM_PROJECT_PATH;
      const normalizedProject = normalizeProjectPath(projectPath);
      const projectSessions = sessions
        .filter((s) => normalizeProjectPath(s.projectPath) === normalizedProject)
        .sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime())
        .map((s) => ({ id: s.id, name: s.name }));
      teamCards.push({
        kind: 'runtime',
        key: member.id,
        name: member.name,
        status: member.status,
        sessionId,
        projectPath,
        sessions: projectSessions.length > 0
          ? projectSessions
          : [{ id: sessionId, name: boundSession?.name || member.name }],
      });
    }
    for (const member of standbyMembers) {
      teamCards.push({
        kind: 'standby',
        key: `standby-${member.id}`,
        name: member.name,
        status: member.status,
      });
    }

    const visibleCards = teamCards.slice(0, 4);
    return (
      <div className="canvas-shell">
        <PerformanceCard
          paused={panelFreeze.performance || uiDisable.performance}
          runtimeOverview={systemAgentExecution.runtimeOverview}
          onContextAction={handleContextCommand}
        />
        <div className="canvas-body">
          <div className="team-section-header">
            <span>Team Members</span>
            <strong>Active Runtime Sessions</strong>
          </div>
          <div className="session-grid-2x2" data-testid="multi-agent-monitor-grid">
            {visibleCards.map((card) => (
              <div className="session-grid-cell" key={card.key}>
                {card.kind === 'runtime' ? (
                  <div className="team-member-panel">
                    <div className="team-member-panel-header">
                      <span className="team-member-name">{card.name}</span>
                      <span className={`team-member-status ${isActiveRuntimeStatus(card.status) ? 'active' : ''}`}>
                        {card.status}
                      </span>
                    </div>
                    <AgentSessionPanel
                      projectPath={card.projectPath}
                      sessionId={card.sessionId}
                      sessions={card.sessions}
                      scheduledTasks={[]}
                      selectedSessionId={card.sessionId}
                      chatAgents={projectChatAgents}
                      inputCapability={chatInputCapability}
                    />
                  </div>
                ) : (
                  <div className="team-member-standby">
                    <div className="team-member-name">{card.name}</div>
                    <div className="team-member-status">{card.status}</div>
                  </div>
                )}
              </div>
            ))}
            {Array.from({ length: Math.max(0, 4 - visibleCards.length) }).map((_, idx) => (
              <div className="session-grid-cell" key={`team-placeholder-${idx}`}>
                <div className="grid-placeholder">等待 Team Member 任务...</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }, [panelFreeze.performance, uiDisable.performance, systemAgentExecution.runtimeOverview, handleContextCommand, runtimeInstances, runtimePanelAgents, sessions, currentSession?.projectPath, projectChatAgents, chatInputCapability]);

 const rightPanelElement = useMemo(() => {
   const systemSessions = sessions.filter(s => isSystemSession(s)).sort(
     (a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime(),
   );
   const selectedSystemSessionId = systemSessions.length > 0 ? systemSessions[0].id : undefined;

   return (
    <div className="team-bridge-shell">
      <div className="team-section-header bridge-header">
        <span>Team Bridge</span>
        <strong>{mirrorDisplayName}</strong>
      </div>
      <AgentSessionPanel
        projectPath={SYSTEM_PROJECT_PATH}
        sessionId={selectedSystemSessionId ?? systemAgentSessionId}
        sessions={systemSessions.map(s => ({ id: s.id, name: s.name }))}
        scheduledTasks={[]}
        selectedSessionId={selectedSystemSessionId}
        onSelectSession={(sessionId) => { void handleSwitchSessionFromSidebar(sessionId); }}
        onCreateSession={(projectPath) => createSession(projectPath)}
        onSwitchSession={handleSwitchSessionFromSidebar}
        onDeleteSession={removeSession}
        chatAgents={systemChatAgents}
        inputCapability={chatInputCapability}
      />
    </div>
  );
 }, [sessions, systemAgentSessionId, handleSwitchSessionFromSidebar, createSession, removeSession, systemChatAgents, chatInputCapability, mirrorDisplayName]);

  const leftSidebarElement = useMemo(() => (
    <LeftSidebar
      sessions={frozenSessions}
      currentSession={frozenCurrentSession}
      isLoadingSessions={frozenIsLoadingSessions}
      runtimeInstances={frozenRuntimeInstancesForLeft}
      runtimeAgents={projectRuntimeAgents}
      runtimeConfigs={agentConfigItems}
      focusedRuntimeInstanceId={frozenFocusedRuntimeInstanceId}
      activeRuntimeSessionId={frozenActiveRuntimeSessionId}
      onSwitchRuntimeInstance={(instance) => { void handleSelectRuntimeSession(instance); }}
      onCreateSession={createSession}
      onDeleteSession={removeSession}
      onRenameSession={renameSession}
      onSwitchSession={handleSwitchSessionFromSidebar}
      onRefreshSessions={refreshSessions}
      onToggleSystemMonitor={systemMonitor.toggle}
      isSystemMonitorEnabled={systemMonitor.isEnabled}
      systemMonitorEntries={systemMonitor.entries}
      panelFreeze={panelFreeze}
      onUpdatePanelFreeze={updatePanelFreeze}
      onResetPanelFreeze={resetPanelFreeze}
      disableAnimations={disableAnimations}
      onToggleDisableAnimations={updateDisableAnimations}
      monitorLiveUpdatesEnabled={monitorLiveUpdatesEnabled}
      onToggleMonitorLiveUpdates={updateMonitorLiveUpdates}
      viewMode={viewMode}
      onSetViewMode={setViewMode}
    />
  ), [createSession, disableAnimations, frozenActiveRuntimeSessionId, frozenCurrentSession, frozenDrawerAgentIdForLeft, frozenFocusedRuntimeInstanceId, frozenIsLoadingSessions, frozenRuntimeInstancesForLeft, frozenSessions, handleSelectInstance, handleSwitchSessionFromSidebar, monitorLiveUpdatesEnabled, panelFreeze, refreshSessions, removeSession, renameSession, resetPanelFreeze, updateDisableAnimations, updateMonitorLiveUpdates, updatePanelFreeze, systemMonitor.toggle, systemMonitor.isEnabled, systemMonitor.entries, viewMode, setViewMode]);

  const bottomPanelElement = useMemo(() => (
    <div className="ledger-bottom-panel">
      <div className="team-section-header bottom-board-header">
        <span>Context & Config</span>
        <strong>Observation Boards</strong>
      </div>
      <AgentPromptStrip
        configAgents={frozenBottomPayload.configAgents}
        runtimeAgents={frozenBottomPayload.runtimeAgents}
        configs={frozenBottomPayload.configs}
        selectedAgentConfigId={frozenBottomPayload.selectedAgentConfigId}
        onSelectAgentConfig={handleSelectAgentConfig}
      />
      <div className="ledger-monitor-row">
        <ContextMonitor
          sessionId={systemAgentSessionId}
          label="Context Builder Monitor"
          liveUpdatesEnabled={monitorLiveUpdatesEnabled}
          externalCommand={contextMonitorCommand}
        />
        <LedgerMonitor
          sessionId={systemAgentSessionId}
          label="Mirror Ledger"
          liveUpdatesEnabled={monitorLiveUpdatesEnabled}
        />
        {systemMonitor.entries.filter((entry) => entry.monitored).slice(0, 2).map((entry) => {
          const projectSessions = sessions
            .filter((s) => normalizeProjectPath(s.projectPath) === normalizeProjectPath(entry.projectPath))
            .sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime());
          const sid = projectSessions[0]?.id;
          return (
            <LedgerMonitor
              key={entry.projectId}
              sessionId={sid}
              label={`Project Ledger · ${entry.projectName}`}
              liveUpdatesEnabled={monitorLiveUpdatesEnabled}
            />
          );
        })}
      </div>
    </div>
  ), [frozenBottomPayload, handleSelectAgentConfig, monitorLiveUpdatesEnabled, systemAgentSessionId, contextMonitorCommand, systemMonitor.entries, sessions]);

  const renderedLeftSidebar = useFrozenValue(leftSidebarElement, panelFreeze.left);
  const renderedCanvas = useFrozenValue(
    uiDisable.canvas ? <div className="canvas-shell"><div className="canvas-body">Canvas Disabled</div></div> : canvasElement,
    panelFreeze.canvas,
  );
  const renderedRightPanel = useFrozenValue(
    uiDisable.right ? <div className="right-panel"><div className="right-panel-placeholder">Right Panel Disabled</div></div> : rightPanelElement,
    panelFreeze.right,
  );
  const renderedBottomPanel = useFrozenValue(
    uiDisable.bottom ? <div className="bottom-panel-container"><div className="bottom-panel-placeholder">Bottom Panel Disabled</div></div> : bottomPanelElement,
    panelFreeze.bottom,
  );
  // note: requestDetailsEnabled, setRequestDetailsEnabled intentionally omitted from deps for now (UI-only toggle)

  // Use overlay instead of early return to maintain hook consistency
  const loadingOverlay = isLoading || isLoadingSessions ? (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0e1217', color: '#9ca3af' }}>
      <div>
        <div style={{ fontSize: '24px', marginBottom: '16px' }}>⏳</div>
        <div>加载中...</div>
      </div>
    </div>
  ) : null;

  const errorOverlay = error || sessionError ? (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0e1217', color: '#ef4444' }}>
      <div>
        <div style={{ fontSize: '24px', marginBottom: '16px' }}>❌</div>
        <div>Error: {error || sessionError}</div>
      </div>
    </div>
  ) : null;

  return (
    <>
      {loadingOverlay}
      {errorOverlay}
      <AppLayout
        leftSidebar={renderedLeftSidebar}
        canvas={renderedCanvas}
        rightPanel={renderedRightPanel}
        bottomPanel={renderedBottomPanel}
      />
      <AgentConfigDrawer
        isOpen={selectedDrawerAgent !== null}
        agent={selectedDrawerAgent}
        capabilities={selectedDrawerCapabilities}
        config={selectedDrawerConfig}
        instances={selectedDrawerInstances}
        assertions={selectedDrawerAgent?.debugAssertions ?? []}
        currentSessionId={activeSessionId}
        onClose={() => {
          setDrawerAgentId(null);
        }}
        onSwitchInstance={(instance) => { void handleSelectInstance(instance); }}
        onSaveAgentConfig={handleSaveAgentConfig}
        onControlAgent={handleAgentControl}
      />
      <SessionResumeDialog
        isOpen={showResumeDialog}
        sessionId={resumeTarget?.sessionId || ''}
        progress={resumeTarget?.progress || 0}
        originalTask={resumeTarget?.originalTask || ''}
        timestamp={resumeTarget?.timestamp || ''}
        onResume={handleResumeSession}
        onStartFresh={handleStartFresh}
        onClose={() => setShowResumeDialog(false)}
      />
    </>
  );
};
