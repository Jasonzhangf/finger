import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { RuntimeEvent } from '../../api/types.js';

// Mock child components
vi.mock('../TaskFlowCanvas/TaskFlowCanvas.tsx', () => ({
  TaskFlowCanvas: () => <div data-testid="task-flow-canvas">Canvas</div>,
}));

vi.mock('../PerformanceCard/PerformanceCard.tsx', () => ({
  PerformanceCard: () => <div data-testid="performance-card">Performance</div>,
}));

vi.mock('../ChatInterface/ChatInterface.tsx', () => ({
  ChatInterface: ({ events }: { events: Array<{ id: string; role: string; content: string }> }) => (
    <div data-testid="chat-interface">
      Chat ({events?.length || 0} events)
    </div>
  ),
}));

vi.mock('../LeftSidebar/LeftSidebar.tsx', () => ({
  LeftSidebar: () => <div data-testid="left-sidebar">Sidebar</div>,
}));

vi.mock('../BottomPanel/BottomPanel.tsx', () => ({
  BottomPanel: () => <div data-testid="bottom-panel">Panel</div>,
}));

vi.mock('../SessionResumeDialog/SessionResumeDialog.tsx', () => ({
  SessionResumeDialog: ({ isOpen }: { isOpen: boolean }) => (
    isOpen ? <div data-testid="session-resume-dialog">Resume Dialog</div> : null
  ),
}));

vi.mock('../../hooks/useSessionResume.js', () => ({
  useSessionResume: () => ({
    checkForResumeableSession: vi.fn(),
  }),
}));

interface MockWorkflowExecution {
  executionState: null;
  runtimeEvents: RuntimeEvent[];
  userRounds: never[];
  executionRounds: never[];
  workflow: null;
  selectedAgentId: null;
  setSelectedAgentId: ReturnType<typeof vi.fn>;
  isLoading: boolean;
  error: string | null;
  startWorkflow: ReturnType<typeof vi.fn>;
  pauseWorkflow: ReturnType<typeof vi.fn>;
  resumeWorkflow: ReturnType<typeof vi.fn>;
  sendUserInput: ReturnType<typeof vi.fn>;
  getAgentDetail: ReturnType<typeof vi.fn>;
  getTaskReport: ReturnType<typeof vi.fn>;
  isConnected: boolean;
}

// Create a mutable mock for useWorkflowExecution
let mockWorkflowExecution: MockWorkflowExecution = {
  executionState: null,
  runtimeEvents: [],
  userRounds: [],
  executionRounds: [],
  workflow: null,
  selectedAgentId: null,
  setSelectedAgentId: vi.fn(),
  isLoading: false,
  error: null,
  startWorkflow: vi.fn(),
  pauseWorkflow: vi.fn(),
  resumeWorkflow: vi.fn(),
  sendUserInput: vi.fn(),
  getAgentDetail: vi.fn(),
  getTaskReport: vi.fn(),
  isConnected: true,
};

vi.mock('../../hooks/useWorkflowExecution.js', () => ({
  useWorkflowExecution: () => mockWorkflowExecution,
}));

