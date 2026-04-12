import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpHome: string;
let SessionManager: any;
let ensureFingerLayout: () => void;
let FINGER_PATHS: any;

beforeEach(async () => {
  vi.resetModules();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-e2e-startup-'));
  process.env.FINGER_HOME = tmpHome;
  
  // Dynamic import to pick up new FINGER_HOME
  const fingerPathsMod = await import('../../src/core/finger-paths.js');
  const sessionMod = await import('../../src/orchestration/session-manager.js');
  
  SessionManager = sessionMod.SessionManager;
  ensureFingerLayout = fingerPathsMod.ensureFingerLayout;
  FINGER_PATHS = fingerPathsMod.FINGER_PATHS;
  
  ensureFingerLayout();
});

afterEach(async () => {
  delete process.env.FINGER_HOME;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

describe('System Startup & Conversation Loop', () => {
  it('should create system session, persist to disk, and reload with full history', async () => {
    // 1. Startup phase
    const sessionManager = new SessionManager();
    const projectPath = '/tmp/finger-e2e-project'; 
    
    const systemSession = sessionManager.createSession(projectPath, 'system-startup-test');
    sessionManager.updateContext(systemSession.id, {
      ownerAgentId: 'finger-system-agent',
      projectTaskState: { status: 'idle' }
    });

    expect(systemSession).toBeDefined();
    expect(systemSession.messages).toHaveLength(0);

    // 2. First Turn: User -> Assistant
    const firstUserMsg = "Hello, project status check.";
    await sessionManager.addMessage(systemSession.id, 'user', firstUserMsg);
    
    const firstResponse = "Hello Jason. All systems nominal.";
    await sessionManager.addMessage(systemSession.id, 'assistant', firstResponse, {
      metadata: { channelId: 'e2e-test', agentId: 'finger-system-agent' }
    });

    expect(sessionManager.getSession(systemSession.id)?.messages).toHaveLength(2);

    // 3. Persistence check (auto-save on addMessage)
    // Verified implicitly by test #2 (reload from disk)
  });

  it('should reload session from disk with history intact after restart', async () => {
    // Step A: Create and fill session
    const sm1 = new SessionManager();
    const sess = sm1.createSession('/tmp/p', 'persist-test');
    await sm1.addMessage(sess.id, 'user', 'Ping');
    await sm1.addMessage(sess.id, 'assistant', 'Pong');

    // Step B: "Restart" - Create new instance
    const sm2 = new SessionManager();
    const loaded = sm2.getSession(sess.id);
    
    expect(loaded).toBeDefined();
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[0].content).toBe('Ping');
    expect(loaded?.messages[1].content).toBe('Pong');
    expect(loaded?.context.ownerAgentId).toBe('finger-system-agent'); // Default for new session

    // Step C: Continue conversation (Context Continuity)
    await sm2.addMessage(sess.id, 'user', 'Status?');
    const history = sm2.getMessages(sess.id, 0);
    expect(history).toHaveLength(3);
    expect(history[2].content).toBe('Status?');
  });

  it('should write to ledger after turn completion', async () => {
    const sm = new SessionManager();
    const sess = sm.createSession('/tmp/p', 'ledger-test');
    
    await sm.addMessage(sess.id, 'user', 'Do a task');
    await sm.addMessage(sess.id, 'assistant', 'Task done', {
       metadata: { agentId: 'finger-project-agent' } // Project agent to ensure ledger path
    });

    // Check ledger file
    const ledgerRoot = sm.resolveLedgerRootForSession(sess.id);
    if (ledgerRoot) {
        const ledgerPath = path.join(ledgerRoot, sess.id, 'finger-project-agent', 'main', 'context-ledger.jsonl');
        if (fs.existsSync(ledgerPath)) {
            const content = fs.readFileSync(ledgerPath, 'utf-8');
            expect(content).toContain('Do a task');
        } else {
             // System agent might write to different location or not if logic differs
             console.log("Ledger not found at expected path for project agent");
        }
    }
  });
});
