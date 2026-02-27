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
import type { Loop } from '../TaskFlowCanvas/types.js';
import { findConfigForAgent, matchInstanceToAgent } from '../BottomPanel/agentRuntimeUtils.js';
import type { AgentConfig, AgentRuntime } from '../../api/types.js';

interface ResumeCheckResult {
  sessionId: string;
  timestamp: string;
  originalTask: string;
  progress: number;
}

const CHAT_GATEWAY_ID = 'chat-codex-gateway';
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
  } = useSessions();
  const { checkForResumeableSession } = useSessionResume();
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [resumeTarget, setResumeTarget] = useState<ResumeCheckResult | null>(null);

  const sessionId = currentSession?.id || (sessions.length > 0 ? sessions[0].id : 'default-session');

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
    if (sessionId && sessionId !== 'default-session') {
      localStorage.setItem('finger-last-session-id', sessionId);
    }
  }, [sessionId]);

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
  } = useWorkflowExecution(sessionId);
  const {
    agents: agentPanelAgents,
    instances: runtimeInstances,
    configs: agentConfigItems,
    isLoading: isLoadingAgentPanel,
    error: agentPanelError,
    refresh: refreshAgentPanel,
    controlAgent,
  } = useAgentRuntimePanel();
  const [drawerAgentId, setDrawerAgentId] = useState<string | null>(null);
  const effectiveDrawerAgentId = drawerAgentId ?? selectedAgentId ?? null;

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
  const runtimeAgents = React.useMemo(() => {
    const merged = new Map<string, AgentRuntime>();

    for (const agent of agentPanelAgents) {
      merged.set(agent.id, {
        id: agent.id,
        name: agent.name,
        type: agent.type,
        status: agent.status,
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
    () => runtimeAgents.find((agent) => agent.id === effectiveDrawerAgentId) ?? null,
    [effectiveDrawerAgentId, runtimeAgents],
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

  const handleSelectInstance = useCallback(async (instanceIdOrPayload: string | { sessionId?: string }): Promise<void> => {
    const sessionIdToSwitch = typeof instanceIdOrPayload === 'string'
      ? runtimeInstances.find((item) => item.id === instanceIdOrPayload)?.sessionId
      : instanceIdOrPayload.sessionId;
    if (!sessionIdToSwitch) return;
    await switchSession(sessionIdToSwitch);
  }, [runtimeInstances, switchSession]);

  const handleDeployAgent = useCallback(async (payload: { config: AgentConfig; instanceCount: number }): Promise<void> => {
    const targetSessionId = currentSession?.id || sessionId;
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
  }, [currentSession?.id, refreshAgentPanel, sessionId]);

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

  const taskFlowProps = React.useMemo(() => {
    const planHistory: Loop[] = [];
    const designHistory: Loop[] = [];
    const executionHistory: Loop[] = [];
    const queue: Loop[] = [];

    return {
      epicId: executionState?.workflowId || 'new-workflow',
      planHistory,
      designHistory,
      executionHistory,
      runningLoop: undefined,
      queue,
    };
  }, [executionState?.workflowId]);

  const canvasElement = useMemo(() => (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <TaskFlowCanvas
        epicId={taskFlowProps.epicId}
        planHistory={taskFlowProps.planHistory}
        designHistory={taskFlowProps.designHistory}
        executionHistory={taskFlowProps.executionHistory}
        runningLoop={taskFlowProps.runningLoop}
        queue={taskFlowProps.queue}
      />
      <PerformanceCard />
    </div>
  ), [taskFlowProps]);

  const rightPanelElement = useMemo(() => (
    <ChatInterface
      key={sessionId}
      executionState={executionState}
      agents={runtimeAgents}
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
    />
  ), [sessionId, executionState, runtimeAgents, runtimeEvents, contextEditableEventIds, agentRunStatus, runtimeOverview, toolPanelOverview, sendUserInput, editRuntimeEvent, deleteRuntimeEvent, handleCreateNewSession, pauseWorkflow, resumeWorkflow, interruptCurrentTurn, isConnected, handleSelectAgent, chatInputCapability]);

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
          />
        }
        canvas={canvasElement}
        rightPanel={rightPanelElement}
        bottomPanel={
          <BottomPanel
            agents={runtimeAgents}
            instances={runtimeInstances}
            configs={agentConfigItems}
            selectedAgentId={selectedAgentId}
            currentSessionId={currentSession?.id ?? null}
            isLoading={isLoadingAgentPanel}
            error={agentPanelError}
            onSelectAgent={handleSelectAgent}
            onSelectInstance={(instance) => { void handleSelectInstance(instance); }}
            onRefresh={() => { void refreshAgentPanel(); }}
          />
        }
      />
      <AgentConfigDrawer
        isOpen={selectedDrawerAgent !== null}
        agent={selectedDrawerAgent}
        capabilities={selectedDrawerCapabilities}
        config={selectedDrawerConfig}
        instances={selectedDrawerInstances}
        currentSessionId={currentSession?.id ?? null}
        onClose={() => setDrawerAgentId(null)}
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
