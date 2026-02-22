import React, { useMemo } from 'react';
import { ChatInterface } from '../ChatInterface/ChatInterface.js';
import { AppLayout } from '../layout/AppLayout.js';
import { LeftSidebar } from '../LeftSidebar/LeftSidebar.js';
import { BottomPanel } from '../BottomPanel/BottomPanel.js';
import { useWorkflowExecution } from '../../hooks/useWorkflowExecution.js';
import { useAgents } from '../../hooks/useAgents.js';
import { useSessions } from '../../hooks/useSessions.js';
import { TaskFlowCanvas } from '../TaskFlowCanvas/TaskFlowCanvas.js';
import type { Loop } from '../TaskFlowCanvas/types.js';

export const WorkflowContainer: React.FC = () => {
  const { currentSession, sessions } = useSessions();
  const sessionId = currentSession?.id || (sessions.length > 0 ? sessions[0].id : 'default-session');

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
    <TaskFlowCanvas
      epicId={taskFlowProps.epicId}
      planHistory={taskFlowProps.planHistory}
      designHistory={taskFlowProps.designHistory}
      executionHistory={taskFlowProps.executionHistory}
      runningLoop={taskFlowProps.runningLoop}
      queue={taskFlowProps.queue}
    />
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
    <AppLayout
      leftSidebar={<LeftSidebar />}
      canvas={canvasElement}
      rightPanel={rightPanelElement}
      bottomPanel={<BottomPanel />}
    />
  );
};
