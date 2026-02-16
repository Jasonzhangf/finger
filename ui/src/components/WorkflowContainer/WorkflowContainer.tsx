import React from 'react';
import { OrchestrationCanvas } from '../OrchestrationCanvas/OrchestrationCanvas.js';
import { RightPanel } from '../RightPanel/RightPanel.js';
import { AppLayout } from '../layout/AppLayout.js';
import { LeftSidebar } from '../LeftSidebar/LeftSidebar.js';
import { BottomPanel } from '../BottomPanel/BottomPanel.js';
import { useWorkflowExecution } from '../../hooks/useWorkflowExecution.js';
import { useAgents } from '../../hooks/useAgents.js';
import { useSessions } from '../../hooks/useSessions.js';

export const WorkflowContainer: React.FC = () => {
  const { currentSession } = useSessions();
  const sessionId = currentSession?.id || 'default-session';
  
  const {
    executionState,
    isLoading,
    error,
    startWorkflow,
    pauseWorkflow,
    resumeWorkflow,
    sendUserInput,
    getAgentDetail,
    getTaskReport,
    isConnected,
  } = useWorkflowExecution(sessionId);

  const { agents: agentModules } = useAgents();
  
  // Convert agent modules to runtime agents
  const runtimeAgents = React.useMemo(() => {
    return executionState?.agents || agentModules.map((module) => ({
      id: module.id,
      name: module.name,
      type: (module.metadata?.type as any) || 'executor',
      status: (module.status || 'idle') as any,
      load: module.load || 0,
      errorRate: module.errorRate || 0,
      requestCount: 0,
      tokenUsage: 0,
    }));
  }, [executionState, agentModules]);

  const handleSendMessage = async (message: string) => {
    if (!executionState) {
      await startWorkflow(message);
    } else {
      await sendUserInput(message);
    }
  };

  const handleDeployAgent = async (config: any) => {
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

  const canvas = (
    <OrchestrationCanvas
      executionState={executionState}
      agents={runtimeAgents}
      onDeployAgent={handleDeployAgent}
      getAgentDetail={getAgentDetail}
      getTaskReport={getTaskReport}
    />
  );

  const rightPanel = (
    <RightPanel
      executionState={executionState}
      agents={runtimeAgents}
      onSendMessage={handleSendMessage}
      onPause={pauseWorkflow}
      onResume={resumeWorkflow}
      isPaused={executionState?.paused || false}
      isConnected={isConnected}
    />
  );

  if (isLoading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        color: '#9ca3af',
      }}>
        Loading workflow runtime...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        color: '#ef4444',
      }}>
        Error: {error}
      </div>
    );
  }

  return (
    <AppLayout
      leftSidebar={<LeftSidebar />}
      canvas={canvas}
      rightPanel={rightPanel}
      bottomPanel={<BottomPanel />}
    />
  );
};
