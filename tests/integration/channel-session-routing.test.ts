import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpHome: string;
let SessionManager: any;
let ensureFingerLayout: any;

beforeEach(async () => {
  vi.resetModules();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-channel-routing-'));
  process.env.FINGER_HOME = tmpHome;
  
  const fingerPathsMod = await import('../../src/core/finger-paths.js');
  const sessionMod = await import('../../src/orchestration/session-manager.js');
  
  SessionManager = sessionMod.SessionManager;
  ensureFingerLayout = fingerPathsMod.ensureFingerLayout;
  
  ensureFingerLayout();
});

afterEach(async () => {
  delete process.env.FINGER_HOME;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

describe('Channel Session Routing', () => {
  it('should reuse existing system session when channel context has no pinned session', async () => {
    const sm = new SessionManager();
    
    const systemSess = sm.getOrCreateSystemSession();
    await sm.addMessage(systemSess.id, 'user', 'Previous message');
    
    const existingSessions = sm.listSessions();
    expect(existingSessions.length).toBeGreaterThanOrEqual(1);
    
    const found = sm.getSession(systemSess.id);
    expect(found).toBeDefined();
    expect(found?.context.ownerAgentId).toBe('finger-system-agent');
  });

  it('should NOT create new session when channel expires', async () => {
    const sm = new SessionManager();
    
    const systemSess = sm.getOrCreateSystemSession();
    await sm.addMessage(systemSess.id, 'user', 'Hello');
    
    const sessionCountBefore = sm.listSessions().length;
    
    const routedSession = sm.getOrCreateSystemSession();
    
    expect(sm.listSessions().length).toBe(sessionCountBefore);
    expect(routedSession.id).toBe(systemSess.id);
  });

  it('should preserve session history across multiple channel messages', async () => {
    const sm = new SessionManager();
    const sess = sm.getOrCreateSystemSession();
    
    await sm.addMessage(sess.id, 'user', 'From channel A');
    await sm.addMessage(sess.id, 'assistant', 'Response A');
    
    await sm.addMessage(sess.id, 'user', 'From channel B');
    await sm.addMessage(sess.id, 'assistant', 'Response B');
    
    const history = sm.getMessages(sess.id, 0);
    expect(history).toHaveLength(4);
    expect(history[0].content).toBe('From channel A');
    expect(history[2].content).toBe('From channel B');
  });
});
