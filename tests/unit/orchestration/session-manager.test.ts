import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManager } from '../../../src/orchestration/session-manager.js';

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock os module
vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/test'),
  },
  homedir: vi.fn(() => '/home/test'),
}));

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  describe('constructor', () => {
    it('should initialize with empty sessions', () => {
      expect(manager.listSessions()).toEqual([]);
    });

    it('should have null current session initially', () => {
      expect(manager.getCurrentSession()).toBeNull();
    });
  });

  describe('createSession', () => {
    it('should create session with auto-generated name', () => {
      const session = manager.createSession('/project/path');
      expect(session.name).toBe('path');
      expect(session.projectPath).toMatch(/\/project\/path$/);
    });

    it('should create session with specified name', () => {
      const session = manager.createSession('/project/path', 'My Session');
      expect(session.name).toBe('My Session');
    });

    it('should set new session as current', () => {
      manager.createSession('/project/path');
      expect(manager.getCurrentSession()).not.toBeNull();
    });

    it('should generate unique session ID', () => {
      const s1 = manager.createSession('/path1');
      const s2 = manager.createSession('/path2');
      expect(s1.id).not.toBe(s2.id);
    });

    it('should initialize with empty messages', () => {
      const session = manager.createSession('/path');
      expect(session.messages).toEqual([]);
    });
  });

  describe('getSession', () => {
    it('should return session by ID', () => {
      const created = manager.createSession('/path');
      const session = manager.getSession(created.id);
      expect(session).toBeDefined();
      expect(session!.id).toBe(created.id);
    });

    it('should return undefined for non-existent', () => {
      const session = manager.getSession('nonexistent');
      expect(session).toBeUndefined();
    });
  });

  describe('getCurrentSession', () => {
    it('should return null when no current session', () => {
      expect(manager.getCurrentSession()).toBeNull();
    });

    it('should return current session after create', () => {
      manager.createSession('/path');
      const current = manager.getCurrentSession();
      expect(current).not.toBeNull();
    });
  });

  describe('setCurrentSession', () => {
    it('should set current session', () => {
      const session = manager.createSession('/path');
      manager.createSession('/path2'); // create another
      
      const result = manager.setCurrentSession(session.id);
      expect(result).toBe(true);
      expect(manager.getCurrentSession()?.id).toBe(session.id);
    });

    it('should return false for non-existent', () => {
      const result = manager.setCurrentSession('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('listSessions', () => {
    it('should return empty array when no sessions', () => {
      expect(manager.listSessions()).toEqual([]);
    });

    it('should return all sessions sorted by lastAccessedAt', async () => {
      await new Promise(r => setTimeout(r, 10));
      const s2 = manager.createSession('/path2');
      
      const list = manager.listSessions();
      expect(list.length).toBe(2);
      expect(list[0].id).toBe(s2.id);
    });
  });

  describe('addMessage', () => {
    let sessionId: string;

    beforeEach(() => {
      const session = manager.createSession('/path');
      sessionId = session.id;
    });

    it('should add message to session', () => {
      const msg = manager.addMessage(sessionId, 'user', 'Hello');
      expect(msg).not.toBeNull();
      expect(msg!.content).toBe('Hello');
      expect(msg!.role).toBe('user');
    });

    it('should return null for non-existent session', () => {
      const msg = manager.addMessage('nonexistent', 'user', 'Hello');
      expect(msg).toBeNull();
    });

    it('should add message with metadata', () => {
      const msg = manager.addMessage(sessionId, 'assistant', 'Response', {
        workflowId: 'wf-1',
        taskId: 'task-1',
      });
      expect(msg!.workflowId).toBe('wf-1');
      expect(msg!.taskId).toBe('task-1');
    });

    it('should generate unique message ID', () => {
      const msg1 = manager.addMessage(sessionId, 'user', 'Msg 1');
      const msg2 = manager.addMessage(sessionId, 'user', 'Msg 2');
      expect(msg1!.id).not.toBe(msg2!.id);
    });

    it('should limit messages to 100', () => {
      for (let i = 0; i < 150; i++) {
        manager.addMessage(sessionId, 'user', `Message ${i}`);
      }
      const session = manager.getSession(sessionId)!;
      expect(session.messages.length).toBe(100);
    });
  });

  describe('getMessages', () => {
    let sessionId: string;

    beforeEach(() => {
      const session = manager.createSession('/path');
      sessionId = session.id;
    });

    it('should return messages for session', () => {
      manager.addMessage(sessionId, 'user', 'Msg 1');
      manager.addMessage(sessionId, 'user', 'Msg 2');
      
      const messages = manager.getMessages(sessionId);
      expect(messages.length).toBe(2);
    });

    it('should limit messages', () => {
      for (let i = 0; i < 60; i++) {
        manager.addMessage(sessionId, 'user', `Msg ${i}`);
      }
      
      const messages = manager.getMessages(sessionId, 10);
      expect(messages.length).toBe(10);
    });

    it('should return empty for non-existent session', () => {
      const messages = manager.getMessages('nonexistent');
      expect(messages).toEqual([]);
    });
  });

  describe('getFullContext', () => {
    let sessionId: string;

    beforeEach(() => {
      const session = manager.createSession('/path');
      sessionId = session.id;
    });

    it('should return messages and undefined summary', () => {
      manager.addMessage(sessionId, 'user', 'Hello');
      
      const ctx = manager.getFullContext(sessionId);
      expect(ctx.messages.length).toBe(1);
      expect(ctx.compressedSummary).toBeUndefined();
    });

    it('should return empty for non-existent session', () => {
      const ctx = manager.getFullContext('nonexistent');
      expect(ctx.messages).toEqual([]);
    });
  });

  describe('compressContext', () => {
    let sessionId: string;

    beforeEach(() => {
      const session = manager.createSession('/path');
      sessionId = session.id;
    });

    it('should not compress when under threshold', async () => {
      for (let i = 0; i < 30; i++) {
        manager.addMessage(sessionId, 'user', `Msg ${i}`);
      }
      
      const result = await manager.compressContext(sessionId);
      expect(result).toBe('No compression needed');
    });

    it('should compress when over threshold', async () => {
      for (let i = 0; i < 60; i++) {
        manager.addMessage(sessionId, 'user', `Message ${i}`);
      }
      
      const result = await manager.compressContext(sessionId);
      expect(result).toContain('用户请求');
      
      const session = manager.getSession(sessionId)!;
      expect(session.messages.length).toBeLessThanOrEqual(50);
    });

    it('should use custom summarizer', async () => {
      for (let i = 0; i < 60; i++) {
        manager.addMessage(sessionId, 'user', `Msg ${i}`);
      }
      
      const result = await manager.compressContext(sessionId, async (msgs) => {
        return `Custom summary: ${msgs.length} messages`;
      });
      expect(result).toContain('Custom summary');
    });

    it('should throw for non-existent session', async () => {
      await expect(manager.compressContext('nonexistent')).rejects.toThrow('Session not found');
    });
  });

  describe('getCompressionStatus', () => {
    let sessionId: string;

    beforeEach(() => {
      const session = manager.createSession('/path');
      sessionId = session.id;
    });

    it('should return not compressed initially', () => {
      const status = manager.getCompressionStatus(sessionId);
      expect(status.compressed).toBe(false);
    });

    it('should return compressed after compression', async () => {
      for (let i = 0; i < 60; i++) {
        manager.addMessage(sessionId, 'user', `Msg ${i}`);
      }
      await manager.compressContext(sessionId);
      
      const status = manager.getCompressionStatus(sessionId);
      expect(status.compressed).toBe(true);
      expect(status.originalCount).toBeDefined();
    });

    it('should return not compressed for non-existent', () => {
      const status = manager.getCompressionStatus('nonexistent');
      expect(status.compressed).toBe(false);
    });
  });

  describe('pauseSession', () => {
    it('should pause session', () => {
      const session = manager.createSession('/path');
      const result = manager.pauseSession(session.id);
      expect(result).toBe(true);
      
      const s = manager.getSession(session.id)!;
      expect(s.context.paused).toBe(true);
    });

    it('should return false for non-existent', () => {
      const result = manager.pauseSession('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('resumeSession', () => {
    it('should resume session', () => {
      const session = manager.createSession('/path');
      manager.pauseSession(session.id);
      
      const result = manager.resumeSession(session.id);
      expect(result).toBe(true);
      
      const s = manager.getSession(session.id)!;
      expect(s.context.paused).toBe(false);
    });

    it('should return false for non-existent', () => {
      const result = manager.resumeSession('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('isPaused', () => {
    it('should return false when not paused', () => {
      const session = manager.createSession('/path');
      expect(manager.isPaused(session.id)).toBe(false);
    });

    it('should return true when paused', () => {
      const session = manager.createSession('/path');
      manager.pauseSession(session.id);
      expect(manager.isPaused(session.id)).toBe(true);
    });

    it('should return false for non-existent', () => {
      expect(manager.isPaused('nonexistent')).toBe(false);
    });
  });

  describe('updateContext', () => {
    it('should update context', () => {
      const session = manager.createSession('/path');
      const result = manager.updateContext(session.id, { key: 'value' });
      expect(result).toBe(true);
      
      const s = manager.getSession(session.id)!;
      expect(s.context.key).toBe('value');
    });

    it('should merge context', () => {
      const session = manager.createSession('/path');
      manager.updateContext(session.id, { a: 1 });
      manager.updateContext(session.id, { b: 2 });
      
      const s = manager.getSession(session.id)!;
      expect(s.context).toEqual({ a: 1, b: 2 });
    });

    it('should return false for non-existent', () => {
      const result = manager.updateContext('nonexistent', {});
      expect(result).toBe(false);
    });
  });

  describe('addWorkflowToSession', () => {
    it('should add workflow to session', () => {
      const session = manager.createSession('/path');
      const result = manager.addWorkflowToSession(session.id, 'wf-1');
      expect(result).toBe(true);
      
      const s = manager.getSession(session.id)!;
      expect(s.activeWorkflows).toContain('wf-1');
    });

    it('should not duplicate workflows', () => {
      const session = manager.createSession('/path');
      manager.addWorkflowToSession(session.id, 'wf-1');
      manager.addWorkflowToSession(session.id, 'wf-1');
      
      const s = manager.getSession(session.id)!;
      expect(s.activeWorkflows.length).toBe(1);
    });

    it('should return false for non-existent', () => {
      const result = manager.addWorkflowToSession('nonexistent', 'wf-1');
      expect(result).toBe(false);
    });
  });

  describe('deleteSession', () => {
    it('should delete session', () => {
      const session = manager.createSession('/path');
      const result = manager.deleteSession(session.id);
      expect(result).toBe(true);
      expect(manager.getSession(session.id)).toBeUndefined();
    });

    it('should return false for non-existent', () => {
      const result = manager.deleteSession('nonexistent');
      expect(result).toBe(false);
    });

    it('should switch current session when deleting current', () => {
      const s1 = manager.createSession('/path1');
      const s2 = manager.createSession('/path2');
      
      manager.setCurrentSession(s2.id);
      manager.deleteSession(s2.id);
      
      expect(manager.getCurrentSession()?.id).toBe(s1.id);
    });
  });

  describe('getFullContext', () => {
    it('returns messages and undefined summary initially', () => {
      const session = manager.createSession('/path');
      manager.addMessage(session.id, 'user', 'Hello');
      
      const ctx = manager.getFullContext(session.id);
      expect(ctx.messages.length).toBe(1);
      expect(ctx.compressedSummary).toBeUndefined();
    });

    it('returns empty for non-existent session', () => {
      const ctx = manager.getFullContext('nonexistent');
      expect(ctx.messages).toEqual([]);
      expect(ctx.compressedSummary).toBeUndefined();
    });
  });

  describe('compressContext', () => {
    it('does not compress when under threshold', async () => {
      const session = manager.createSession('/path');
      for (let i = 0; i < 10; i++) {
        manager.addMessage(session.id, 'user', `Msg ${i}`);
      }
      
      const result = await manager.compressContext(session.id);
      expect(result).toBe('No compression needed');
    });

    it('compresses when over threshold', async () => {
      const session = manager.createSession('/path');
      for (let i = 0; i < 60; i++) {
        manager.addMessage(session.id, 'user', `Msg ${i}`);
      }
      
      const result = await manager.compressContext(session.id);
      expect(result).toContain('用户请求:');
    });

    it('uses custom summarizer when provided', async () => {
      const session = manager.createSession('/path');
      for (let i = 0; i < 60; i++) {
        manager.addMessage(session.id, 'user', `Msg ${i}`);
      }
      
      const customSummary = async () => 'Custom summary';
      const result = await manager.compressContext(session.id, customSummary);
      expect(result).toBe('Custom summary');
    });

    it('throws for non-existent session', async () => {
      await expect(manager.compressContext('nonexistent')).rejects.toThrow('Session not found');
    });
  });

});
