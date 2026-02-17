import React from 'react';
import { OrchestrationCanvas } from '../OrchestrationCanvas/OrchestrationCanvas.js';
import { RightPanel } from '../RightPanel/RightPanel.js';
import { AppLayout } from '../layout/AppLayout.js';
import { LeftSidebar } from '../LeftSidebar/LeftSidebar.js';
import { BottomPanel } from '../BottomPanel/BottomPanel.js';
import { useWorkflowExecution } from '../../hooks/useWorkflowExecution.js';
import { useAgents } from '../../hooks/useAgents.js';
import { useSessions } from '../../hooks/useSessions.js';
import type { UserInputPayload } from '../../api/types.js';

export const WorkflowContainer: React.FC = () => {
  const { currentSession } = useSessions();
  const sessionId = currentSession?.id || 'default-session';
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

  const handleSendMessage = async (payload: UserInputPayload) => {
    await sendUserInput(payload);
  };

  const handleInspectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setInspectAgentId(agentId);
    setInspectSignal((value) => value + 1);
  };

  const handleDeployAgent = async (config: unknown) => {
    await fetch('/api/v1/agents/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        config,
        scope: 'session',
      }),
    });
  };

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#9ca3af' }}>
        Loading workflow runtime...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#ef4444' }}>
        Error: {error}
      </div>
    );
  }

  return (
    <AppLayout
      leftSidebar={<LeftSidebar />}
      canvas={
        <OrchestrationCanvas
          executionState={executionState}
          agents={runtimeAgents}
          userRounds={userRounds}
          executionRounds={executionRounds}
          onDeployAgent={handleDeployAgent}
          getAgentDetail={getAgentDetail}
          getTaskReport={getTaskReport}
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
          inspectRequest={inspectAgentId ? { agentId: inspectAgentId, signal: inspectSignal } : null}
        />
      }
      rightPanel={
        <RightPanel
          executionState={executionState}
          agents={runtimeAgents}
          events={runtimeEvents}
          highlightedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
          onInspectAgent={handleInspectAgent}
          onSendMessage={handleSendMessage}
          onPause={pauseWorkflow}
          onResume={resumeWorkflow}
          isPaused={executionState?.paused || false}
          isConnected={isConnected}
       />
     }
      bottomPanel={<BottomPanel />}
    />
  );
};
