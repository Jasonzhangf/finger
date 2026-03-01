import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const useWorkflowExecutionMock = vi.fn();

const runtimePanelState = {
  agents: [
    {
      id: 'executor-debug-loop',
      name: 'Executor Debug Loop',
      type: 'executor' as const,
      status: 'running' as const,
      source: 'deployment' as const,
      instanceCount: 1,
      deployedCount: 1,
      availableCount: 0,
      runningCount: 1,
      queuedCount: 0,
      enabled: true,
      runtimeCapabilities: [],
      defaultQuota: 1,
      quotaPolicy: { workflowQuota: {} },
      quota: { effective: 1, source: 'default' as const },
      debugAssertions: [],
    },
  ],
  instances: [
    {
      id: 'inst-1',
      agentId: 'executor-debug-loop',
      name: 'inst-1',
      type: 'executor' as const,
      status: 'running' as 'running' | 'completed' | 'idle',
      sessionId: 'runtime-session',
      totalDeployments: 1,
    },
  ],
  configs: [],
  startupTargets: [],
  startupTemplates: [],
  orchestrationConfig: null,
  debugAssertions: [],
  debugMode: true,
  isLoading: false,
  error: null,
  refresh: vi.fn(),
  setDebugMode: vi.fn().mockResolvedValue({ ok: true, enabled: true }),
  startTemplate: vi.fn().mockResolvedValue({ ok: true }),
  saveOrchestrationConfig: vi.fn().mockResolvedValue({ ok: true }),
  switchOrchestrationProfile: vi.fn().mockResolvedValue({ ok: true }),
  controlAgent: vi.fn().mockResolvedValue({ ok: true, status: 'completed' }),
};

const switchSessionMock = vi.fn().mockResolvedValue(undefined);
const setSelectedAgentIdMock = vi.fn();

vi.mock('../TaskFlowCanvas/TaskFlowCanvas.tsx', () => ({
  TaskFlowCanvas: () => <div data-testid="canvas" />,
}));

vi.mock('../PerformanceCard/PerformanceCard.tsx', () => ({
  PerformanceCard: () => <div data-testid="perf" />,
}));

vi.mock('../ChatInterface/ChatInterface.tsx', () => ({
  ChatInterface: () => <div data-testid="chat">chat</div>,
}));

vi.mock('../LeftSidebar/LeftSidebar.tsx', () => ({
  LeftSidebar: () => <div data-testid="sidebar">sidebar</div>,
}));

vi.mock('../BottomPanel/BottomPanel.tsx', () => ({
  BottomPanel: ({
    instances,
    onSelectInstance,
    onSelectAgent,
  }: {
    instances: Array<{ id: string }>;
    onSelectInstance?: (instance: { id: string }) => void;
    onSelectAgent?: (agentId: string) => void;
  }) => (
    <>
      <button type="button" data-testid="switch-runtime" onClick={() => onSelectInstance?.(instances[0])}>
        switch
      </button>
      <button type="button" data-testid="select-orchestrator" onClick={() => onSelectAgent?.('finger-orchestrator')}>
        select orchestrator
      </button>
    </>
  ),
}));

vi.mock('../AgentConfigDrawer/AgentConfigDrawer.tsx', () => ({
  AgentConfigDrawer: () => null,
}));

vi.mock('../SessionResumeDialog/SessionResumeDialog.tsx', () => ({
  SessionResumeDialog: () => null,
}));

vi.mock('../../hooks/useSessionResume.js', () => ({
  useSessionResume: () => ({
    checkForResumeableSession: vi.fn(),
  }),
}));

vi.mock('../../hooks/useSessions.js', () => ({
  useSessions: () => ({
    sessions: [{ id: 'orch-session', name: 'orch', projectPath: '/', createdAt: '', updatedAt: '', lastAccessedAt: '', messageCount: 0, activeWorkflows: [] }],
    currentSession: { id: 'orch-session', name: 'orch', projectPath: '/' },
    isLoading: false,
    error: null,
    create: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    switchSession: switchSessionMock,
  }),
}));

