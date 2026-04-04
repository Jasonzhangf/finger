import { beforeEach, describe, expect, it, vi } from 'vitest';

const appendSessionMessageMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/runtime/ledger-writer.js', () => ({
  appendSessionMessage: appendSessionMessageMock,
}));

import { SessionManager } from '../../../src/orchestration/session-manager.js';

describe('SessionManager transient ledger resilience', () => {
  beforeEach(() => {
    appendSessionMessageMock.mockReset();
    appendSessionMessageMock.mockResolvedValue(undefined);
  });

  it('falls back to main ledger when transient ledger write returns ENOENT', async () => {
    const manager = new SessionManager();
    const session = manager.createSession(`/tmp/finger-sm-transient-${Date.now()}`, 'Transient Fallback Session');
    manager.setTransientLedgerMode(session.id, 'turn-transient-1', { source: 'unit-test', autoDeleteOnStop: true });

    const enoent = Object.assign(new Error('transient ledger removed'), { code: 'ENOENT' });
    appendSessionMessageMock
      .mockRejectedValueOnce(enoent)
      .mockResolvedValueOnce(undefined);

    const appended = await manager.addMessage(session.id, 'user', 'hello transient fallback');

    expect(appended).not.toBeNull();
    expect(appendSessionMessageMock).toHaveBeenCalledTimes(2);
    expect(appendSessionMessageMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      sessionId: session.id,
      mode: 'turn-transient-1',
    }));
    expect(appendSessionMessageMock.mock.calls[1][0]).toEqual(expect.objectContaining({
      sessionId: session.id,
      mode: 'main',
    }));
  });

  it('clears transient ledger mode before post-finalize message writes', async () => {
    const manager = new SessionManager();
    const session = manager.createSession(`/tmp/finger-sm-transient-clear-${Date.now()}`, 'Transient Clear Session');
    manager.setTransientLedgerMode(session.id, 'turn-transient-2', { source: 'unit-test', autoDeleteOnStop: true });

    const finalized = await manager.finalizeTransientLedgerMode(session.id, { finishReason: 'stop' });
    expect(finalized.active).toBe(true);

    const current = manager.getSession(session.id);
    expect(current?.context.activeLedgerMode).toBeUndefined();
    expect(current?.context.transientLedgerMode).toBeUndefined();

    await manager.addMessage(session.id, 'assistant', 'after transient finalize');

    expect(appendSessionMessageMock).toHaveBeenCalledTimes(1);
    expect(appendSessionMessageMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      sessionId: session.id,
      mode: 'main',
    }));
  });
});
