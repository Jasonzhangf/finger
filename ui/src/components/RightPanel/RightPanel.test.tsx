import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import RightPanel from './RightPanel.tsx';
import type { RuntimeEvent, WorkflowExecutionState } from '../../api/types.js';

// Mock the React.memoized MessageItem to simplify testing
vi.mock('./RightPanel.tsx', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // MessageItem: vi.fn(({ event, isSelected, agentStatus, onAgentClick }) => (
    //   <div data-testid="message-item" className={\`message \${event.role}\`}>
    //     <span data-testid="event-content">{event.content}</span>
    //     {event.agentId && <button data-testid="agent-button" onClick={() => onAgentClick(event.agentId)}>{event.agentName || event.agentId}</button>}
    //     {agentStatus && <span data-testid="agent-status">{agentStatus}</span>}
    //     {isSelected && <span data-testid="selected-indicator">Selected</span>}
    //   </div>
    // )),
  };
});


describe('RightPanel', () => {
  const mockExecutionState: WorkflowExecutionState = {
    workflowId: 'wf-123',
    sessionId: 'sess-456',
    status: 'executing',
    agents: [
      { id: 'agent-1', name: 'Agent Alpha', status: 'running', type: 'executor', capabilities: [] },
      { id: 'agent-2', name: 'Agent Beta', status: 'idle', type: 'reviewer', capabilities: [] },
    ],
    tasks: [],
    history: [],
    lastUpdatedAt: Date.now(),
    summary: 'Mock workflow summary',
  };

  const mockEvents: RuntimeEvent[] = [
    { type: 'user_message', content: 'Hello', role: 'user', timestamp: '2023-01-01T10:00:00Z', roundId: 'r1' },
    { type: 'agent_thought', content: 'Thinking...', role: 'agent', agentId: 'agent-1', agentName: 'Agent Alpha', timestamp: '2023-01-01T10:00:01Z', roundId: 'r1' },
    { type: 'system_log', content: 'System message', role: 'system', timestamp: '2023-01-01T10:00:02Z', roundId: 'r1' },
  ];

  const defaultProps = {
    executionState: mockExecutionState,
    agents: mockExecutionState.agents,
    events: mockEvents,
    highlightedAgentId: null,
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

    expect(screen.getByText('Current Execution')).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
    expect(screen.getByText('System message')).toBeInTheDocument();
  });

  it('calls onSendMessage when message is sent', () => {
    render(<RightPanel {...defaultProps} />);
    const input = screen.getByPlaceholderText('Type your message...');
    fireEvent.change(input, { target: { value: 'New message' } });
    fireEvent.click(screen.getByText('Send'));
    expect(defaultProps.onSendMessage).toHaveBeenCalledWith({ content: 'New message', images: [] });
  });

  it('calls onSelectAgent when an agent message is clicked', () => {
    render(<RightPanel {...defaultProps} />);
    const agentMessage = screen.getByText('Thinking...');
    fireEvent.click(agentMessage); // Clicking content should trigger selection
    expect(defaultProps.onSelectAgent).toHaveBeenCalledWith('agent-1');
  });

  it('calls onPause when pause button is clicked', () => {
    render(<RightPanel {...defaultProps} />);
    fireEvent.click(screen.getByText('Pause'));
    expect(defaultProps.onPause).toHaveBeenCalled();
  });

  it('calls onResume when resume button is clicked', () => {
    render(<RightPanel {...defaultProps} isPaused={true} />);
    fireEvent.click(screen.getByText('Resume'));
    expect(defaultProps.onResume).toHaveBeenCalled();
  });

  it('displays agent status badge', () => {
    render(<RightPanel {...defaultProps} />);
    expect(screen.getByText('Agent Alpha')).toBeInTheDocument();
  });

  it('handles message input and send button state', () => {
    render(<RightPanel {...defaultProps} />);
    const input = screen.getByPlaceholderText('Type your message...');
    const sendButton = screen.getByText('Send');

    expect(sendButton).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Test' } });
    expect(sendButton).not.toBeDisabled();
    fireEvent.change(input, { target: { value: '' } });
    expect(sendButton).toBeDisabled();
  });

  it('disables input and send when not connected', () => {
    render(<RightPanel {...defaultProps} isConnected={false} />);
    const input = screen.getByPlaceholderText('Type your message...');
    const sendButton = screen.getByText('Send');

    expect(input).toBeDisabled();
    expect(sendButton).toBeDisabled();
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
        onResumeNow: vi.fn(),
        onDismiss: vi.fn(),
        onToggleRequireConfirm: vi.fn(),
      }
    };
    render(<RightPanel {...resumeProps} />);
    expect(screen.getByText('Resume task summary')).toBeInTheDocument();
    expect(screen.getByText('Progress: 50%')).toBeInTheDocument();
  });

  it('handles resume prompt actions', () => {
    const resumeProps = {
      ...defaultProps,
      resumePrompt: {
        visible: true,
        summary: 'Resume task summary',
        progress: 50,
        pendingCount: 2,
        requireConfirm: true,
        onResumeNow: vi.fn(),
        onDismiss: vi.fn(),
        onToggleRequireConfirm: vi.fn(),
      }
    };
    render(<RightPanel {...resumeProps} />);

    fireEvent.click(screen.getByLabelText('Require confirmation to continue'));
    expect(resumeProps.resumePrompt.onToggleRequireConfirm).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByText('Resume Now'));
    expect(resumeProps.resumePrompt.onResumeNow).toHaveBeenCalled();
  });

});
