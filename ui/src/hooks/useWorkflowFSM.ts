/**
 * useWorkflowFSM - Hook for consuming FSM states
 * 
 * Features:
 * - Subscribe to WebSocket FSM state updates
 * - Poll state snapshots via API
 * - Apply state masks for display
 * - Convert FSM states to simplified status
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  WorkflowFSMState,
  TaskFSMState,
  AgentFSMState,
  StateMaskConfig,
  StateSnapshot,
} from '../api/types.js';
import {
  mapWorkflowFSMToStatus,
  mapTaskFSMToStatus,
  mapAgentFSMToStatus,
  applyStateMask,
  DEFAULT_STATE_MASK,
} from '../api/types.js';
import { getWebSocket } from '../api/websocket.js';

export interface FSMWorkflowState {
  workflowId: string;
  sessionId: string;
  fsmState: WorkflowFSMState;
  simplifiedStatus: 'planning' | 'executing' | 'completed' | 'failed' | 'paused';
  visibleState: WorkflowFSMState | null; // After mask
}

export interface FSMTaskState {
  id: string;
  fsmState: TaskFSMState;
  simplifiedStatus: string;
  visibleState: TaskFSMState | null; // After mask
  assignee?: string;
}

export interface FSMAgentState {
  id: string;
  fsmState: AgentFSMState;
  simplifiedStatus: string;
  visibleState: AgentFSMState | null; // After mask
}

export interface UseWorkflowFSMReturn {
  workflow: FSMWorkflowState | null;
  tasks: FSMTaskState[];
  agents: FSMAgentState[];
  isLoading: boolean;
  error: string | null;
  isConnected: boolean;
  setMaskConfig: (config: StateMaskConfig) => void;
  toggleDetailedMode: () => void;
}

export function useWorkflowFSM(
  workflowId: string,
  sessionId: string
): UseWorkflowFSMReturn {
  const [workflow, setWorkflow] = useState<FSMWorkflowState | null>(null);
  const [tasks, setTasks] = useState<FSMTaskState[]>([]);
  const [agents, setAgents] = useState<FSMAgentState[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [maskConfig, setMaskConfig] = useState<StateMaskConfig>(DEFAULT_STATE_MASK);
  
  const wsRef = useRef(getWebSocket());
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Apply state mask to workflow state
  const applyWorkflowMask = useCallback((fsmState: WorkflowFSMState): WorkflowFSMState | null => {
    return applyStateMask(fsmState, maskConfig, 'workflow') as WorkflowFSMState | null;
  }, [maskConfig]);

  // Apply state mask to task state
  const applyTaskMask = useCallback((fsmState: TaskFSMState): TaskFSMState | null => {
    return applyStateMask(fsmState, maskConfig, 'task') as TaskFSMState | null;
  }, [maskConfig]);

  // Apply state mask to agent state
  const applyAgentMask = useCallback((fsmState: AgentFSMState): AgentFSMState | null => {
    return applyStateMask(fsmState, maskConfig, 'agent') as AgentFSMState | null;
  }, [maskConfig]);

  // Load state snapshot from API
  const loadStateSnapshot = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/workflows/${workflowId}/state`);
      if (!res.ok) {
        if (res.status === 404) {
          // State not found, not an error
          return;
        }
        throw new Error(`Failed to load state: ${res.statusText}`);
      }

      const snapshot: StateSnapshot = await res.json();
      
      // Convert to FSM states
      setWorkflow({
        workflowId: snapshot.workflowId,
        sessionId: snapshot.sessionId,
        fsmState: snapshot.fsmState,
        simplifiedStatus: snapshot.simplifiedStatus,
        visibleState: applyWorkflowMask(snapshot.fsmState),
      });

      setTasks(snapshot.tasks.map(task => ({
        id: task.id,
        fsmState: task.fsmState,
        simplifiedStatus: task.simplifiedStatus,
        visibleState: applyTaskMask(task.fsmState),
        assignee: task.assignee,
      })));

      setAgents(snapshot.agents.map(agent => ({
        id: agent.id,
        fsmState: agent.fsmState,
        simplifiedStatus: agent.simplifiedStatus,
        visibleState: applyAgentMask(agent.fsmState),
      })));

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load state');
    } finally {
      setIsLoading(false);
    }
  }, [workflowId, applyWorkflowMask, applyTaskMask, applyAgentMask]);

  // Handle WebSocket messages
  const handleWebSocketMessage = useCallback((msg: any) => {
    if (msg.type === 'workflow_update' && msg.payload?.workflowId === workflowId) {
      const payload = msg.payload as {
        fsmState?: WorkflowFSMState;
        status?: string;
      };

      if (payload.fsmState) {
        setWorkflow(prev => {
          if (!prev) return null;
          return {
            ...prev,
            fsmState: payload.fsmState!,
            simplifiedStatus: mapWorkflowFSMToStatus(payload.fsmState!),
            visibleState: applyWorkflowMask(payload.fsmState!),
          };
        });
      }
    }

    if (msg.type === 'task_update' && msg.payload?.workflowId === workflowId) {
      const payload = msg.payload as {
        taskId?: string;
        fsmState?: TaskFSMState;
        status?: string;
      };

      if (payload.taskId) {
        setTasks(prev => {
          const existing = prev.find(t => t.id === payload.taskId);
          if (existing && payload.fsmState) {
            return prev.map(t => 
              t.id === payload.taskId
                ? {
                    ...t,
                    fsmState: payload.fsmState!,
                    simplifiedStatus: mapTaskFSMToStatus(payload.fsmState!),
                    visibleState: applyTaskMask(payload.fsmState!),
                  }
                : t
            );
          }
          return prev;
        });
      }
    }

    if (msg.type === 'agent_update' && msg.payload?.agentId) {
      const payload = msg.payload as {
        agentId: string;
        fsmState?: AgentFSMState;
        status?: string;
      };

      setAgents(prev => {
        const existing = prev.find(a => a.id === payload.agentId);
        if (existing && payload.fsmState) {
          return prev.map(a =>
            a.id === payload.agentId
              ? {
                  ...a,
                  fsmState: payload.fsmState!,
                  simplifiedStatus: mapAgentFSMToStatus(payload.fsmState!),
                  visibleState: applyAgentMask(payload.fsmState!),
                }
              : a
          );
        }
        return prev;
      });
    }
  }, [workflowId, applyWorkflowMask, applyTaskMask, applyAgentMask]);

  // Initialize WebSocket and polling
  useEffect(() => {
    const ws = wsRef.current;

    // Connect WebSocket
    ws.connect().then(() => {
      setIsConnected(true);
    }).catch(() => {
      setIsConnected(false);
    });

    // Subscribe to messages
    const unsubscribe = ws.onMessage(handleWebSocketMessage);

    // Initial load
    loadStateSnapshot();

    // Poll for updates (every 3 seconds)
    pollIntervalRef.current = setInterval(loadStateSnapshot, 3000);

    return () => {
      unsubscribe();
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [handleWebSocketMessage, loadStateSnapshot]);

  // Toggle detailed mode (show all states)
  const toggleDetailedMode = useCallback(() => {
    setMaskConfig(prev => {
      const newConfig: StateMaskConfig = {
        ...prev,
        showDetailedStates: !prev.showDetailedStates,
        workflowStates: {
          hide: prev.showDetailedStates ? DEFAULT_STATE_MASK.workflowStates.hide : [],
          showAs: {},
        },
        taskStates: {
          hide: prev.showDetailedStates ? DEFAULT_STATE_MASK.taskStates.hide : [],
          showAs: {},
        },
        agentStates: {
          hide: prev.showDetailedStates ? DEFAULT_STATE_MASK.agentStates.hide : [],
          showAs: {},
        },
      };
      return newConfig;
    });
  }, []);

  return {
    workflow,
    tasks,
    agents,
    isLoading,
    error,
    isConnected,
    setMaskConfig,
    toggleDetailedMode,
  };
}
