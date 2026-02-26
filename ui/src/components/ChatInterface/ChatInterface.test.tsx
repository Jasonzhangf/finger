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

  it('disables edit/delete for events outside context index window', async () => {
    const onSendMessage = vi.fn<(payload: unknown) => void>();
    const onEditMessage = vi.fn<(eventId: string, content: string) => Promise<boolean>>(async () => true);
    const onDeleteMessage = vi.fn<(eventId: string) => Promise<boolean>>(async () => true);
    const events: RuntimeEvent[] = [
      buildEvent({ id: 'old-event', role: 'user', content: '旧消息' }),
      buildEvent({ id: 'new-event', role: 'user', content: '新消息' }),
    ];

    render(
      <ChatInterface
        executionState={null}
        agents={[]}
        events={events}
        contextEditableEventIds={['new-event']}
        onSendMessage={onSendMessage}
        onEditMessage={onEditMessage}
        onDeleteMessage={onDeleteMessage}
        onPause={() => undefined}
        onResume={() => undefined}
        isPaused={false}
        isConnected={true}
      />,
    );

    fireEvent.contextMenu(screen.getByText('旧消息'));
    expect(screen.getByRole('button', { name: '编辑消息' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '删除消息' }).hasAttribute('disabled')).toBe(true);

    fireEvent.contextMenu(screen.getByText('新消息'));
    expect(screen.getByRole('button', { name: '编辑消息' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '删除消息' }));
    await waitFor(() => {
      expect(onDeleteMessage).toHaveBeenCalledWith('new-event');
    });
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
    const events: RuntimeEvent[] = [
      buildEvent({ id: 'h1', role: 'user', content: 'first command' }),
      buildEvent({ id: 'h2', role: 'agent', content: 'ok' }),
      buildEvent({ id: 'h3', role: 'user', content: 'second command' }),
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

    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;

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

  it('replays current session user history from events with ArrowUp', async () => {
    const onSendMessage = vi.fn<(payload: unknown) => void>();
    const events: RuntimeEvent[] = [
      buildEvent({ id: 'e1', role: 'user', content: 'session first' }),
      buildEvent({ id: 'e2', role: 'agent', content: 'ok' }),
      buildEvent({ id: 'e3', role: 'user', content: 'session second' }),
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

    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    expect(input.value).toBe('');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() => {
      expect(input.value).toBe('session second');
    });

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() => {
      expect(input.value).toBe('session first');
    });
  });

  it('creates new session on /new command without sending message', async () => {
    const onSendMessage = vi.fn<(payload: unknown) => void>();
    const onCreateNewSession = vi.fn<() => Promise<void>>(async () => undefined);

    render(
      <ChatInterface
        executionState={null}
        agents={[]}
        events={[]}
        onSendMessage={onSendMessage}
        onCreateNewSession={onCreateNewSession}
        onPause={() => undefined}
        onResume={() => undefined}
        isPaused={false}
        isConnected={true}
      />,
    );

    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/new' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(onCreateNewSession).toHaveBeenCalledTimes(1);
    });
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(input.value).toBe('');
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

  it('shows load-more hint when events exceed first page', () => {
    const onSendMessage = vi.fn<(payload: unknown) => void>();
    const events = Array.from({ length: 45 }, (_, index) =>
      buildEvent({ id: `evt-${index}`, role: 'user', content: `msg-${index}` }),
    );

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

    expect(screen.getByRole('button', { name: '加载更早消息（5 条）' })).not.toBeNull();
  });

  it('renders tool output collapsed by default', () => {
    const onSendMessage = vi.fn<(payload: unknown) => void>();
    const events: RuntimeEvent[] = [
      buildEvent({
        role: 'agent',
        kind: 'observation',
        toolName: 'exec_command',
        toolStatus: 'success',
        content: '工具执行成功：exec_command · 命令 pwd',
        toolOutput: 'Output:\n/Volumes/extension/code/finger',
      }),
    ];

    const { container } = render(
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

    const details = container.querySelector('details.tool-output-details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(screen.getByText(/查看工具输出：/)).not.toBeNull();
  });
});
