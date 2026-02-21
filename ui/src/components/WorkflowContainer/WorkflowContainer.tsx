import React, { useMemo } from 'react';
import { OrchestrationCanvas } from '../OrchestrationCanvas/OrchestrationCanvas.js';
import { ChatInterface } from '../ChatInterface/ChatInterface.js';
import { AppLayout } from '../layout/AppLayout.js';
import { LeftSidebar } from '../LeftSidebar/LeftSidebar.js';
import { BottomPanel } from '../BottomPanel/BottomPanel.js';
import { useWorkflowExecution } from '../../hooks/useWorkflowExecution.js';
import { useAgents } from '../../hooks/useAgents.js';
import { useSessions } from '../../hooks/useSessions.js';
import type { UserInputPayload } from '../../api/types.js';

export const WorkflowContainer: React.FC = () => {
  const { currentSession, sessions } = useSessions();
  const sessionId = currentSession?.id || (sessions.length > 0 ? sessions[0].id : 'default-session');
  const [inspectSignal, setInspectSignal] = React.useState(0);
  const [inspectAgentId, setInspectAgentId] = React.useState<string | null>(null);

 const {
   executionState,
   runtimeEvents,
   userRounds,
   executionRounds,
   selectedAgentId,
   setSelectedAgentId,
   isLoading,
   error,
   pauseWorkflow,
   resumeWorkflow,
   sendUserInput,
   getAgentDetail,
   getTaskReport,
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

  const handleSendMessage = React.useCallback(async (payload: UserInputPayload) => {
    await sendUserInput(payload);
  }, [sendUserInput]);

  const handleInspectAgent = React.useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
    setInspectAgentId(agentId);
    setInspectSignal((value) => value + 1);
  }, [setSelectedAgentId]);

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', width: '100vw', background: '#0e1217', color: '#9ca3af' }}>
        <div>
          <div style={{ fontSize: '24px', marginBottom: '16px' }}>⏳</div>
          <div>Loading workflow runtime...</div>
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

  const canvasElement = useMemo(() => (
    <OrchestrationCanvas
      executionState={executionState}
      agents={runtimeAgents}
      userRounds={userRounds}
      executionRounds={executionRounds}
      onDeployAgent={async () => {}}
      getAgentDetail={getAgentDetail}
      getTaskReport={getTaskReport}
      selectedAgentId={selectedAgentId}
      inspectRequest={inspectAgentId ? { agentId: inspectAgentId, signal: inspectSignal } : null}
    />
  ), [executionState, runtimeAgents, userRounds, executionRounds, getAgentDetail, getTaskReport, selectedAgentId, inspectAgentId, inspectSignal]);

  const rightPanelElement = useMemo(() => (
    <ChatInterface
      executionState={executionState}
      agents={runtimeAgents}
      events={runtimeEvents}
      onSendMessage={handleSendMessage}
      onPause={pauseWorkflow}
      onResume={resumeWorkflow}
      isPaused={executionState?.paused || false}
      isConnected={isConnected}
      onAgentClick={handleInspectAgent}
    />
  ), [executionState, runtimeAgents, runtimeEvents, handleSendMessage, pauseWorkflow, resumeWorkflow, isConnected, handleInspectAgent]);

  return (
    <AppLayout
      leftSidebar={<LeftSidebar />}
      canvas={canvasElement}
      rightPanel={rightPanelElement}
      bottomPanel={<BottomPanel />}
    />
  );
};
