import { describe, it, expect } from 'vitest';
import { __chatCodexInternals } from '../../../../src/agents/chat-codex/chat-codex-module.js';
import type { MailboxSnapshot } from '../../../../src/runtime/mailbox-snapshot.js';

describe('chat-codex mailbox pending notice injection', () => {
  const baseContext = {
    sessionId: 'session-1',
    metadata: {},
  } as const;

  it('should inject pending notice when has unread and new seq exists', () => {
    const mailboxSnapshot: MailboxSnapshot = {
      currentSeq: 3,
      hasUnread: true,
      lastNotifiedSeq: 1,
      entries: [
        { id: 'm1', seq: 1, shortDescription: 'old msg', createdAt: '2026-03-10T00:00:00Z' },
        { id: 'm2', seq: 2, shortDescription: 'new msg 1', createdAt: '2026-03-10T00:00:01Z' },
        { id: 'm3', seq: 3, shortDescription: 'new msg 2', createdAt: '2026-03-10T00:00:02Z' },
      ],
    };

    const options = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        ...baseContext,
        mailboxSnapshot,
      },
      undefined,
      undefined,
    );

    expect(options?.developer_instructions).toContain('# Mailbox');
    expect(options?.developer_instructions).toContain('pending=2');
    expect(options?.developer_instructions).toContain('- new msg 1');
    expect(options?.developer_instructions).toContain('- new msg 2');
    expect(options?.developer_instructions).not.toContain('- old msg');
  });

  it('should not inject pending notice when no unread', () => {
    const mailboxSnapshot: MailboxSnapshot = {
      currentSeq: 0,
      hasUnread: false,
      lastNotifiedSeq: 0,
      entries: [],
    };

    const options = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        ...baseContext,
        mailboxSnapshot,
      },
      undefined,
      undefined,
    );

    expect(options?.developer_instructions ?? '').not.toContain('## Mailbox Pending Notice');
  });

  it('should not inject pending notice when same seq already notified', () => {
    const mailboxSnapshot: MailboxSnapshot = {
      currentSeq: 2,
      hasUnread: true,
      lastNotifiedSeq: 2,
      entries: [
        { id: 'm1', seq: 1, shortDescription: 'old msg 1', createdAt: '2026-03-10T00:00:00Z' },
        { id: 'm2', seq: 2, shortDescription: 'old msg 2', createdAt: '2026-03-10T00:00:01Z' },
      ],
    };

    const options = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        ...baseContext,
        mailboxSnapshot,
      },
      undefined,
      undefined,
    );

    expect(options?.developer_instructions ?? '').not.toContain('## Mailbox Pending Notice');
  });
});
