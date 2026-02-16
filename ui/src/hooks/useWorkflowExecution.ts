import { useState, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from './useWebSocket.js';
import type {
  WorkflowExecutionState,
  WorkflowInfo,
  AgentExecutionDetail,
  WsMessage,
  WorkflowUpdatePayload,
  AgentUpdatePayload,
  TaskReport,
} from '../api/types.js';

interface UseWorkflowExecutionReturn {
  workflow: WorkflowInfo | null;
  executionState: WorkflowExecutionState | null;
  isLoading: boolean;
  error: string | null;
  startWorkflow: (userTask: string) => Promise<void>;
  pauseWorkflow: () => Promise<void>;
  resumeWorkflow: () => Promise<void>;
  sendUserInput: (input: string) => Promise<void>;
  getAgentDetail: (agentId: string) => AgentExecutionDetail | null;
  getTaskReport: () => TaskReport | null;
  isConnected: boolean;
}

export function useWorkflowExecution(sessionId: string): UseWorkflowExecutionReturn {
  const [workflow, setWorkflow] = useState<WorkflowInfo | null>(null);
  const [executionState, setExecutionState] = useState<WorkflowExecutionState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const executionStateRef = useRef<WorkflowExecutionState | null>(null);
  
  useEffect(() => {
    executionStateRef.current = executionState;
  }, [executionState]);

  const handleWebSocketMessage = useCallback((msg: WsMessage) => {
    switch (msg.type) {
      case 'workflow_update': {
        const payload = msg.payload as WorkflowUpdatePayload;
        setExecutionState((prev) => {
          if (!prev || prev.workflowId !== payload.workflowId) return prev;
          return {
            ...prev,
            status: payload.status,
            orchestrator: payload.orchestratorState
              ? {
                  ...prev.orchestrator,
                  currentRound: payload.orchestratorState.round,
                  thought: payload.orchestratorState.thought,
                }
              : prev.orchestrator,
            tasks: payload.taskUpdates || prev.tasks,
            agents: payload.agentUpdates || prev.agents,
            executionPath: payload.executionPath || prev.executionPath,
          };
        });
        break;
      }
      
      case 'agent_update': {
        const payload = msg.payload as AgentUpdatePayload;
        setExecutionState((prev) => {
          if (!prev) return prev;
          const updatedAgents = prev.agents.map((agent) =>
            agent.id === payload.agentId
              ? { ...agent, status: payload.status, currentTaskId: payload.currentTaskId, load: payload.load }
              : agent
          );
          return { ...prev, agents: updatedAgents };
        });
        break;
      }
    }
  }, []);

  const { isConnected } = useWebSocket(handleWebSocketMessage);

  const startWorkflow = useCallback(async (userTask: string) => {
    setIsLoading(true);
    setError(null);
    
    try {
      const res = await fetch('/api/v1/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'orchestrator-loop',
          message: { content: userTask, sessionId },
          blocking: false,
        }),
      });
      
      if (!res.ok) throw new Error(`Failed to start workflow: ${res.status}`);
      
      const data = await res.json();
      if (data.success && data.result) {
        setWorkflow(data.result);
        setExecutionState({
          workflowId: data.result.epicId || data.result.workflowId,
          status: 'planning',
          orchestrator: {
            id: 'orchestrator-loop',
            currentRound: 0,
            maxRounds: 10,
          },
          agents: [],
          tasks: [],
          executionPath: [],
          paused: false,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start workflow');
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  const pauseWorkflow = useCallback(async () => {
    if (!executionState) return;
    
    try {
      await fetch('/api/v1/workflow/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: executionState.workflowId,
          hard: true,
        }),
      });
      
      setExecutionState((prev) => prev ? { ...prev, paused: true, status: 'paused' } : prev);
    } catch (e) {
      console.error('Failed to pause workflow:', e);
    }
  }, [executionState]);

  const resumeWorkflow = useCallback(async () => {
    if (!executionState) return;
    
    try {
      await fetch('/api/v1/workflow/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: executionState.workflowId,
        }),
      });
      
      setExecutionState((prev) => prev ? { ...prev, paused: false, status: 'executing' } : prev);
    } catch (e) {
      console.error('Failed to resume workflow:', e);
    }
  }, [executionState]);

  const sendUserInput = useCallback(async (input: string) => {
    if (!executionState) return;
    
    try {
      await fetch('/api/v1/workflow/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: executionState.workflowId,
          input,
        }),
      });
      
      setExecutionState((prev) => prev ? { ...prev, userInput: input } : prev);
    } catch (e) {
      console.error('Failed to send user input:', e);
    }
  }, [executionState]);

  const getAgentDetail = useCallback((agentId: string): AgentExecutionDetail | null => {
    const agent = executionState?.agents.find((a) => a.id === agentId);
    if (!agent) return null;
    
    return {
      agentId,
      agentName: agent.name,
      status: agent.status,
      currentRound: agent.currentTaskId ? 1 : 0,
      totalRounds: 5,
      steps: [],
      startTime: new Date().toISOString(),
    };
  }, [executionState]);

  const getTaskReport = useCallback((): TaskReport | null => {
    if (!workflow || !executionState) return null;
    
    const completedTasks = executionState.tasks.filter((t) => t.status === 'completed');
    const failedTasks = executionState.tasks.filter((t) => t.status === 'failed');
    
    return {
      workflowId: executionState.workflowId,
      epicId: workflow.epicId,
      userTask: workflow.userTask,
      status: executionState.status,
      summary: {
        totalTasks: executionState.tasks.length,
        completed: completedTasks.length,
        failed: failedTasks.length,
        success: failedTasks.length === 0 && completedTasks.length === executionState.tasks.length,
        rounds: executionState.orchestrator.currentRound,
        duration: 0,
      },
      taskDetails: executionState.tasks.map((t) => ({
        taskId: t.id,
        description: t.description,
        status: t.status,
        assignee: t.assignee,
        output: t.result?.output,
        error: t.result?.error,
      })),
      createdAt: workflow.createdAt,
      completedAt: executionState.status === 'completed' || executionState.status === 'failed'
        ? new Date().toISOString()
        : undefined,
    };
  }, [workflow, executionState]);

  return {
    workflow,
    executionState,
    isLoading,
    error,
    startWorkflow,
    pauseWorkflow,
    resumeWorkflow,
    sendUserInput,
    getAgentDetail,
    getTaskReport,
    isConnected: isConnected(),
  };
}
