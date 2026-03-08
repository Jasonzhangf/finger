import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AgentRuntimePanelAgent } from '../../hooks/useAgentRuntimePanel.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const useWorkflowExecutionMock = vi.fn();

const runtimePanelState: {
  configAgents: AgentRuntimePanelAgent[];
  runtimeAgents: AgentRuntimePanelAgent[];
  catalogAgents: never[];
  instances: Array<{
    id: string;
    agentId: string;
    name: string;
    type: 'executor';
    status: 'running' | 'completed' | 'idle';
    sessionId: string;
    totalDeployments: number;
  }>;
  configs: never[];
  startupTargets: never[];
  startupTemplates: never[];
  orchestrationConfig: null;
  debugAssertions: never[];
  debugMode: boolean;
  isLoading: boolean;
  error: null;
  refresh: ReturnType<typeof vi.fn>;
  setDebugMode: ReturnType<typeof vi.fn>;
  startTemplate: ReturnType<typeof vi.fn>;
  saveOrchestrationConfig: ReturnType<typeof vi.fn>;
  switchOrchestrationProfile: ReturnType<typeof vi.fn>;
  controlAgent: ReturnType<typeof vi.fn>;
} = {
  configAgents: [
    {
      id: 'executor-debug-loop',
      name: 'Executor Debug Loop',
      type: 'executor' as const,
      status: 'running' as const,
      source: 'agent-json' as const,
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
  runtimeAgents: [
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
  catalogAgents: [],
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
const switchRuntimeSessionMock = vi.fn();

vi.mock('../TaskFlowCanvas/TaskFlowCanvas.tsx', () => ({
  TaskFlowCanvas: () => <div data-testid="canvas" />,
}));

vi.mock('../PerformanceCard/PerformanceCard.tsx', () => ({
  PerformanceCard: () => <div data-testid="perf" />,
}));

vi.mock('../ChatInterface/ChatInterface.tsx', () => ({
  ChatInterface: ({ panelTitle, contextLabel }: { panelTitle?: string; contextLabel?: string }) => (
    <div data-testid="chat">
      <div data-testid="chat-panel-title">{panelTitle}</div>
      <div data-testid="chat-context-label">{contextLabel}</div>
    </div>
  ),
}));

vi.mock('../LeftSidebar/LeftSidebar.tsx', () => ({
  LeftSidebar: ({ runtimeInstances, onSwitchRuntimeInstance }: { runtimeInstances?: Array<{ id: string }>; onSwitchRuntimeInstance?: (instance: { id: string }) => void }) => (
    <>
      <div data-testid="sidebar">sidebar</div>
      <button type="button" data-testid="sidebar-switch-runtime" onClick={() => {
        if (runtimeInstances && runtimeInstances[0]) {
          switchRuntimeSessionMock();
          onSwitchRuntimeInstance?.(runtimeInstances[0]);
        }
      }}>
        sidebar-switch
      </button>
    </>
  ),
}));

vi.mock('../BottomPanel/BottomPanel.tsx', () => ({
  BottomPanel: ({
    instances,
    onSelectInstance,
    onSelectAgentConfig,
  }: {
    instances: Array<{ id: string }>;
    onSelectInstance?: (instance: { id: string }) => void;
    onSelectAgentConfig?: (agentId: string) => void;
  }) => (
    <>
      <button type="button" data-testid="switch-runtime" onClick={() => onSelectInstance?.(instances[0])}>
        switch
      </button>
      <button type="button" data-testid="select-orchestrator" onClick={() => onSelectAgentConfig?.('finger-orchestrator')}>
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
    switchRuntimeSessionMock.mockClear();
    fetchMock.mockReset();
    runtimePanelState.configAgents = [
      {
        id: 'executor-debug-loop',
        name: 'Executor Debug Loop',
        type: 'executor',
        status: 'running',
        source: 'agent-json',
        instanceCount: 1,
        deployedCount: 1,
        availableCount: 0,
        runningCount: 1,
        queuedCount: 0,
        enabled: true,
        runtimeCapabilities: [],
        defaultQuota: 1,
        quotaPolicy: { workflowQuota: {} },
        quota: { effective: 1, source: 'default' },
        debugAssertions: [],
      },
    ];
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
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  it('keeps runtime session focused after runtime finishes so history remains inspectable', async () => {
    const { rerender } = render(<WorkflowContainer />);

    expect(useWorkflowExecutionMock).toHaveBeenCalledWith('orch-session');

    fireEvent.click(screen.getByTestId('switch-runtime'));
    await waitFor(() => {
      expect(useWorkflowExecutionMock).toHaveBeenLastCalledWith('runtime-session');
    });

    runtimePanelState.instances = [{ ...runtimePanelState.instances[0], status: 'completed' }];
    rerender(<WorkflowContainer />);

    await waitFor(() => {
      expect(useWorkflowExecutionMock).toHaveBeenLastCalledWith('runtime-session');
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

  it('does not switch session when selecting orchestrator config', async () => {
    render(<WorkflowContainer />);

    fireEvent.click(screen.getByTestId('switch-runtime'));
    await waitFor(() => {
      expect(useWorkflowExecutionMock).toHaveBeenLastCalledWith('runtime-session');
    });

    fireEvent.click(screen.getByTestId('select-orchestrator'));

    await waitFor(() => {
      expect(useWorkflowExecutionMock).toHaveBeenLastCalledWith('runtime-session');
    });
  });

  it('uses bound runtime session agent for panel title and context', async () => {
    render(<WorkflowContainer />);

    fireEvent.click(screen.getByTestId('switch-runtime'));

    await waitFor(() => {
      expect(useWorkflowExecutionMock).toHaveBeenLastCalledWith('runtime-session');
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-panel-title').textContent).toBe('Executor Debug Loop');
      expect(screen.getByTestId('chat-context-label').textContent).toContain('子会话');
      expect(screen.getByTestId('chat-context-label').textContent).toContain('agent Executor Debug Loop (executor-debug-loop)');
      expect(screen.getByTestId('chat-context-label').textContent).toContain('session runtime-session');
    });
  });

  it('keeps completed runtime session title/context after execution completes', async () => {
    const { rerender } = render(<WorkflowContainer />);

    fireEvent.click(screen.getByTestId('switch-runtime'));

    await waitFor(() => {
      expect(useWorkflowExecutionMock).toHaveBeenLastCalledWith('runtime-session');
    });

    runtimePanelState.instances = [{ ...runtimePanelState.instances[0], status: 'completed' }];
    rerender(<WorkflowContainer />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-panel-title').textContent).toBe('Executor Debug Loop');
      expect(screen.getByTestId('chat-context-label').textContent).toContain('子会话');
      expect(screen.getByTestId('chat-context-label').textContent).toContain('session runtime-session');
    });
  });

  it('sidebar runtime history selection also switches to the correct runtime session', async () => {
    render(<WorkflowContainer />);

    fireEvent.click(screen.getByTestId('sidebar-switch-runtime'));

    await waitFor(() => {
      expect(switchRuntimeSessionMock).toHaveBeenCalledTimes(1);
      expect(useWorkflowExecutionMock).toHaveBeenLastCalledWith('runtime-session');
      expect(screen.getByTestId('chat-panel-title').textContent).toBe('Executor Debug Loop');
    });
  });

  it('uses orchestrator configured display name for panel title in main session', async () => {
    runtimePanelState.configAgents = [
      ...runtimePanelState.configAgents,
      {
        id: 'finger-orchestrator',
        name: 'Orchestrator',
        type: 'orchestrator',
        status: 'idle',
        source: 'agent-json',
        instanceCount: 0,
        deployedCount: 0,
        availableCount: 0,
        runningCount: 0,
        queuedCount: 0,
        enabled: true,
        runtimeCapabilities: [],
        defaultQuota: 1,
        quotaPolicy: { workflowQuota: {} },
        quota: { effective: 1, source: 'default' },
        debugAssertions: [],
      },
    ];

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/v1/sessions/orch-session')) {
        return {
          ok: true,
          json: async () => ({ ownerAgentId: 'finger-orchestrator' }),
        };
      }
      if (url.includes('/messages')) {
        return {
          ok: true,
          json: async () => ({ success: true, messages: [] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    render(<WorkflowContainer />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-panel-title').textContent).toBe('Orchestrator');
      expect(screen.getByTestId('chat-context-label').textContent).toContain('主会话');
      expect(screen.getByTestId('chat-context-label').textContent).toContain('agent Orchestrator (finger-orchestrator)');
    });
  });

});
