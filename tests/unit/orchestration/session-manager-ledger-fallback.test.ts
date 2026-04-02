import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SessionManager } from '../../../src/orchestration/session-manager.js';

describe('SessionManager ledger fallback', () => {
  it('hydrates messages from ledger when persisted snapshot is empty', async () => {
    const manager = new SessionManager();
    const projectPath = `/tmp/finger-session-ledger-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session = manager.createSession(projectPath, 'Ledger Fallback Session');
    const marker = `lf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    await manager.addMessage(session.id, 'user', `${marker}-user`);
    await manager.addMessage(session.id, 'assistant', `${marker}-assistant`);

    const sessionDir = manager.resolveSessionStorageDir(session.id);
    expect(sessionDir).not.toBeNull();
    const sessionFile = path.join(sessionDir!, 'main.json');
    const persisted = JSON.parse(fs.readFileSync(sessionFile, 'utf-8')) as Record<string, unknown>;
    persisted.messages = [];
    if (persisted.context && typeof persisted.context === 'object') {
      delete (persisted.context as Record<string, unknown>).ownerAgentId;
    }
    fs.writeFileSync(sessionFile, JSON.stringify(persisted, null, 2));

    const reloaded = new SessionManager();
    const syncMessages = reloaded.getMessages(session.id, 0).filter((msg) => msg.content.startsWith(marker));
    expect(syncMessages.length).toBeGreaterThanOrEqual(2);
    expect(syncMessages.map((msg) => msg.content)).toContain(`${marker}-user`);
    expect(syncMessages.map((msg) => msg.content)).toContain(`${marker}-assistant`);

    const asyncMessages = (await reloaded.getMessagesAsync(session.id, 0)).filter((msg) => msg.content.startsWith(marker));
    expect(asyncMessages.length).toBeGreaterThanOrEqual(2);
    expect(asyncMessages.map((msg) => msg.content)).toContain(`${marker}-user`);
    expect(asyncMessages.map((msg) => msg.content)).toContain(`${marker}-assistant`);
  });
});

