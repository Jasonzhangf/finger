import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import ChatInterface from './ChatInterface.tsx';
import type { RuntimeEvent, UserInputPayload } from '../../api/types.js';

describe('ChatInterface', () => {
  const mockEvents: RuntimeEvent[] = [
    { type: 'user_message', content: 'User message 1', role: 'user', timestamp: '2023-01-01T10:00:00Z', roundId: 'r1' },
    { type: 'agent_thought', content: 'Agent thought 1', role: 'agent', agentId: 'agent-alpha', agentName: 'Agent Alpha', timestamp: '2023-01-01T10:00:01Z', roundId: 'r1' },
    { type: 'system_log', content: 'System log 1', role: 'system', timestamp: '2023-01-01T10:00:02Z', roundId: 'r1' },
  ];

  const mockAgents = [
    { id: 'agent-alpha', name: 'Agent Alpha', status: 'running', type: 'executor', capabilities: [] },
  ];

  const defaultProps = {
    events: mockEvents,
    agents: mockAgents,
    highlightedAgentId: null,
    onSelectAgent: vi.fn(),
    onSendMessage: vi.fn(),
    isConnected: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders messages correctly', () => {
    render(<ChatInterface {...defaultProps} />);

    expect(screen.getByText('User message 1')).toBeInTheDocument();
    expect(screen.getByText('Agent thought 1')).toBeInTheDocument();
    expect(screen.getByText('System log 1')).toBeInTheDocument();
  });

  it('calls onSendMessage when message is sent', () => {
    render(<ChatInterface {...defaultProps} />);
    const input = screen.getByPlaceholderText('Type your message...');
    const sendButton = screen.getByText('Send');

    fireEvent.change(input, { target: { value: 'New test message' } });
    fireEvent.click(sendButton);

    expect(defaultProps.onSendMessage).toHaveBeenCalledWith({ content: 'New test message', images: [] });
    expect(input).toHaveValue(''); // Input should be cleared
  });

  it('disables input and send button when not connected', () => {
    render(<ChatInterface {...defaultProps} isConnected={false} />);

    const input = screen.getByPlaceholderText('Type your message...');
    const sendButton = screen.getByText('Send');

    expect(input).toBeDisabled();
    expect(sendButton).toBeDisabled();
  });

  it('enables send button when input is not empty', () => {
    render(<ChatInterface {...defaultProps} />);
    const input = screen.getByPlaceholderText('Type your message...');
    const sendButton = screen.getByText('Send');

    expect(sendButton).toBeDisabled();

    fireEvent.change(input, { target: { value: 'Something' } });
    expect(sendButton).not.toBeDisabled();

    fireEvent.change(input, { target: { value: '' } });
    expect(sendButton).toBeDisabled();
  });

  it('calls onSelectAgent when an agent message button is clicked', () => {
    render(<ChatInterface {...defaultProps} />);
    const agentButton = screen.getByRole('button', { name: 'Agent Alpha' });
    fireEvent.click(agentButton);
    expect(defaultProps.onSelectAgent).toHaveBeenCalledWith('agent-alpha');
  });

  it('highlights agent messages when highlightedAgentId matches', () => {
    const { rerender } = render(<ChatInterface {...defaultProps} highlightedAgentId="agent-alpha" />);

    const agentMessage = screen.getByText('Agent thought 1').closest('.message');
    expect(agentMessage).toHaveClass('selected');

    rerender(<ChatInterface {...defaultProps} highlightedAgentId="agent-beta" />);
    expect(agentMessage).not.toHaveClass('selected');
  });

  it('does not render image preview when no files are selected', () => {
    render(<ChatInterface {...defaultProps} />);
    expect(screen.queryByAltText('Preview')).not.toBeInTheDocument();
  });

  it('renders image preview when files are selected', () => {
    render(<ChatInterface {...defaultProps} />);
    const file = new File(['dummy content'], 'test.png', { type: 'image/png' });
    const input = screen.getByLabelText('Upload image'); // Assuming you have a label for the file input
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByAltText('Preview')).toBeInTheDocument();
  });

  it('removes image preview when clear button is clicked', () => {
    render(<ChatInterface {...defaultProps} />);
    const file = new File(['dummy content'], 'test.png', { type: 'image/png' });
    const input = screen.getByLabelText('Upload image');
    fireEvent.change(input, { target: { files: [file] } });

    expect(screen.getByAltText('Preview')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Clear selected image'));
    expect(screen.queryByAltText('Preview')).not.toBeInTheDocument();
  });
});
