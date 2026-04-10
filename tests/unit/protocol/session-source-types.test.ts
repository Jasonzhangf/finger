import { describe, it, expect } from 'vitest';
import { SessionSourceUtils, LegacySessionMigration } from '../../../src/protocol/session-source-types.js';

describe('Protocol: Session Source Types', () => {
  describe('SessionSourceUtils', () => {
    it('should create CLI session source', () => {
      const source = SessionSourceUtils.createCli('worker-1', 'user-1');
      expect(source.source).toBe('cli');
      expect(source.ownerWorkerId).toBe('worker-1');
      expect(source.creator?.id).toBe('user-1');
      expect(source.createdAt).toBeDefined();
    });

    it('should create WebUI session source', () => {
      const source = SessionSourceUtils.createWebui('worker-1');
      expect(source.source).toBe('webui');
      expect(source.createdAt).toBeDefined();
    });

    it('should create VSCode session source', () => {
      const source = SessionSourceUtils.createVscode('worker-1', 'user-1');
      expect(source.source).toBe('vscode');
      expect(source.creator?.id).toBe('user-1');
    });

    it('should create Heartbeat session source', () => {
      const source = SessionSourceUtils.createHeartbeat('worker-1', 'check dispatch');
      expect(source.source).toBe('heartbeat');
      expect(source.creator?.type).toBe('system');
      expect(source.creator?.id).toBe('heartbeat-scheduler');
      expect(source.reason).toBe('check dispatch');
    });

    it('should create Subagent session source', () => {
      const source = SessionSourceUtils.createSubagent(
        'worker-1',
        'dispatch',
        'parent-thread-1',
        1,
        { agentRole: 'project', agentName: 'project-executor', reason: 'sub-task' },
      );
      expect(source.source).toBe('subagent');
      expect(source.subAgentSource?.type).toBe('dispatch');
      expect(source.subAgentSource?.parentThreadId).toBe('parent-thread-1');
      expect(source.subAgentSource?.depth).toBe(1);
      expect(source.subAgentSource?.agentRole).toBe('project');
      expect(source.reason).toBe('sub-task');
    });

    it('should validate session source', () => {
      const validSource = SessionSourceUtils.createCli('worker-1');
      const result = SessionSourceUtils.validate(validSource);
      expect(result.valid).toBe(true);
      expect(result.missing.length).toBe(0);
    });

    it('should detect missing fields', () => {
      const result = SessionSourceUtils.validate({} as any);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('source');
      expect(result.missing).toContain('createdAt');
      expect(result.missing).toContain('ownerWorkerId');
    });

    it('should validate subagent source fields', () => {
      const incompleteSubagent = {
        source: 'subagent',
        createdAt: new Date().toISOString(),
        ownerWorkerId: 'worker-1',
      } as any;
      const result = SessionSourceUtils.validate(incompleteSubagent);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('subAgentSource');
    });

    it('should check if is subagent', () => {
      const subagent = SessionSourceUtils.createSubagent('worker-1', 'dispatch', 'parent-1', 1);
      expect(SessionSourceUtils.isSubagent(subagent)).toBe(true);
      const cli = SessionSourceUtils.createCli('worker-1');
      expect(SessionSourceUtils.isSubagent(cli)).toBe(false);
    });

    it('should check if is heartbeat', () => {
      const hb = SessionSourceUtils.createHeartbeat('worker-1');
      expect(SessionSourceUtils.isHeartbeat(hb)).toBe(true);
      const cli = SessionSourceUtils.createCli('worker-1');
      expect(SessionSourceUtils.isHeartbeat(cli)).toBe(false);
    });

    it('should check if user created', () => {
      expect(SessionSourceUtils.isUserCreated(SessionSourceUtils.createCli('w'))).toBe(true);
      expect(SessionSourceUtils.isUserCreated(SessionSourceUtils.createWebui('w'))).toBe(true);
      expect(SessionSourceUtils.isUserCreated(SessionSourceUtils.createVscode('w'))).toBe(true);
      expect(SessionSourceUtils.isUserCreated(SessionSourceUtils.createHeartbeat('w'))).toBe(false);
      expect(SessionSourceUtils.isUserCreated(SessionSourceUtils.createSubagent('w', 'dispatch', 'p', 1))).toBe(false);
    });

    it('should get depth', () => {
      const subagent = SessionSourceUtils.createSubagent('w', 'dispatch', 'p', 3);
      expect(SessionSourceUtils.getDepth(subagent)).toBe(3);
      const cli = SessionSourceUtils.createCli('w');
      expect(SessionSourceUtils.getDepth(cli)).toBe(0);
    });

    it('should get parent thread id', () => {
      const subagent = SessionSourceUtils.createSubagent('w', 'dispatch', 'parent-123', 1);
      expect(SessionSourceUtils.getParentThreadId(subagent)).toBe('parent-123');
      const cli = SessionSourceUtils.createCli('w');
      expect(SessionSourceUtils.getParentThreadId(cli)).toBe(null);
    });
  });

  describe('LegacySessionMigration', () => {
    it('should migrate session with missing fields', () => {
      const oldSession = {};
      const migrated = LegacySessionMigration.migrate(oldSession);
      expect(migrated.source).toBe('cli');
      expect(migrated.ownerWorkerId).toBe('system-worker-default');
      expect(migrated.createdAt).toBeDefined();
    });

    it('should not migrate valid session', () => {
      const validSource = SessionSourceUtils.createCli('worker-1');
      const session = { source: validSource };
      const result = LegacySessionMigration.migrate(session);
      expect(result).toBe(validSource);
    });

    it('should check if migration needed', () => {
      expect(LegacySessionMigration.needsMigration({})).toBe(true);
      
      const validSource = SessionSourceUtils.createCli('worker-1');
      expect(LegacySessionMigration.needsMigration({ source: validSource })).toBe(false);
    });
  });
});
