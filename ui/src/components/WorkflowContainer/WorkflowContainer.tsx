import React, { useMemo, useEffect, useState, useCallback } from 'react';
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
import { useAgents } from '../../hooks/useAgents.js';
import { useAgentRuntimePanel } from '../../hooks/useAgentRuntimePanel.js';
import { TaskFlowCanvas } from '../TaskFlowCanvas/TaskFlowCanvas.js';
import type { Loop, LoopNode } from '../TaskFlowCanvas/types.js';
import { findConfigForAgent, matchInstanceToAgent } from '../BottomPanel/agentRuntimeUtils.js';
import type { AgentConfig, AgentRuntime } from '../../api/types.js';

interface ResumeCheckResult {
  sessionId: string;
  timestamp: string;
  originalTask: string;
  progress: number;
}

const CHAT_GATEWAY_ID = 'finger-orchestrator-gateway';
const WORKDIR_STORAGE_KEY = 'finger-ui-workdir';

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

function isRuntimeTerminalStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === 'completed'
    || normalized === 'failed'
    || normalized === 'interrupted'
    || normalized === 'error';
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

  const orchestratorSessionId = currentSession?.id || (sessions.length > 0 ? sessions[0].id : 'default-session');
  const [sessionBinding, setSessionBinding] = useState<{
    context: 'orchestrator' | 'runtime';
    sessionId: string;
    runtimeInstanceId?: string;
  }>({
    context: 'orchestrator',
    sessionId: orchestratorSessionId,
  });
  const activeSessionId = sessionBinding.context === 'runtime' ? sessionBinding.sessionId : orchestratorSessionId;

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
    setSessionBinding({
      context: 'orchestrator',
      sessionId: orchestratorSessionId,
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
    contextEditableEventIds,
    isConnected,
    debugSnapshotsEnabled,
    setDebugSnapshotsEnabled,
    debugSnapshots,
    clearDebugSnapshots,
    orchestratorRuntimeMode,
  } = useWorkflowExecution(activeSessionId);

  useEffect(() => {
    if (sessionBinding.context !== 'runtime') return;
    setDrawerAgentId(null);
    setSelectedAgentId(null);
  }, [sessionBinding.context, setSelectedAgentId]);

  const {
    agents: agentPanelAgents,
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

  const handleCreateNewSession = useCallback(async (): Promise<void> => {
    const fromStorage = localStorage.getItem(WORKDIR_STORAGE_KEY)?.trim();
    const projectPath = currentSession?.projectPath?.trim() || fromStorage || '/';
    const created = await createSession(projectPath);
    await switchSession(created.id);
  }, [createSession, currentSession?.projectPath, switchSession]);

  const { agents: agentModules } = useAgents();
  const chatInputCapability = useMemo(
    () => resolveChatInputCapability(agentModules),
    [agentModules],
  );

  // All hooks must be called before any conditional returns
  const chatAgents = React.useMemo(() => {
    const merged = new Map<string, AgentRuntime>();

    for (const agent of agentPanelAgents) {
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
  }, [executionState?.agents, agentPanelAgents]);

  const selectedDrawerAgent = useMemo(
    () => agentPanelAgents.find((agent) => agent.id === effectiveDrawerAgentId) ?? null,
    [effectiveDrawerAgentId, agentPanelAgents],
  );

  const selectedDrawerConfig = useMemo(
    () => (selectedDrawerAgent ? findConfigForAgent(selectedDrawerAgent, agentConfigItems) : null),
    [agentConfigItems, selectedDrawerAgent],
  );

  const selectedDrawerCapabilities = useMemo(
    () => agentPanelAgents.find((item) => item.id === effectiveDrawerAgentId)?.capabilities ?? null,
    [agentPanelAgents, effectiveDrawerAgentId],
  );

  const selectedDrawerInstances = useMemo(
    () => (selectedDrawerAgent
      ? runtimeInstances.filter((instance) => matchInstanceToAgent(selectedDrawerAgent, instance))
      : []),
    [runtimeInstances, selectedDrawerAgent],
  );

  const handleSelectAgent = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
    setDrawerAgentId(agentId);
  }, [setSelectedAgentId]);

  const handleSelectInstance = useCallback(async (instanceIdOrPayload: string | { id?: string; sessionId?: string }): Promise<void> => {
    const selectedInstance = typeof instanceIdOrPayload === 'string'
      ? runtimeInstances.find((item) => item.id === instanceIdOrPayload)
      : runtimeInstances.find((item) => (
          (typeof instanceIdOrPayload.id === 'string' && item.id === instanceIdOrPayload.id)
          || item.sessionId === instanceIdOrPayload.sessionId
        ));
    const sessionIdToSwitch = selectedInstance?.sessionId;
    if (!sessionIdToSwitch) return;
    setDrawerAgentId(null);
    setSelectedAgentId(null);
    setSessionBinding({
      context: 'runtime',
      sessionId: sessionIdToSwitch,
      runtimeInstanceId: selectedInstance?.id,
    });
  }, [runtimeInstances]);

  useEffect(() => {
    if (sessionBinding.context !== 'runtime') return;
    const boundInstance = runtimeInstances.find((instance) => (
      (sessionBinding.runtimeInstanceId && instance.id === sessionBinding.runtimeInstanceId)
      || instance.sessionId === sessionBinding.sessionId
    ));
    if (!boundInstance || isRuntimeTerminalStatus(boundInstance.status)) {
      setSessionBinding({
        context: 'orchestrator',
        sessionId: orchestratorSessionId,
      });
    }
  }, [orchestratorSessionId, runtimeInstances, sessionBinding]);

  const handleDeployAgent = useCallback(async (payload: { config: AgentConfig; instanceCount: number }): Promise<void> => {
    const targetSessionId = currentSession?.id || orchestratorSessionId;
    const response = await fetch('/api/v1/agents/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: targetSessionId,
        config: payload.config,
        scope: 'session',
        instanceCount: payload.instanceCount,
      }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => `HTTP ${response.status}`);
      throw new Error(message || `HTTP ${response.status}`);
    }
    await refreshAgentPanel();
  }, [currentSession?.id, orchestratorSessionId, refreshAgentPanel]);

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
    const planHistory: Loop[] = [];
    const designHistory: Loop[] = [];
    const executionHistory: Loop[] = scopedRuntimeInstances
      .filter((instance) => {
        const normalized = instance.status.toLowerCase();
        return normalized === 'completed' || normalized === 'failed' || normalized === 'interrupted' || normalized === 'error';
      })
      .slice(0, 20)
      .map((instance) => ({
        id: `history-${instance.id}`,
        epicId: executionState?.workflowId || activeSessionId,
        phase: 'execution',
        status: 'history',
        result: instance.status === 'completed' ? 'success' : 'failed',
        createdAt: new Date().toISOString(),
        nodes: [
          {
            id: `orch-${instance.id}`,
            type: 'orch',
            status: 'done',
            title: 'orchestrator',
            text: 'dispatch completed',
            agentId: 'finger-orchestrator',
            timestamp: new Date().toISOString(),
          },
          {
            id: `runtime-${instance.id}`,
            type: mapAgentTypeToLoopNodeType(instance.type),
            status: mapInstanceStatusToLoopNodeStatus(instance.status),
            title: instance.name,
            text: instance.workflowId ?? instance.sessionId ?? instance.id,
            agentId: instance.agentId,
            timestamp: new Date().toISOString(),
          },
        ],
      }));
    const queue: Loop[] = scopedRuntimeInstances
      .filter((instance) => instance.status.toLowerCase() === 'queued')
      .map((instance) => ({
        id: `queue-${instance.id}`,
        epicId: executionState?.workflowId || activeSessionId,
        phase: 'execution',
        status: 'queue',
        createdAt: new Date().toISOString(),
        nodes: [
          {
            id: `queue-node-${instance.id}`,
            type: mapAgentTypeToLoopNodeType(instance.type),
            status: 'waiting',
            title: instance.name,
            text: `queue: ${instance.workflowId ?? instance.sessionId ?? instance.id}`,
            agentId: instance.agentId,
            timestamp: new Date().toISOString(),
          },
        ],
      }));
    const runningRuntimeNodes: LoopNode[] = scopedRuntimeInstances
      .filter((instance) => isRuntimeBusyStatus(instance.status))
      .map((instance) => ({
        id: `running-${instance.id}`,
        type: mapAgentTypeToLoopNodeType(instance.type),
        status: mapInstanceStatusToLoopNodeStatus(instance.status),
        title: instance.name,
        text: instance.workflowId ?? instance.sessionId ?? instance.id,
        agentId: instance.agentId,
        timestamp: new Date().toISOString(),
      }));
    const orchestratorNodeStatus: LoopNode['status'] = sessionBinding.context === 'runtime' ? 'waiting' : 'running';
    const orchestratorNode: LoopNode = {
      id: `orchestrator-${activeSessionId}`,
      type: 'orch',
      status: orchestratorNodeStatus,
      title: 'orchestrator',
      text: sessionBinding.context === 'runtime' ? 'waiting runtime feedback' : 'active',
      agentId: 'finger-orchestrator',
      timestamp: new Date().toISOString(),
    };
    const runningLoop = runningRuntimeNodes.length > 0 ? {
      id: `running-${activeSessionId}`,
      epicId: executionState?.workflowId || activeSessionId,
      phase: 'execution' as const,
      status: 'running' as const,
      createdAt: new Date().toISOString(),
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
  }, [executionState?.workflowId, scopedRuntimeInstances, activeSessionId, sessionBinding.context]);

  const canvasElement = useMemo(() => (
    <div className="canvas-shell">
      <PerformanceCard />
      <div className="canvas-body">
        <TaskFlowCanvas
          epicId={taskFlowProps.epicId}
          planHistory={taskFlowProps.planHistory}
          designHistory={taskFlowProps.designHistory}
          executionHistory={taskFlowProps.executionHistory}
          runningLoop={taskFlowProps.runningLoop}
          queue={taskFlowProps.queue}
        />
      </div>
    </div>
  ), [taskFlowProps]);

  const rightPanelElement = useMemo(() => (
    <ChatInterface
      key={activeSessionId}
      executionState={executionState}
      agents={chatAgents}
      events={runtimeEvents}
      contextEditableEventIds={contextEditableEventIds}
      agentRunStatus={agentRunStatus}
      runtimeOverview={runtimeOverview}
      toolPanelOverview={toolPanelOverview}
      onSendMessage={sendUserInput}
      onEditMessage={editRuntimeEvent}
      onDeleteMessage={deleteRuntimeEvent}
      onCreateNewSession={handleCreateNewSession}
      onPause={pauseWorkflow}
      onResume={resumeWorkflow}
      onInterruptTurn={interruptCurrentTurn}
      isPaused={executionState?.paused || false}
      isConnected={isConnected}
      onAgentClick={handleSelectAgent}
      inputCapability={chatInputCapability}
      debugSnapshotsEnabled={debugSnapshotsEnabled}
      onToggleDebugSnapshots={setDebugSnapshotsEnabled}
      debugSnapshots={debugSnapshots}
      onClearDebugSnapshots={clearDebugSnapshots}
      orchestratorRuntimeMode={orchestratorRuntimeMode}
    />
  ), [activeSessionId, executionState, chatAgents, runtimeEvents, contextEditableEventIds, agentRunStatus, runtimeOverview, toolPanelOverview, sendUserInput, editRuntimeEvent, deleteRuntimeEvent, handleCreateNewSession, pauseWorkflow, resumeWorkflow, interruptCurrentTurn, isConnected, handleSelectAgent, chatInputCapability, debugSnapshotsEnabled, setDebugSnapshotsEnabled, debugSnapshots, clearDebugSnapshots, orchestratorRuntimeMode]);

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
        leftSidebar={
          <LeftSidebar
            sessions={sessions}
            currentSession={currentSession}
            isLoadingSessions={isLoadingSessions}
            onCreateSession={createSession}
            onDeleteSession={removeSession}
            onRenameSession={renameSession}
            onSwitchSession={switchSession}
            onRefreshSessions={refreshSessions}
          />
        }
        canvas={canvasElement}
        rightPanel={rightPanelElement}
        bottomPanel={
          <BottomPanel
            agents={agentPanelAgents}
            instances={runtimeInstances}
            configs={agentConfigItems}
            startupTargets={startupTargets}
            startupTemplates={startupTemplates}
            orchestrationConfig={orchestrationConfig}
            debugMode={debugMode}
            selectedAgentId={selectedAgentId}
            currentSessionId={activeSessionId}
            focusedRuntimeInstanceId={sessionBinding.runtimeInstanceId ?? null}
            isLoading={isLoadingAgentPanel}
            error={agentPanelError}
            onSelectAgent={handleSelectAgent}
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
          />
        }
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
          setSelectedAgentId(null);
        }}
        onSwitchInstance={(instance) => { void handleSelectInstance(instance); }}
        onDeployConfig={handleDeployAgent}
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
