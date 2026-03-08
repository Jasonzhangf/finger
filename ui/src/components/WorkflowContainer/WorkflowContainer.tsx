import React, { useMemo, useEffect, useState, useCallback, useRef } from 'react';
import { PerformanceCard } from '../PerformanceCard/PerformanceCard.js';
import { ChatInterface } from '../ChatInterface/ChatInterface.js';
import type { InputCapability } from '../ChatInterface/ChatInterface.js';
import { AppLayout } from '../layout/AppLayout.js';
import { LeftSidebar } from '../LeftSidebar/LeftSidebar.js';
import { BottomPanel } from '../BottomPanel/BottomPanel.js';
import { AgentConfigDrawer } from '../AgentConfigDrawer/AgentConfigDrawer.js';
import { SessionResumeDialog } from '../SessionResumeDialog/SessionResumeDialog.js';
import { useSessionResume } from '../../hooks/useSessionResume.js';
import { useSessions } from '../../hooks/useSessions.js';
import { useWorkflowExecution } from '../../hooks/useWorkflowExecution.js';
import { DEFAULT_CHAT_AGENT_ID } from '../../hooks/useWorkflowExecution.constants.js';
import { useAgents } from '../../hooks/useAgents.js';
import { useAgentRuntimePanel } from '../../hooks/useAgentRuntimePanel.js';
import { TaskFlowCanvas } from '../TaskFlowCanvas/TaskFlowCanvas.js';
import type { Loop, LoopNode } from '../TaskFlowCanvas/types.js';
import { findConfigForAgent, matchInstanceToAgent, resolveInstanceDisplayName } from '../BottomPanel/agentRuntimeUtils.js';
import type { AgentConfig, AgentRuntime } from '../../api/types.js';
import type { AgentRuntimeInstance, AgentRuntimePanelAgent } from '../../hooks/useAgentRuntimePanel.js';

interface ResumeCheckResult {
  sessionId: string;
  timestamp: string;
  originalTask: string;
  progress: number;
}

const CHAT_GATEWAY_ID = 'finger-orchestrator-gateway';
const WORKDIR_STORAGE_KEY = 'finger-ui-workdir';
const PANEL_FREEZE_STORAGE_KEY = 'finger-ui-panel-freeze';
const DISABLE_ANIMATIONS_STORAGE_KEY = 'finger-ui-disable-animations';
const UI_DISABLE_STORAGE_KEY = 'finger-ui-disable-flags';

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

function mapInstanceStatusToLoopNodeStatus(status: string): LoopNode['status'] {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'running' || normalized === 'waiting_input') return 'running';
  if (normalized === 'completed') return 'done';
  if (normalized === 'failed' || normalized === 'error' || normalized === 'interrupted') return 'failed';
  return 'waiting';
}

function mapAgentTypeToLoopNodeType(type: string): LoopNode['type'] {
  if (type === 'orchestrator') return 'orch';
  if (type === 'reviewer') return 'review';
  if (type === 'executor' || type === 'searcher') return 'exec';
  return 'user';
}

function isRuntimeBusyStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === 'running' || normalized === 'queued' || normalized === 'waiting_input' || normalized === 'paused';
}

function resolveAgentDisplayName(
  agentId: string | null | undefined,
  configAgents: AgentRuntimePanelAgent[],
  runtimeAgents: AgentRuntimePanelAgent[],
): string | null {
  const normalized = typeof agentId === 'string' ? agentId.trim().toLowerCase() : '';
  if (!normalized) return null;
  const combined = [...configAgents, ...runtimeAgents];
  const match = combined.find((agent) => agent.id.trim().toLowerCase() === normalized);
  return match?.name ?? agentId ?? null;
}

function resolveRuntimeInstanceDisplay(
  instance: AgentRuntimeInstance | null,
  configAgents: AgentRuntimePanelAgent[],
  runtimeAgents: AgentRuntimePanelAgent[],
): { agentId: string | null; agentName: string | null } {
  if (!instance) return { agentId: null, agentName: null };
  const agentId = instance.agentId?.trim() || null;
  const displayName = resolveAgentDisplayName(agentId, configAgents, runtimeAgents)
    ?? instance.name?.trim()
    ?? agentId;
  return {
    agentId,
    agentName: displayName,
  };
}

