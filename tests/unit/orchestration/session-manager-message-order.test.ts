import { describe, it, expect } from 'vitest';
import { SessionManager } from '../../../src/orchestration/session-manager.js';

describe('SessionManager message ordering', () => {
  it('keeps session snapshot messages sorted by timestamp when delayed user message is persisted later', async () => {
    const manager = new SessionManager();
    const projectPath = `/tmp/finger-session-order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session = manager.createSession(projectPath, 'Ordering Test Session');

    const marker = `ord-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const t1 = '2026-04-02T09:00:00.000Z';
    const t2 = '2026-04-02T09:00:02.000Z';
    const t3 = '2026-04-02T09:00:03.000Z';

    await manager.addMessage(session.id, 'assistant', `${marker}-assistant-later`, { timestamp: t2 });
    await manager.addMessage(session.id, 'user', `${marker}-user-delayed`, { timestamp: t1 });
    await manager.addMessage(session.id, 'assistant', `${marker}-assistant-latest`, { timestamp: t3 });

    const persisted = manager.getSession(session.id);
    expect(persisted).toBeDefined();
    const ordered = (persisted?.messages ?? []).filter((m) => String(m.content).startsWith(marker));

    expect(ordered.map((m) => m.content)).toEqual([
      `${marker}-user-delayed`,
      `${marker}-assistant-later`,
      `${marker}-assistant-latest`,
    ]);
    expect(ordered.map((m) => m.timestamp)).toEqual([t1, t2, t3]);
  });
});

