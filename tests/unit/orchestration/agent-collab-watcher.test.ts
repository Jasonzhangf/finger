import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MailboxBlock } from '../../../src/blocks/mailbox-block/index.js';
import {
  CompletionWatcher,
  isFinalStatus,
} from '../../../src/orchestration/agent-collab-watcher.js';
import type { AgentStatus } from '../../../src/orchestration/agent-collab-watcher.js';

describe('CompletionWatcher', () => {
  let mailbox: MailboxBlock;
  let statusProvider: ReturnType<typeof vi.fn>;

  const defaultOpts = {
    childId: 'worker-1',
    childPath: '/root/explorer/worker-1',
    parentPath: '/root/explorer',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mailbox = new MailboxBlock('parent-mailbox');
    statusProvider = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- isFinalStatus ----
  describe('isFinalStatus', () => {
    it('returns true for completed', () => {
      expect(isFinalStatus('completed')).toBe(true);
    });
    it('returns true for errored', () => {
      expect(isFinalStatus('errored')).toBe(true);
    });
    it('returns true for shutdown', () => {
      expect(isFinalStatus('shutdown')).toBe(true);
    });
    it('returns false for pending', () => {
      expect(isFinalStatus('pending')).toBe(false);
    });
    it('returns false for running', () => {
      expect(isFinalStatus('running')).toBe(false);
    });
  });

  // ---- Basic lifecycle ----
  describe('basic lifecycle', () => {
    it('starts, polls, detects final status, sends notification, and stops', async () => {
      statusProvider.mockResolvedValue('running');

      const watcher = new CompletionWatcher({
        ...defaultOpts,
        parentMailbox: mailbox,
        statusProvider,
      });

      const promise = watcher.start();
      expect(watcher.isRunning).toBe(true);

      // First poll: running → continue
      await vi.advanceTimersByTimeAsync(1000);
      expect(statusProvider).toHaveBeenCalledTimes(1);

      // Second poll: completed → final
      statusProvider.mockResolvedValue('completed');
      await vi.advanceTimersByTimeAsync(1000);
      expect(statusProvider).toHaveBeenCalledTimes(2);

      await promise;
      expect(watcher.isRunning).toBe(false);

      // Verify notification was sent to parent mailbox
      const msgs = mailbox.list({ messageType: 'inter_agent' });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].triggerTurn).toBe(false);
      expect(msgs[0].author).toBe('/root/explorer/worker-1');
      expect(msgs[0].recipient).toBe('/root/explorer');
    });
  });

  // ---- Multiple polls before final ----
  describe('multiple polls before final status', () => {
    it('keeps polling until a final status is reached', async () => {
      statusProvider
        .mockResolvedValueOnce('pending')
        .mockResolvedValueOnce('running')
        .mockResolvedValueOnce('running')
        .mockResolvedValueOnce('completed');

      const watcher = new CompletionWatcher({
        ...defaultOpts,
        parentMailbox: mailbox,
        statusProvider,
        pollIntervalMs: 500,
      });

      const promise = watcher.start();

      // 4 polls needed
      await vi.advanceTimersByTimeAsync(500);
      expect(statusProvider).toHaveBeenCalledTimes(1);
      expect(watcher.isRunning).toBe(true);

      await vi.advanceTimersByTimeAsync(500);
      expect(statusProvider).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(500);
      expect(statusProvider).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(500);
      expect(statusProvider).toHaveBeenCalledTimes(4);

      await promise;
      expect(watcher.isRunning).toBe(false);

      const msgs = mailbox.list({ messageType: 'inter_agent' });
      expect(msgs).toHaveLength(1);
    });
  });

  // ---- Different final statuses ----
  describe('different final statuses', () => {
    const finalStatuses: AgentStatus[] = ['completed', 'errored', 'shutdown'];

    for (const status of finalStatuses) {
      it(`sends notification when child reaches ${status}`, async () => {
        statusProvider.mockResolvedValue(status);

        const watcher = new CompletionWatcher({
          ...defaultOpts,
          parentMailbox: mailbox,
          statusProvider,
        });

        const promise = watcher.start();
        await vi.advanceTimersByTimeAsync(1000);
        await promise;

        const msgs = mailbox.list({ messageType: 'inter_agent' });
        expect(msgs).toHaveLength(1);
        const content = msgs[0].content as string;
        expect(content).toContain(status);
      });
    }
  });

  // ---- triggerTurn ----
  describe('triggerTurn option', () => {
    it('sends notification with triggerTurn=false by default', async () => {
      statusProvider.mockResolvedValue('completed');

      const watcher = new CompletionWatcher({
        ...defaultOpts,
        parentMailbox: mailbox,
        statusProvider,
      });

      const promise = watcher.start();
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      const msgs = mailbox.list({ messageType: 'inter_agent' });
      expect(msgs[0].triggerTurn).toBe(false);
    });

    it('sends notification with triggerTurn=true when configured', async () => {
      statusProvider.mockResolvedValue('completed');

      const watcher = new CompletionWatcher({
        ...defaultOpts,
        parentMailbox: mailbox,
        statusProvider,
        triggerTurn: true,
      });

      const promise = watcher.start();
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      const msgs = mailbox.list({ messageType: 'inter_agent' });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].triggerTurn).toBe(true);
    });
  });

  // ---- Poll error handling ----
  describe('poll error handling', () => {
    it('notifies parent with errored status when statusProvider throws', async () => {
      statusProvider.mockRejectedValue(new Error('poll failure'));

      const watcher = new CompletionWatcher({
        ...defaultOpts,
        parentMailbox: mailbox,
        statusProvider,
      });

      const promise = watcher.start();
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
      expect(watcher.isRunning).toBe(false);

      // Should still send a notification with "errored"
      const msgs = mailbox.list({ messageType: 'inter_agent' });
      expect(msgs).toHaveLength(1);
      const content = msgs[0].content as string;
      expect(content).toContain('errored');
    });
  });

  // ---- Double start prevention ----
  describe('double start prevention', () => {
    it('returns the same promise on second start call', async () => {
      statusProvider.mockResolvedValue('completed');

      const watcher = new CompletionWatcher({
        ...defaultOpts,
        parentMailbox: mailbox,
        statusProvider,
      });

      const promise1 = watcher.start();
      const promise2 = watcher.start();
      expect(promise1).toBe(promise2);
      expect(watcher.isRunning).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);
      await promise1;
      expect(watcher.isRunning).toBe(false);
    });
  });

  // ---- Stop without final status ----
  describe('stop without final status', () => {
    it('stops the watcher without sending notification when status is non-final', async () => {
      statusProvider.mockResolvedValue('running');

      const watcher = new CompletionWatcher({
        ...defaultOpts,
        parentMailbox: mailbox,
        statusProvider,
      });

      watcher.start();

      // Let one poll go through (non-final)
      await vi.advanceTimersByTimeAsync(1000);
      expect(watcher.isRunning).toBe(true);

      // Manually stop
      watcher.stop();
      expect(watcher.isRunning).toBe(false);

      // No notification should have been sent
      const msgs = mailbox.list({ messageType: 'inter_agent' });
      expect(msgs).toHaveLength(0);
    });
  });

  // ---- sendAgentCompletion integration ----
  describe('sendAgentCompletion integration', () => {
    it('notification lands in mailbox via sendAgentCompletion with correct fields', async () => {
      statusProvider.mockResolvedValue('completed');

      const watcher = new CompletionWatcher({
        ...defaultOpts,
        parentMailbox: mailbox,
        statusProvider,
      });

      const promise = watcher.start();
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      // The notification was sent via sendAgentCompletion
      const msgs = mailbox.list({ messageType: 'inter_agent' });
      expect(msgs).toHaveLength(1);

      const msg = msgs[0];
      expect(msg.target).toBe('/root/explorer');     // recipient → target
      expect(msg.author).toBe('/root/explorer/worker-1');
      expect(msg.recipient).toBe('/root/explorer');
      expect(msg.sourceType).toBe('agent-callable');
      expect(msg.status).toBe('pending');
      expect(msg.seq).toBe(1);
      expect((msg.content as string)).toContain('completed');
      expect((msg.content as string)).toContain('/root/explorer/worker-1');
    });
  });
});
