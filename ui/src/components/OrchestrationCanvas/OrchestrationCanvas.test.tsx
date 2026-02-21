import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

// Mock ReactFlow
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="react-flow">{children}</div>
  ),
  Background: () => <div data-testid="background" />,
  BackgroundVariant: { Dots: 'dots', Lines: 'lines' },
  Controls: () => <div data-testid="controls" />,
  MiniMap: () => <div data-testid="minimap" />,
  useNodesState: () => [[], vi.fn()],
  useEdgesState: () => [[], vi.fn()],
  addEdge: vi.fn(),
  MarkerType: { ArrowClosed: 'arrowClosed' },
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

// Mock all child components
vi.mock('../TaskReport/TaskReport.tsx', () => ({
  __esModule: true,
  TaskReport: () => <div data-testid="task-report" />,
}));

vi.mock('../ExecutionModal/ExecutionModal.tsx', () => ({
  __esModule: true,
  ExecutionModal: () => <div data-testid="execution-modal" />,
}));

vi.mock('../AgentConfigPanel/AgentConfigPanel.tsx', () => ({
  __esModule: true,
  AgentConfigPanel: () => <div data-testid="agent-config-panel" />,
}));

vi.mock('../ResourcePoolPanel/ResourcePoolPanel.tsx', () => ({
  __esModule: true,
  ResourcePoolPanel: () => <div data-testid="resource-pool-panel" />,
}));

// Mock useResourcePool hook
vi.mock('../../hooks/useResourcePool.js', () => ({
  useResourcePool: () => ({
    resources: [],
    availableResources: [],
    deployedResources: [],
    refreshResources: vi.fn(),
    deployResource: vi.fn(),
    releaseResource: vi.fn(),
  }),
}));

// Import after mocks
import { OrchestrationCanvas } from './OrchestrationCanvas.tsx';
import type { WorkflowExecutionState } from '../../api/types.js';

describe('OrchestrationCanvas', () => {
  const mockExecutionState: WorkflowExecutionState = {
    workflowId: 'wf-1',
    sessionId: 'session-1',
    status: 'executing',
    agents: [
      { id: 'agent-1', name: 'Agent 1', status: 'running', type: 'executor', load: 50 },
    ],
    tasks: [
      { id: 'task-1', description: 'Task 1', status: 'in_progress', assignee: 'agent-1' },
    ],
    orchestrator: { id: 'orch-1', currentRound: 1, maxRounds: 10 },
    executionPath: [],
    executionRounds: [],
    paused: false,
    userInput: '',
  };

  const defaultProps = {
    executionState: mockExecutionState,
    agents: mockExecutionState.agents,
    selectedAgentId: null,
    onSelectAgent: vi.fn(),
    onInspectAgent: vi.fn(),
    onDeployAgent: vi.fn(),
    getAgentDetail: vi.fn(() => null),
    getTaskReport: vi.fn(() => null),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render canvas container', () => {
    render(<OrchestrationCanvas {...defaultProps} />);
    expect(screen.getByTestId('react-flow')).toBeInTheDocument();
  });

  it('should render with agents', () => {
    render(<OrchestrationCanvas {...defaultProps} />);
    expect(screen.getByTestId('react-flow')).toBeInTheDocument();
  });

  it('should render with no agents', () => {
    render(<OrchestrationCanvas {...defaultProps} agents={[]} />);
    expect(screen.getByTestId('react-flow')).toBeInTheDocument();
  });

  it('should render with selected agent', () => {
    render(<OrchestrationCanvas {...defaultProps} selectedAgentId="agent-1" />);
    expect(screen.getByTestId('react-flow')).toBeInTheDocument();
  });

  it('should render with paused state', () => {
    render(<OrchestrationCanvas {...defaultProps} executionState={{ ...mockExecutionState, paused: true }} />);
    expect(screen.getByTestId('react-flow')).toBeInTheDocument();
  });
});
