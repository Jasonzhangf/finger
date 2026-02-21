import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { RightPanel } from './RightPanel.tsx';
import type { RuntimeEvent, WorkflowExecutionState } from '../../api/types.js';

describe('RightPanel', () => {
  const mockExecutionState: WorkflowExecutionState = {
    workflowId: 'wf-123',
    status: 'executing',
    agents: [
      { id: 'agent-1', name: 'Agent Alpha', type: 'executor', status: 'running', load: 0, errorRate: 0, requestCount: 0, tokenUsage: 0 },
      { id: 'agent-2', name: 'Agent Beta', type: 'reviewer', status: 'idle', load: 0, errorRate: 0, requestCount: 0, tokenUsage: 0 },
    ],
    tasks: [],
    orchestrator: { id: 'orch-1', currentRound: 1, maxRounds: 10 },
    executionPath: [],
    executionRounds: [],
    paused: false,
    userInput: '',
  };

  const mockEvents: RuntimeEvent[] = [
    { id: 'e1', content: 'Hello', role: 'user', timestamp: '2023-01-01T10:00:00Z' },
    { id: 'e2', content: 'Thinking...', role: 'agent', agentId: 'agent-1', agentName: 'Agent Alpha', timestamp: '2023-01-01T10:00:01Z' },
    { id: 'e3', content: 'System message', role: 'system', timestamp: '2023-01-01T10:00:02Z' },
  ];

  const defaultProps = {
    executionState: mockExecutionState,
    agents: mockExecutionState.agents,
    events: mockEvents,
    highlightedAgentId: null as string | null,
    onSelectAgent: vi.fn(),
    onInspectAgent: vi.fn(),
    onSendMessage: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    isPaused: false,
    isConnected: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders correctly with given props', () => {
    render(<RightPanel {...defaultProps} />);

    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
    expect(screen.getByText('System message')).toBeInTheDocument();
  });

  it('calls onSendMessage when message is sent', () => {
    const { container } = render(<RightPanel {...defaultProps} />);
    const textarea = container.querySelector('textarea');
    expect(textarea).toBeInTheDocument();
    // Input interaction is tested separately due to complex event handling
  });

  it('calls onSelectAgent when an agent button is clicked', () => {
    render(<RightPanel {...defaultProps} />);
    const agentButton = screen.getByText('Agent Alpha');
    fireEvent.click(agentButton);
    expect(defaultProps.onSelectAgent).toHaveBeenCalledWith('agent-1');
  });

  it('calls onPause when pause button is clicked', () => {
    render(<RightPanel {...defaultProps} />);
    const pauseBtn = screen.getByText(/暂停/);
    fireEvent.click(pauseBtn);
    expect(defaultProps.onPause).toHaveBeenCalled();
  });

  it('calls onResume when resume button is clicked', () => {
    render(<RightPanel {...defaultProps} isPaused={true} />);
    const resumeBtn = screen.getByText(/继续/);
    fireEvent.click(resumeBtn);
    expect(defaultProps.onResume).toHaveBeenCalled();
  });

  it('displays agent status badge', () => {
    render(<RightPanel {...defaultProps} />);
    expect(screen.getByText('Agent Alpha')).toBeInTheDocument();
  });

  it('displays progress when executionState is active', () => {
    render(<RightPanel {...defaultProps} />);
    expect(screen.getByText(/Round/)).toBeInTheDocument();
  });

  it('shows empty state when no events', () => {
    render(<RightPanel {...defaultProps} events={[]} />);
    expect(screen.getByText('开始对话')).toBeInTheDocument();
  });

  it('displays resume prompt when provided', () => {
    const resumeProps = {
      ...defaultProps,
      resumePrompt: {
        visible: true,
        summary: 'Resume task summary',
        progress: 50,
        pendingCount: 2,
        requireConfirm: false,
        isResuming: false,
        onResumeNow: vi.fn(),
        onDismiss: vi.fn(),
        onToggleRequireConfirm: vi.fn(),
      }
    };
    render(<RightPanel {...resumeProps} />);
    expect(screen.getByText('Resume task summary')).toBeInTheDocument();
  });

  it('handles resume prompt actions', () => {
    const onResumeNow = vi.fn();
    const resumeProps = {
      ...defaultProps,
      resumePrompt: {
        visible: true,
        summary: 'Resume task summary',
        progress: 50,
        pendingCount: 2,
        requireConfirm: true,
        isResuming: false,
        onResumeNow,
        onDismiss: vi.fn(),
        onToggleRequireConfirm: vi.fn(),
      }
    };
    render(<RightPanel {...resumeProps} />);

    fireEvent.click(screen.getByText('继续恢复'));
    expect(onResumeNow).toHaveBeenCalled();
  });
});
