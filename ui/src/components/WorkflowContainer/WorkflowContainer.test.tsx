import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Mock child components
vi.mock('../OrchestrationCanvas/OrchestrationCanvas.tsx', () => ({
  OrchestrationCanvas: () => <div data-testid="orchestration-canvas">Canvas</div>,
}));

vi.mock('../ChatInterface/ChatInterface.tsx', () => ({
  ChatInterface: () => <div data-testid="chat-interface">Chat</div>,
}));

vi.mock('../RightPanel/RightPanel.tsx', () => ({
  RightPanel: () => <div data-testid="right-panel">Panel</div>,
}));

vi.mock('../LeftSidebar/LeftSidebar.tsx', () => ({
  LeftSidebar: () => <div data-testid="left-sidebar">Sidebar</div>,
}));

vi.mock('../../hooks/useWorkflowExecution.js', () => ({
  useWorkflowExecution: () => ({
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
  }),
}));

vi.mock('../../hooks/useSessions.js', () => ({
  useSessions: () => ({
    sessions: [],
    currentSession: null,
    isLoading: false,
    createSession: vi.fn(),
    selectSession: vi.fn(),
    deleteSession: vi.fn(),
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

vi.mock('../../hooks/useResourcePool.js', () => ({
  useResourcePool: () => ({
    resources: [],
    isLoading: false,
    refresh: vi.fn(),
    allocate: vi.fn(),
    release: vi.fn(),
  }),
}));

import { WorkflowContainer } from './WorkflowContainer.tsx';

describe('WorkflowContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render main layout', () => {
    render(<WorkflowContainer />);

    waitFor(() => {
      expect(screen.getByTestId('orchestration-canvas')).toBeInTheDocument();
      expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
      expect(screen.getByTestId('left-sidebar')).toBeInTheDocument();
    });
  });
});