vi.mock('../../hooks/useSessions.js', () => ({
  useSessions: () => ({
    sessions: [],
    currentSession: null,
    isLoading: false,
    error: null,
    create: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    switchSession: vi.fn(),
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

import { WorkflowContainer } from './WorkflowContainer.tsx';

describe('WorkflowContainer', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Reset mock state
    mockWorkflowExecution = {
      executionState: null,
      runtimeEvents: [],
      userRounds: [],
      executionRounds: [],
      workflow: null,
      selectedAgentId: null,
      setSelectedAgentId: vi.fn(),
      isLoading: false,
      error: null,
      startWorkflow: vi.fn(),
      pauseWorkflow: vi.fn(),
      resumeWorkflow: vi.fn(),
      sendUserInput: vi.fn(),
      getAgentDetail: vi.fn(),
      getTaskReport: vi.fn(),
      isConnected: true,
    };
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('should render main layout without hooks error', () => {
    render(<WorkflowContainer />);

    expect(screen.getByTestId('task-flow-canvas')).toBeTruthy();
    expect(screen.getByTestId('chat-interface')).toBeTruthy();
    expect(screen.getByTestId('left-sidebar')).toBeTruthy();
  });

  it('should show loading overlay without hooks error', async () => {
    (mockWorkflowExecution as unknown as Record<string, unknown>).isLoading = true;

    const { rerender } = render(<WorkflowContainer />);

    // Loading overlay should be visible
    expect(screen.getByText('加载中...')).toBeTruthy();
    // Main layout should still be in DOM (hooks consistency)
    expect(screen.getByTestId('chat-interface')).toBeTruthy();

    // Transition to normal state
    (mockWorkflowExecution as unknown as Record<string, unknown>).isLoading = false;

    rerender(<WorkflowContainer />);

    // Loading overlay should be gone
    expect(screen.queryByText('加载中...')).toBeNull();
    // Main layout still present
    expect(screen.getByTestId('chat-interface')).toBeTruthy();
  });

  it('should show error overlay without hooks error', async () => {
    (mockWorkflowExecution as unknown as Record<string, unknown>).error = 'Test error message';

    const { rerender } = render(<WorkflowContainer />);

    // Error overlay should be visible
    expect(screen.getByText('Error: Test error message')).toBeTruthy();
    // Main layout should still be in DOM (hooks consistency)
    expect(screen.getByTestId('chat-interface')).toBeTruthy();

    // Transition to normal state
    (mockWorkflowExecution as unknown as Record<string, unknown>).error = null;

    rerender(<WorkflowContainer />);

    // Error overlay should be gone
    expect(screen.queryByText('Error: Test error message')).toBeNull();
    // Main layout still present
    expect(screen.getByTestId('chat-interface')).toBeTruthy();
  });

  it('should handle loading -> normal -> error transitions without crashing', async () => {
    // Start with loading
    (mockWorkflowExecution as unknown as Record<string, unknown>).isLoading = true;

    const { rerender } = render(<WorkflowContainer />);
    expect(screen.getByText('加载中...')).toBeTruthy();

    // Transition to normal
    (mockWorkflowExecution as unknown as Record<string, unknown>).isLoading = false;

    rerender(<WorkflowContainer />);
    expect(screen.queryByText('加载中...')).toBeNull();
    expect(screen.getByTestId('chat-interface')).toBeTruthy();

    // Transition to error
    (mockWorkflowExecution as unknown as Record<string, unknown>).error = 'Something went wrong';

    rerender(<WorkflowContainer />);
    expect(screen.getByText('Error: Something went wrong')).toBeTruthy();
    expect(screen.getByTestId('chat-interface')).toBeTruthy();

    // Back to normal
    (mockWorkflowExecution as unknown as Record<string, unknown>).error = null;

    rerender(<WorkflowContainer />);
    expect(screen.queryByText('Error: Something went wrong')).toBeNull();
    expect(screen.getByTestId('chat-interface')).toBeTruthy();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const hookErrorCalls = (consoleErrorSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('Rendered fewer hooks than expected')
    );
    expect(hookErrorCalls.length).toBe(0);
  });

  it('should display events from useWorkflowExecution', async () => {
    (mockWorkflowExecution as unknown as Record<string, unknown>).runtimeEvents = [
      { id: '1', role: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00Z', kind: 'status' },
      { id: '2', role: 'agent', content: 'Hi there', timestamp: '2024-01-01T00:00:01Z', kind: 'thought', agentId: 'agent-1', agentName: 'Agent 1' },
    ];

    render(<WorkflowContainer />);

    // ChatInterface should receive the events
    expect(screen.getByText('Chat (2 events)')).toBeTruthy();
  });

  it('should maintain hook consistency when isLoading and error change rapidly', async () => {
    const { rerender } = render(<WorkflowContainer />);

    // Rapid state changes should not cause hooks errors
    for (let i = 0; i < 5; i++) {
      (mockWorkflowExecution as unknown as Record<string, unknown>).isLoading = true;
      rerender(<WorkflowContainer />);

      (mockWorkflowExecution as unknown as Record<string, unknown>).isLoading = false;
      (mockWorkflowExecution as unknown as Record<string, unknown>).error = `Error ${i}`;
      rerender(<WorkflowContainer />);

      (mockWorkflowExecution as unknown as Record<string, unknown>).error = null;
      rerender(<WorkflowContainer />);
    }

    // If we get here without React errors, hooks are consistent
    expect(screen.getByTestId('chat-interface')).toBeTruthy();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const hookErrorCalls = (consoleErrorSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('Rendered fewer hooks than expected')
    );
    expect(hookErrorCalls.length).toBe(0);
  });
});
