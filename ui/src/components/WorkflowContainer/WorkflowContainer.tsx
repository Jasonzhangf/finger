import React, { useMemo } from 'react';
import { useEffect, useState } from 'react';
import { PerformanceCard } from '../PerformanceCard/PerformanceCard.js';
import { ChatInterface } from '../ChatInterface/ChatInterface.js';
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

export const WorkflowContainer: React.FC = () => {
  const { currentSession, sessions } = useSessions();
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

  const runtimeAgents = React.useMemo(() => {
    return executionState?.agents ||
      agentModules.map((module) => ({
        id: module.id,
        name: module.name,
        type: ((module.metadata?.type as string) || 'executor') as 'executor' | 'reviewer' | 'orchestrator',
        status: (module.status || 'idle') as 'idle' | 'running' | 'error' | 'paused',
        load: module.load || 0,
        errorRate: module.errorRate || 0,
        requestCount: 0,
        tokenUsage: 0,
      }));
  }, [executionState, agentModules]);

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', width: '100vw', background: '#0e1217', color: '#9ca3af' }}>
        <div>
          <div style={{ fontSize: '24px', marginBottom: '16px' }}>⏳</div>
          <div>加载中...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', width: '100vw', background: '#0e1217', color: '#ef4444' }}>
        <div>
          <div style={{ fontSize: '24px', marginBottom: '16px' }}>❌</div>
          <div>Error: {error}</div>
        </div>
      </div>
    );
  }

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
    />
  ), [executionState, runtimeAgents, runtimeEvents, sendUserInput, pauseWorkflow, resumeWorkflow, isConnected]);

  return (
    <>
      <AppLayout
        leftSidebar={<LeftSidebar />}
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
