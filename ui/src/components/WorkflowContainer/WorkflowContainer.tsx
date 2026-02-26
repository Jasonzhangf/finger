import React, { useMemo, useEffect, useState } from 'react';
import { PerformanceCard } from '../PerformanceCard/PerformanceCard.js';
import { ChatInterface } from '../ChatInterface/ChatInterface.js';
import type { InputCapability } from '../ChatInterface/ChatInterface.js';
import { AppLayout } from '../layout/AppLayout.js';
import { LeftSidebar } from '../LeftSidebar/LeftSidebar.js';
import { BottomPanel } from '../BottomPanel/BottomPanel.js';
import { SessionResumeDialog } from '../SessionResumeDialog/SessionResumeDialog.js';
import { useSessionResume } from '../../hooks/useSessionResume.js';
import { useSessions } from '../../hooks/useSessions.js';
import { useWorkflowExecution } from '../../hooks/useWorkflowExecution.js';
import { useAgents } from '../../hooks/useAgents.js';
import { TaskFlowCanvas } from '../TaskFlowCanvas/TaskFlowCanvas.js';
import type { Loop } from '../TaskFlowCanvas/types.js';

interface ResumeCheckResult {
  sessionId: string;
  timestamp: string;
  originalTask: string;
  progress: number;
}

const CHAT_GATEWAY_ID = 'chat-codex-gateway';

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
    isLoading,
    error,
    pauseWorkflow,
    resumeWorkflow,
    sendUserInput,
    isConnected,
  } = useWorkflowExecution(sessionId);

  const { agents: agentModules } = useAgents();
  const chatInputCapability = useMemo(
    () => resolveChatInputCapability(agentModules),
    [agentModules],
  );

  // All hooks must be called before any conditional returns
  const runtimeAgents = React.useMemo(() => {
    if (executionState?.agents && executionState.agents.length > 0) {
      return executionState.agents;
    }
    return agentModules.map((module) => ({
      id: module.id,
      name: module.name,
      type: ((module.metadata?.type as string) || 'executor') as 'executor' | 'reviewer' | 'orchestrator',
      status: (module.status || 'idle') as 'idle' | 'running' | 'error' | 'paused',
      load: module.load || 0,
      errorRate: module.errorRate || 0,
      requestCount: 0,
      tokenUsage: 0,
    }));
  }, [executionState?.agents, agentModules]);

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
      executionState={executionState}
      agents={runtimeAgents}
      events={runtimeEvents}
      onSendMessage={sendUserInput}
      onPause={pauseWorkflow}
      onResume={resumeWorkflow}
      isPaused={executionState?.paused || false}
      isConnected={isConnected}
      inputCapability={chatInputCapability}
    />
  ), [executionState, runtimeAgents, runtimeEvents, sendUserInput, pauseWorkflow, resumeWorkflow, isConnected, chatInputCapability]);

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
        bottomPanel={<BottomPanel />}
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