vi.mock('../../hooks/useAgents.js', () => ({
  useAgents: () => ({
    agents: [],
    isLoading: false,
    refresh: vi.fn(),
    getAgentById: vi.fn(),
  }),
}));

vi.mock('../../hooks/useAgentRuntimePanel.js', () => ({
  useAgentRuntimePanel: () => runtimePanelState,
}));

vi.mock('../../hooks/useWorkflowExecution.js', () => ({
  useWorkflowExecution: (sessionId: string) => {
    useWorkflowExecutionMock(sessionId);
    return {
      executionState: null,
      runtimeEvents: [],
      selectedAgentId: null,
      setSelectedAgentId: setSelectedAgentIdMock,
      isLoading: false,
      error: null,
      pauseWorkflow: vi.fn(),
      resumeWorkflow: vi.fn(),
      interruptCurrentTurn: vi.fn(),
      sendUserInput: vi.fn(),
      editRuntimeEvent: vi.fn(),
      deleteRuntimeEvent: vi.fn(),
      agentRunStatus: { phase: 'idle', text: 'idle', updatedAt: '' },
      runtimeOverview: { ledgerFocusMaxChars: 20_000, compactCount: 0, updatedAt: '' },
      toolPanelOverview: { availableTools: [], exposedTools: [] },
      updateToolExposure: vi.fn().mockResolvedValue(true),
      contextEditableEventIds: [],
      isConnected: true,
    };
  },
}));

import { WorkflowContainer } from './WorkflowContainer.tsx';

describe('WorkflowContainer session binding', () => {
  beforeEach(() => {
    useWorkflowExecutionMock.mockClear();
    switchSessionMock.mockClear();
    setSelectedAgentIdMock.mockClear();
    runtimePanelState.instances = [
      {
        id: 'inst-1',
        agentId: 'executor-debug-loop',
        name: 'inst-1',
        type: 'executor',
        status: 'running',
        sessionId: 'runtime-session',
        totalDeployments: 1,
      },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('switches to runtime session and auto-returns to orchestrator when runtime finishes', async () => {
    const { rerender } = render(<WorkflowContainer />);

    expect(useWorkflowExecutionMock).toHaveBeenCalledWith('orch-session');

    fireEvent.click(screen.getByTestId('switch-runtime'));
    await waitFor(() => {
      expect(useWorkflowExecutionMock).toHaveBeenLastCalledWith('runtime-session');
    });

    runtimePanelState.instances = [{ ...runtimePanelState.instances[0], status: 'completed' }];
    rerender(<WorkflowContainer />);

    await waitFor(() => {
      expect(useWorkflowExecutionMock).toHaveBeenLastCalledWith('orch-session');
    });
  });

  it('keeps runtime session focus when runtime is idle', async () => {
    const { rerender } = render(<WorkflowContainer />);

    fireEvent.click(screen.getByTestId('switch-runtime'));
    await waitFor(() => {
      expect(useWorkflowExecutionMock).toHaveBeenLastCalledWith('runtime-session');
    });

    runtimePanelState.instances = [{ ...runtimePanelState.instances[0], status: 'idle' }];
    rerender(<WorkflowContainer />);

    await waitFor(() => {
      expect(useWorkflowExecutionMock).toHaveBeenLastCalledWith('runtime-session');
    });
  });

  it('returns to orchestrator context when selecting orchestrator agent', async () => {
    render(<WorkflowContainer />);

    fireEvent.click(screen.getByTestId('switch-runtime'));
    await waitFor(() => {
      expect(useWorkflowExecutionMock).toHaveBeenLastCalledWith('runtime-session');
    });

    fireEvent.click(screen.getByTestId('select-orchestrator'));

    await waitFor(() => {
      expect(useWorkflowExecutionMock).toHaveBeenLastCalledWith('orch-session');
    });
  });
});
