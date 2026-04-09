import { describe, expect, it } from 'vitest';

import { SessionManager } from '../../../src/orchestration/session-manager.js';
import { RUST_KERNEL_COMPACTION_OWNERSHIP_MESSAGE } from '../../../src/runtime/kernel-owned-compaction.js';

describe('Context compact regression (Rust-only ownership)', () => {
  it('SessionManager.compressContext rejects instead of mutating session snapshot/pointers', async () => {
    const session = {
      id: 'session-rust-only-1',
      name: 'rust-only',
      projectPath: '/tmp/project',
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:00.000Z',
      lastAccessedAt: '2026-04-09T00:00:00.000Z',
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'compress me',
          timestamp: '2026-04-09T00:00:00.000Z',
        },
      ],
      activeWorkflows: [],
      context: {
        ownerAgentId: 'finger-system-agent',
        totalTokens: 99999,
      },
      ledgerPath: '',
      latestCompactIndex: 22,
      originalStartIndex: 5119,
      originalEndIndex: 5813,
      totalTokens: 24356,
      pointers: {
        contextHistory: { startLine: 0, endLine: 22, estimatedTokens: 0 },
        currentHistory: { startLine: 5119, endLine: 5448, estimatedTokens: 24356 },
      },
    } as any;

    const fakeSessionManager = {
      sessions: new Map([[session.id, session]]),
    };

    await expect(
      SessionManager.prototype.compressContext.call(fakeSessionManager, session.id, { force: true }),
    ).rejects.toThrow(RUST_KERNEL_COMPACTION_OWNERSHIP_MESSAGE);

    expect(session.messages).toHaveLength(1);
    expect(session.latestCompactIndex).toBe(22);
    expect(session.originalStartIndex).toBe(5119);
    expect(session.originalEndIndex).toBe(5813);
    expect(session.pointers.currentHistory.startLine).toBe(5119);
    expect(session.pointers.currentHistory.endLine).toBe(5448);
  });
});
