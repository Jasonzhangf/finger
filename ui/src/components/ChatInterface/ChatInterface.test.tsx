import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatInterface } from './ChatInterface.js';
import type { RuntimeEvent } from '../../api/types.js';

function buildEvent(partial: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: partial.id || `evt-${Math.random().toString(36).slice(2, 8)}`,
    role: partial.role || 'user',
    content: partial.content || 'test message',
    timestamp: partial.timestamp || new Date().toISOString(),
    ...partial,
  };
}

describe('ChatInterface context menu', () => {
  it('shows context menu and can insert message content into draft', async () => {
    const onSendMessage = vi.fn<(payload: unknown) => void>();
    const events: RuntimeEvent[] = [
      buildEvent({ role: 'user', content: '历史消息内容' }),
    ];

    render(
      <ChatInterface
        executionState={null}
        agents={[]}
        events={events}
        onSendMessage={onSendMessage}
        onPause={() => undefined}
        onResume={() => undefined}
        isPaused={false}
        isConnected={true}
      />,
    );

    fireEvent.contextMenu(screen.getByText('历史消息内容'));
    fireEvent.click(screen.getByRole('button', { name: '插入输入框' }));

    await waitFor(() => {
      const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
      expect(input.value).toContain('历史消息内容');
    });

    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it('supports resend from context menu', async () => {
    const onSendMessage = vi.fn<(payload: unknown) => void>();
    const events: RuntimeEvent[] = [
      buildEvent({ role: 'user', content: '需要重发' }),
    ];

    render(
      <ChatInterface
        executionState={null}
        agents={[]}
        events={events}
        onSendMessage={onSendMessage}
        onPause={() => undefined}
        onResume={() => undefined}
        isPaused={false}
        isConnected={true}
      />,
    );

    fireEvent.contextMenu(screen.getByText('需要重发'));
    fireEvent.click(screen.getByRole('button', { name: '重发消息' }));

    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledTimes(1);
    });

    expect(onSendMessage).toHaveBeenCalledWith({ text: '需要重发' });
  });
});

describe('ChatInterface input behavior', () => {
  it('sends on Enter and keeps newline on Shift+Enter', async () => {
    const onSendMessage = vi.fn<(payload: unknown) => void>();

    render(
      <ChatInterface
        executionState={null}
        agents={[]}
        events={[]}
        onSendMessage={onSendMessage}
        onPause={() => undefined}
        onResume={() => undefined}
        isPaused={false}
        isConnected={true}
      />,
    );

    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: 'line-1' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.change(input, { target: { value: 'line-1\nline-2' } });
    expect(input.value).toBe('line-1\nline-2');
    expect(onSendMessage).toHaveBeenCalledTimes(0);

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledTimes(1);
    });

    expect(onSendMessage).toHaveBeenCalledWith({ text: 'line-1\nline-2' });
  });

  it('cycles input history with ArrowUp/ArrowDown when textarea is empty', async () => {
    const onSendMessage = vi.fn<(payload: unknown) => void>();

    render(
      <ChatInterface
        executionState={null}
        agents={[]}
        events={[]}
        onSendMessage={onSendMessage}
        onPause={() => undefined}
        onResume={() => undefined}
        isPaused={false}
        isConnected={true}
      />,
    );

    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: 'first command' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    fireEvent.change(input, { target: { value: 'second command' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledTimes(2);
    });

    expect(input.value).toBe('');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() => {
      expect(input.value).toBe('second command');
    });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() => {
      expect(input.value).toBe('first command');
    });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(input.value).toBe('second command');
    });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(input.value).toBe('');
    });
  });
});

describe('ChatInterface tool render', () => {
  it('renders update_plan payload as plan list', () => {
    const onSendMessage = vi.fn<(payload: unknown) => void>();
    const events: RuntimeEvent[] = [
      buildEvent({
        role: 'agent',
        content: '工具完成：update_plan（2 个步骤）',
        planExplanation: '先保证回环稳定，再逐步开放工具',
        planSteps: [
          { step: '实现基础回环', status: 'completed' },
          { step: '接入工具回填', status: 'in_progress' },
        ],
      }),
    ];

    render(
      <ChatInterface
        executionState={null}
        agents={[]}
        events={events}
        onSendMessage={onSendMessage}
        onPause={() => undefined}
        onResume={() => undefined}
        isPaused={false}
        isConnected={true}
      />,
    );

    expect(screen.getByText('计划清单')).not.toBeNull();
    expect(screen.getByText('实现基础回环')).not.toBeNull();
    expect(screen.getByText('接入工具回填')).not.toBeNull();
    expect(screen.getByText('进行中')).not.toBeNull();
  });
});
