/**
 * Heartbeat State Tool 单元测试
 * 测试 heartbeat.state / heartbeat.stop / heartbeat.resume / mailbox.health / mailbox.clear / mailbox.mark_skip
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { heartbeatStateTool, heartbeatStopTool, heartbeatResumeTool, mailboxHealthTool, mailboxClearTool, mailboxMarkSkipTool } from '../../../../src/tools/internal/heartbeat-state-tool.ts';
import type { ToolExecutionContext } from '../../../../src/tools/internal/types.js';
import { heartbeatScheduler } from '../../../../src/server/index.js';
import { heartbeatMailbox } from '../../../../src/server/modules/heartbeat-mailbox.js';

// Mock heartbeatScheduler
vi.mock('../../../../src/server/index.js', () => ({
  heartbeatScheduler: {
    getState: vi.fn().mockReturnValue('RUNNING'),
    getStateContext: vi.fn().mockReturnValue({}),
    requestStop: vi.fn(),
    requestResume: vi.fn(),
  },
}));

// Mock heartbeatMailbox
vi.mock('../../../../src/server/modules/heartbeat-mailbox.js', () => ({
  heartbeatMailbox: {
    list: vi.fn().mockReturnValue([
      { id: 'msg-1', status: 'pending', createdAt: '2026-04-06T10:00:00.000Z' },
      { id: 'msg-2', status: 'processing', createdAt: '2026-04-06T10:01:00.000Z' },
    ]),
    clear: vi.fn().mockReturnValue({ cleared: 5 }),
    markSkip: vi.fn().mockReturnValue(true),
  },
}));

const mockContext: ToolExecutionContext = {
  sessionId: 'test-session',
  agentId: 'test-agent',
};

const scheduler = heartbeatScheduler as unknown as {
  getState: ReturnType<typeof vi.fn>;
  getStateContext: ReturnType<typeof vi.fn>;
  requestStop: ReturnType<typeof vi.fn>;
  requestResume: ReturnType<typeof vi.fn>;
};

const mailbox = heartbeatMailbox as unknown as {
  list: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  markSkip: ReturnType<typeof vi.fn>;
};

describe('Heartbeat State Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scheduler.getState.mockReturnValue('RUNNING');
    scheduler.getStateContext.mockReturnValue({});
    mailbox.list.mockReturnValue([
      { id: 'msg-1', status: 'pending', createdAt: '2026-04-06T10:00:00.000Z' },
      { id: 'msg-2', status: 'processing', createdAt: '2026-04-06T10:01:00.000Z' },
    ]);
    mailbox.clear.mockReturnValue(5);
    mailbox.markSkip.mockReturnValue(true);
  });

  describe('heartbeat.state', () => {
    it('should return current state', async () => {
      const result = await heartbeatStateTool.execute({}, mockContext);
      expect(result.success).toBe(true);
      expect(result.data.state).toBe('RUNNING');
    });

    it('should return mailbox health for system agent', async () => {
      const result = await heartbeatStateTool.execute({}, mockContext);
      expect(result.data.mailboxHealth).toBeDefined();
      expect(result.data.mailboxHealth.systemAgent).toBeDefined();
    });

    it('should calculate pending/processing counts', async () => {
      const result = await heartbeatStateTool.execute({}, mockContext);
      expect(result.data.mailboxHealth.systemAgent.pending).toBe(1);
      expect(result.data.mailboxHealth.systemAgent.processing).toBe(1);
    });

    it('should include timestamp', async () => {
      const result = await heartbeatStateTool.execute({}, mockContext);
      expect(result.data.timestamp).toBeDefined();
      expect(new Date(result.data.timestamp).toISOString()).toBe(result.data.timestamp);
    });

    it('should return success message', async () => {
      const result = await heartbeatStateTool.execute({}, mockContext);
      expect(result.message).toContain('RUNNING');
    });
  });

  describe('heartbeat.stop', () => {
    it('permanent=true should request STOPPED', async () => {
      const result = await heartbeatStopTool.execute({
        permanent: true,
        reason: 'fatal error',
      }, mockContext);
      
      expect(scheduler.requestStop).toHaveBeenCalledWith('fatal error', true, undefined);
      expect(result.success).toBe(true);
    });

    it('permanent=false should request PAUSED', async () => {
      const result = await heartbeatStopTool.execute({
        permanent: false,
        reason: 'mailbox backlog',
      }, mockContext);
      
      expect(scheduler.requestStop).toHaveBeenCalledWith('mailbox backlog', false, undefined);
      expect(result.success).toBe(true);
    });

    it('resume_after_minutes should be passed', async () => {
      const result = await heartbeatStopTool.execute({
        permanent: false,
        reason: 'temporary block',
        resume_after_minutes: 10,
      }, mockContext);
      
      expect(scheduler.requestStop).toHaveBeenCalledWith('temporary block', false, 10);
    });

    it('should return success message', async () => {
      const result = await heartbeatStopTool.execute({ reason: 'test' }, mockContext);
      expect(result.message).toContain('stopped');
    });
  });

  describe('heartbeat.resume', () => {
    it('should request resume with reason', async () => {
      scheduler.getState.mockReturnValue('PAUSED');
      const result = await heartbeatResumeTool.execute({
        reason: 'block cleared',
      }, mockContext);
      
      expect(scheduler.requestResume).toHaveBeenCalledWith('block cleared');
      expect(result.success).toBe(true);
    });

    it('should return success message', async () => {
      scheduler.getState.mockReturnValue('PAUSED');
      const result = await heartbeatResumeTool.execute({ reason: 'test' }, mockContext);
      expect(result.message).toContain('resumed');
    });
  });

  describe('mailbox.health', () => {
    it('should return mailbox health for specified agent', async () => {
      const result = await mailboxHealthTool.execute({
        agentId: 'finger-system-agent',
      }, mockContext);
      
      expect(result.success).toBe(true);
      expect(result.data.pending).toBe(1);
      expect(result.data.processing).toBe(1);
    });

    it('should default to system agent', async () => {
      const result = await mailboxHealthTool.execute({}, mockContext);
      expect(result.success).toBe(true);
    });
  });

  describe('mailbox.clear', () => {
    it('should clear mailbox and return count', async () => {
      const result = await mailboxClearTool.execute({
        agentId: 'finger-system-agent',
      }, mockContext);
      
      expect(result.success).toBe(true);
      expect(result.data.cleared).toBe(5);
    });

    it('should return success message', async () => {
      const result = await mailboxClearTool.execute({ agentId: 'test' }, mockContext);
      expect(result.message).toContain('cleared');
    });
  });

  describe('mailbox.mark_skip', () => {
    it('should mark messages as skipped', async () => {
      const result = await mailboxMarkSkipTool.execute({
        ids: ['msg-1', 'msg-2', 'msg-3'],
        reason: 'duplicate notification',
      }, mockContext);
      
      expect(result.success).toBe(true);
      expect(result.data.marked).toBe(3);
    });

    it('should return success message', async () => {
      const result = await mailboxMarkSkipTool.execute({
        ids: ['msg-1'],
        reason: 'test',
      }, mockContext);
      expect(result.message).toContain('marked');
    });
  });
});