export const WorkflowContainer: React.FC = () => {
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
  const [uiDisable] = useState<UiDisableState>(() => {
    if (typeof window === 'undefined' || !window.localStorage) return { ...DEFAULT_UI_DISABLE };
    return readUiDisableState();
  });
  const instanceTimestampRef = useRef<Record<string, string>>({});
  const workflowTimestampRef = useRef<Record<string, string>>({});

  const orchestratorSessionId = currentSession?.sessionTier === 'runtime'
    ? (currentSession.rootSessionId || currentSession.parentSessionId || (sessions.length > 0 ? sessions[0].id : 'default-session'))
    : (currentSession?.id || (sessions.length > 0 ? sessions[0].id : 'default-session'));
  const [sessionBinding, setSessionBinding] = useState<{
    context: 'orchestrator' | 'runtime';
    sessionId: string;
    runtimeInstanceId?: string;
  }>({
    context: 'orchestrator',
    sessionId: orchestratorSessionId,
  });
  const activeSessionId = sessionBinding.context === 'runtime' ? sessionBinding.sessionId : orchestratorSessionId;
  const activeDisplaySession = useMemo(() => {
    if (currentSession?.id === activeSessionId) return currentSession;
    return sessions.find((item) => item.id === activeSessionId) ?? null;
  }, [activeSessionId, currentSession, sessions]);

  const getStableTimestamp = useCallback((key: string, ref: React.MutableRefObject<Record<string, string>>): string => {
    if (!key) return new Date().toISOString();
    const existing = ref.current[key];
    if (existing) return existing;
    const timestamp = new Date().toISOString();
    ref.current[key] = timestamp;
    return timestamp;
  }, []);

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
    sessionAgentId,
    selectedAgentId,
    setSelectedAgentId,
    isLoading,
    error,
    pauseWorkflow,
    resumeWorkflow,
    interruptCurrentTurn,
    sendUserInput,
    editRuntimeEvent,
    deleteRuntimeEvent,
    agentRunStatus,
    runtimeOverview,
    toolPanelOverview,
    updateToolExposure,
    contextEditableEventIds,
    isConnected,
   debugSnapshotsEnabled,
   setDebugSnapshotsEnabled,
   debugSnapshots,
   clearDebugSnapshots,
   orchestratorRuntimeMode,
   requestDetailsEnabled,
   setRequestDetailsEnabled,
 } = useWorkflowExecution(activeSessionId, currentSession?.projectPath, {
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
    setDebugMode: setRuntimeDebugMode,
    startTemplate,
    saveOrchestrationConfig,
    switchOrchestrationProfile,
    controlAgent,
  } = useAgentRuntimePanel();
  const [drawerAgentId, setDrawerAgentId] = useState<string | null>(null);
  const effectiveDrawerAgentId = drawerAgentId;

  const frozenSessions = useFrozenValue(sessions, panelFreeze.left);
  const frozenCurrentSession = useFrozenValue(currentSession, panelFreeze.left);
  const frozenIsLoadingSessions = useFrozenValue(isLoadingSessions, panelFreeze.left);
  const frozenRuntimeInstancesForLeft = useFrozenValue(runtimeInstances, panelFreeze.left);
  const frozenFocusedRuntimeInstanceId = useFrozenValue(sessionBinding.runtimeInstanceId ?? null, panelFreeze.left);
  const frozenActiveRuntimeSessionId = useFrozenValue(
    sessionBinding.context === 'runtime' ? sessionBinding.sessionId : null,
    panelFreeze.left,
  );
  const frozenDrawerAgentIdForLeft = useFrozenValue(drawerAgentId, panelFreeze.left);

  const handleCreateNewSession = useCallback(async (): Promise<void> => {
    const fromStorage = localStorage.getItem(WORKDIR_STORAGE_KEY)?.trim();
    const projectPath = currentSession?.projectPath?.trim() || fromStorage || '/';
    const created = await createSession(projectPath);
    await switchSession(created.id);
    setSessionBinding({
      context: 'orchestrator',
      sessionId: created.id,
    });
    setDrawerAgentId(null);
    setSelectedAgentId(null);
  }, [createSession, currentSession?.projectPath, switchSession]);

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

  const frozenRightPayload = useFrozenValue({
    executionState,
    runtimeEvents,
    contextEditableEventIds,
    agentRunStatus,
    runtimeOverview,
    toolPanelOverview,
    debugSnapshotsEnabled,
    debugSnapshots,
    orchestratorRuntimeMode,
    selectedAgentId,
  }, panelFreeze.right);

  const frozenActiveSessionId = useFrozenValue(activeSessionId, panelFreeze.right);
  const frozenChatAgents = useFrozenValue(chatAgents, panelFreeze.right);

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

  const handleSelectAgent = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
  }, [setSelectedAgentId]);

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
      return;
    }

    const normalizedStatus = boundInstance.status.trim().toLowerCase();
    const shouldReturnToOrchestrator = normalizedStatus === 'completed'
      || normalizedStatus === 'failed'
      || normalizedStatus === 'error'
      || normalizedStatus === 'interrupted';

    if (shouldReturnToOrchestrator) {
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

  const handleToggleAgentEnabled = useCallback(async (payload: { agentId: string; enabled: boolean }): Promise<void> => {
    const saveResponse = await fetch(`/api/v1/agents/configs/${encodeURIComponent(payload.agentId)}/enabled`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: payload.enabled }),
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

  const scopedRuntimeInstances = useMemo(() => {
    if (sessionBinding.context === 'runtime') {
      return runtimeInstances.filter((instance) => instance.sessionId === sessionBinding.sessionId);
    }
    return runtimeInstances;
  }, [runtimeInstances, sessionBinding.context, sessionBinding.sessionId]);

  const taskFlowProps = React.useMemo(() => {
    const workflowStamp = executionState?.workflowId
      ? getStableTimestamp(executionState.workflowId, workflowTimestampRef)
      : new Date().toISOString();
    const planHistory: Loop[] = [];
    const designHistory: Loop[] = [];
    const executionHistory: Loop[] = scopedRuntimeInstances
      .filter((instance) => {
        const normalized = instance.status.toLowerCase();
        return normalized === 'completed' || normalized === 'failed' || normalized === 'interrupted' || normalized === 'error';
      })
      .slice(0, 20)
      .map((instance) => {
        const instanceStamp = getStableTimestamp(instance.id, instanceTimestampRef);
        return {
          id: `history:${instance.id}`,
          epicId: executionState?.workflowId || activeSessionId,
        phase: 'execution',
        status: 'history',
          result: instance.status === 'completed' ? 'success' : 'failed',
          createdAt: instanceStamp,
          nodes: [
            {
              id: `node:${instance.id}:orch`,
              type: 'orch',
              status: 'done',
              title: 'orchestrator',
              text: 'dispatch completed',
              agentId: 'finger-orchestrator',
              timestamp: instanceStamp,
            },
            {
              id: `node:${instance.id}:${instance.agentId}`,
              type: mapAgentTypeToLoopNodeType(instance.type),
              status: mapInstanceStatusToLoopNodeStatus(instance.status),
              title: resolveInstanceDisplayName(instance, configPanelAgents, agentConfigItems),
              text: instance.workflowId ?? instance.sessionId ?? instance.id,
              agentId: instance.agentId,
              timestamp: instanceStamp,
            },
          ],
        };
      });
    const queue: Loop[] = scopedRuntimeInstances
      .filter((instance) => instance.status.toLowerCase() === 'queued')
      .map((instance) => {
        const instanceStamp = getStableTimestamp(instance.id, instanceTimestampRef);
        return {
          id: `queue:${instance.id}`,
          epicId: executionState?.workflowId || activeSessionId,
        phase: 'execution',
        status: 'queue',
          createdAt: instanceStamp,
          nodes: [
            {
              id: `node:${instance.id}:queue`,
              type: mapAgentTypeToLoopNodeType(instance.type),
              status: 'waiting',
              title: resolveInstanceDisplayName(instance, configPanelAgents, agentConfigItems),
              text: `queue: ${instance.workflowId ?? instance.sessionId ?? instance.id}`,
              agentId: instance.agentId,
              timestamp: instanceStamp,
            },
          ],
        };
      });
    const runningRuntimeNodes: LoopNode[] = scopedRuntimeInstances
      .filter((instance) => isRuntimeBusyStatus(instance.status))
      .map((instance) => {
        const instanceStamp = getStableTimestamp(instance.id, instanceTimestampRef);
        return {
          id: `node:${instance.id}:running`,
          type: mapAgentTypeToLoopNodeType(instance.type),
          status: mapInstanceStatusToLoopNodeStatus(instance.status),
          title: resolveInstanceDisplayName(instance, configPanelAgents, agentConfigItems),
          text: instance.workflowId ?? instance.sessionId ?? instance.id,
          agentId: instance.agentId,
          timestamp: instanceStamp,
        };
      });
    const orchestratorNodeStatus: LoopNode['status'] = sessionBinding.context === 'runtime' ? 'waiting' : 'running';
    const orchestratorNode: LoopNode = {
      id: `node:${activeSessionId}:orchestrator`,
      type: 'orch',
      status: orchestratorNodeStatus,
      title: 'orchestrator',
      text: sessionBinding.context === 'runtime' ? 'waiting runtime feedback' : 'active',
      agentId: 'finger-orchestrator',
      timestamp: workflowStamp,
    };
    const runningLoop = runningRuntimeNodes.length > 0 ? {
      id: `running:${activeSessionId}`,
      epicId: executionState?.workflowId || activeSessionId,
      phase: 'execution' as const,
      status: 'running' as const,
      createdAt: workflowStamp,
      nodes: [
        orchestratorNode,
        ...runningRuntimeNodes,
      ],
    } : undefined;

    return {
      epicId: executionState?.workflowId || activeSessionId,
      planHistory,
      designHistory,
      executionHistory,
      runningLoop,
      queue,
    };
  }, [activeSessionId, executionState?.workflowId, getStableTimestamp, scopedRuntimeInstances, sessionBinding.context]);

  const frozenTaskFlowProps = useFrozenValue(taskFlowProps, panelFreeze.canvas);

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

  const canvasElement = useMemo(() => (
    <div className="canvas-shell">
      <PerformanceCard paused={panelFreeze.performance || uiDisable.performance} />
      <div className="canvas-body">
        <TaskFlowCanvas
          epicId={frozenTaskFlowProps.epicId}
          planHistory={frozenTaskFlowProps.planHistory}
          designHistory={frozenTaskFlowProps.designHistory}
          executionHistory={frozenTaskFlowProps.executionHistory}
          runningLoop={frozenTaskFlowProps.runningLoop}
          queue={frozenTaskFlowProps.queue}
        />
      </div>
    </div>
  ), [frozenTaskFlowProps, panelFreeze.performance, uiDisable.performance]);

  const rightPanelElement = useMemo(() => {
    const runtimeInstance = sessionBinding.context === 'runtime'
      ? (runtimeInstances.find((instance) => (
          (sessionBinding.runtimeInstanceId && instance.id === sessionBinding.runtimeInstanceId)
          || instance.sessionId === sessionBinding.sessionId
        )) ?? null)
      : null;
    const runtimeDisplay = resolveRuntimeInstanceDisplay(runtimeInstance, configPanelAgents, runtimePanelAgents);
    const resolvedSessionAgentId = activeDisplaySession?.ownerAgentId || sessionAgentId || executionState?.orchestrator?.id || DEFAULT_CHAT_AGENT_ID;
    const orchestratorAgentName = resolveAgentDisplayName(resolvedSessionAgentId, configPanelAgents, runtimePanelAgents)
      ?? resolvedSessionAgentId
      ?? DEFAULT_CHAT_AGENT_ID;
    const runtimeAgentLabel = runtimeDisplay.agentName || `runtime:${sessionBinding.sessionId}`;
    const orchestratorAgentLabel = orchestratorAgentName;
    const interruptTargetLabel = sessionBinding.context === 'runtime'
      ? runtimeAgentLabel
      : orchestratorAgentLabel;
    const eventFilterAgentId = sessionBinding.context === 'runtime' ? (runtimeDisplay.agentId || null) : null;
    const contextLabel = sessionBinding.context === 'runtime'
      ? `上下文: 子会话 · agent ${runtimeAgentLabel}${runtimeDisplay.agentId ? ` (${runtimeDisplay.agentId})` : ''} · session ${sessionBinding.sessionId}`
      : `上下文: 主会话 · agent ${orchestratorAgentLabel}${resolvedSessionAgentId ? ` (${resolvedSessionAgentId})` : ''} · session ${orchestratorSessionId}`;
    const panelTitle = sessionBinding.context === 'runtime'
      ? runtimeAgentLabel
      : orchestratorAgentLabel;
    const showRuntimeModeBadge = sessionBinding.context !== 'runtime';
    return (
      <ChatInterface
        key={frozenActiveSessionId}
        executionState={frozenRightPayload.executionState}
        agents={frozenChatAgents}
        events={frozenRightPayload.runtimeEvents}
        contextEditableEventIds={frozenRightPayload.contextEditableEventIds}
        agentRunStatus={frozenRightPayload.agentRunStatus}
        runtimeOverview={frozenRightPayload.runtimeOverview}
        contextLabel={contextLabel}
        toolPanelOverview={frozenRightPayload.toolPanelOverview}
        onUpdateToolExposure={updateToolExposure}
        onSendMessage={sendUserInput}
        onEditMessage={editRuntimeEvent}
        onDeleteMessage={deleteRuntimeEvent}
        onCreateNewSession={handleCreateNewSession}
        onPause={pauseWorkflow}
        onResume={resumeWorkflow}
        onInterruptTurn={interruptCurrentTurn}
        isPaused={frozenRightPayload.executionState?.paused || false}
        isConnected={isConnected}
        onAgentClick={handleSelectAgent}
        selectedAgentId={frozenRightPayload.selectedAgentId}
        eventFilterAgentId={eventFilterAgentId}
        inputCapability={chatInputCapability}
        debugSnapshotsEnabled={frozenRightPayload.debugSnapshotsEnabled}
        onToggleDebugSnapshots={setDebugSnapshotsEnabled}
        debugSnapshots={frozenRightPayload.debugSnapshots}
        onClearDebugSnapshots={clearDebugSnapshots}
        orchestratorRuntimeMode={frozenRightPayload.orchestratorRuntimeMode}
        requestDetailsEnabled={requestDetailsEnabled}
        onToggleRequestDetails={setRequestDetailsEnabled}
        interruptTargetLabel={interruptTargetLabel}
        panelTitle={panelTitle}
        showRuntimeModeBadge={showRuntimeModeBadge}
      />
    );
  }, [activeDisplaySession?.ownerAgentId, clearDebugSnapshots, configPanelAgents, deleteRuntimeEvent, editRuntimeEvent, executionState?.orchestrator?.id, frozenActiveSessionId, frozenChatAgents, frozenRightPayload, handleCreateNewSession, handleSelectAgent, interruptCurrentTurn, isConnected, pauseWorkflow, resumeWorkflow, runtimeInstances, runtimePanelAgents, sendUserInput, sessionAgentId, sessionBinding.context, sessionBinding.runtimeInstanceId, sessionBinding.sessionId, orchestratorSessionId, setDebugSnapshotsEnabled, updateToolExposure, requestDetailsEnabled, setRequestDetailsEnabled]);

  const leftSidebarElement = useMemo(() => (
    <LeftSidebar
      sessions={frozenSessions}
      currentSession={frozenCurrentSession}
      isLoadingSessions={frozenIsLoadingSessions}
      runtimeInstances={frozenRuntimeInstancesForLeft}
      runtimeAgents={runtimePanelAgents}
      runtimeConfigs={agentConfigItems}
      focusedRuntimeInstanceId={frozenFocusedRuntimeInstanceId}
      activeRuntimeSessionId={frozenActiveRuntimeSessionId}
      onSwitchRuntimeInstance={(instance) => { void handleSelectInstance(instance); }}
      onCreateSession={createSession}
      onDeleteSession={removeSession}
      onRenameSession={renameSession}
      onSwitchSession={handleSwitchSessionFromSidebar}
      onRefreshSessions={refreshSessions}
      panelFreeze={panelFreeze}
      onUpdatePanelFreeze={updatePanelFreeze}
      onResetPanelFreeze={resetPanelFreeze}
      disableAnimations={disableAnimations}
      onToggleDisableAnimations={updateDisableAnimations}
    />
  ), [createSession, disableAnimations, frozenActiveRuntimeSessionId, frozenCurrentSession, frozenDrawerAgentIdForLeft, frozenFocusedRuntimeInstanceId, frozenIsLoadingSessions, frozenRuntimeInstancesForLeft, frozenSessions, handleSelectInstance, handleSwitchSessionFromSidebar, panelFreeze, refreshSessions, removeSession, renameSession, resetPanelFreeze, updateDisableAnimations, updatePanelFreeze]);

  const bottomPanelElement = useMemo(() => (
    <BottomPanel
      configAgents={frozenBottomPayload.configAgents}
      runtimeAgents={frozenBottomPayload.runtimeAgents}
      instances={frozenBottomPayload.instances}
      configs={frozenBottomPayload.configs}
      startupTargets={frozenBottomPayload.startupTargets}
      startupTemplates={frozenBottomPayload.startupTemplates}
      orchestrationConfig={frozenBottomPayload.orchestrationConfig}
      debugMode={frozenBottomPayload.debugMode}
      selectedAgentConfigId={frozenBottomPayload.selectedAgentConfigId}
      currentSessionId={frozenBottomPayload.currentSessionId}
      focusedRuntimeInstanceId={frozenBottomPayload.focusedRuntimeInstanceId}
      isLoading={frozenBottomPayload.isLoading}
      error={frozenBottomPayload.error}
      onSelectAgentConfig={handleSelectAgentConfig}
      onSelectInstance={(instance) => { void handleSelectInstance(instance); }}
      onRefresh={() => { void refreshAgentPanel(); }}
      onSetDebugMode={async (enabled) => {
        const result = await setRuntimeDebugMode(enabled);
        if (!result.ok) {
          throw new Error(result.error ?? '更新 debug mode 失败');
        }
      }}
      onStartTemplate={async (templateId) => {
        const result = await startTemplate({
          templateId,
          sessionId: orchestratorSessionId,
        });
        if (!result.ok) {
          throw new Error(result.error ?? `模板 ${templateId} 启动失败`);
        }
      }}
      onSwitchOrchestrationProfile={async (profileId) => {
        const result = await switchOrchestrationProfile(profileId);
        if (!result.ok) {
          throw new Error(result.error ?? `切换 profile 失败: ${profileId}`);
        }
      }}
      onSaveOrchestrationConfig={async (config) => {
        const result = await saveOrchestrationConfig(config);
        if (!result.ok) {
          throw new Error(result.error ?? '保存 orchestration 配置失败');
        }
      }}
      onToggleAgentEnabled={handleToggleAgentEnabled}
    />
  ), [frozenBottomPayload, handleSelectAgent, handleSelectInstance, handleToggleAgentEnabled, orchestratorSessionId, refreshAgentPanel, saveOrchestrationConfig, setRuntimeDebugMode, startTemplate, switchOrchestrationProfile]);

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
