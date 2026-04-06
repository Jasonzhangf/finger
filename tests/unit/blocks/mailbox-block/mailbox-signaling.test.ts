import { describe, it, expect, beforeEach } from 'vitest';
import { MailboxBlock } from '../../../../src/blocks/mailbox-block/index.js';
import type { InterAgentCommunication, AgentCompletionNotification } from '../../../../src/blocks/mailbox-block/protocol.js';

/**
 * Mailbox 信令层测试
 * 
 * 本测试文件只验证 mailbox 的信令传递能力：
 * - triggerTurn 控制执行触发
 * - sender/receiver 地址传递
 * - completion status 信令传递（系统级状态同步）
 * 
 * 不涉及 agent/worker 等业务概念，只使用抽象的路径标识符。
 */
describe('MailboxBlock - Signaling Layer', () => {
  let mailbox: MailboxBlock;

  beforeEach(() => {
    mailbox = new MailboxBlock('test-mailbox');
  });

  describe('signaling message creation', () => {
    it('should create signaling message with triggerTurn=true', () => {
      const signal: InterAgentCommunication = {
        author: '/path/sender',
        recipient: '/path/receiver',
        content: 'signal-content',
        triggerTurn: true,
        timestamp: new Date().toISOString(),
      };
      const result = mailbox.sendInterAgent(signal);
      expect(result.id).toBeTruthy();
      expect(result.seq).toBe(1);
      const msg = mailbox.get(result.id);
      expect(msg).toBeDefined();
      expect(msg!.triggerTurn).toBe(true);
      expect(msg!.messageType).toBe('inter_agent');
      expect(msg!.author).toBe('/path/sender');
      expect(msg!.recipient).toBe('/path/receiver');
      expect(msg!.target).toBe('/path/receiver');
    });

    it('should create signaling message with triggerTurn=false (no execution trigger)', () => {
      const signal: InterAgentCommunication = {
        author: '/path/sender',
        recipient: '/path/receiver',
        content: 'signal-only',
        triggerTurn: false,
        timestamp: new Date().toISOString(),
      };
      const result = mailbox.sendInterAgent(signal);
      const msg = mailbox.get(result.id);
      expect(msg!.triggerTurn).toBe(false);
    });

    it('should support broadcast to multiple receivers', () => {
      const signal: InterAgentCommunication = {
        author: '/path/sender',
        recipient: '/path/receiver-1',
        otherRecipients: ['/path/receiver-2', '/path/receiver-3'],
        content: 'broadcast-signal',
        triggerTurn: true,
        timestamp: new Date().toISOString(),
      };
      mailbox.sendInterAgent(signal);
      const list = mailbox.list({ messageType: 'inter_agent' });
      expect(list).toHaveLength(1);
    });
  });

  describe('completion status signaling', () => {
    it('should create completion status signal', () => {
      const notif: AgentCompletionNotification = {
        author: '/path/sender',
        recipient: '/path/parent',
        content: 'completion-report',
        triggerTurn: true,
        timestamp: new Date().toISOString(),
        completionStatus: 'completed',
        finalMessage: 'final-output',
      };
      const result = mailbox.sendAgentCompletion(notif);
      const msg = mailbox.get(result.id);
      expect(msg!.messageType).toBe('inter_agent');
      expect(msg!.triggerTurn).toBe(true);
    });

    it('should support error completion status', () => {
      const notif: AgentCompletionNotification = {
        author: '/path/sender',
        recipient: '/path/parent',
        content: 'error-report',
        triggerTurn: false,
        timestamp: new Date().toISOString(),
        completionStatus: 'errored',
        finalMessage: 'error-details',
      };
      const result = mailbox.sendAgentCompletion(notif);
      const msg = mailbox.get(result.id);
      expect(msg!.triggerTurn).toBe(false);
    });
  });

  describe('trigger turn detection', () => {
    it('should detect pending triggerTurn=true signal', () => {
      const signal: InterAgentCommunication = {
        author: '/path/a',
        recipient: '/path/b',
        content: 'trigger-signal',
        triggerTurn: true,
        timestamp: new Date().toISOString(),
      };
      mailbox.sendInterAgent(signal);
      expect(mailbox.hasPendingTriggerTurn()).toBe(true);
    });

    it('should not trigger when triggerTurn=false', () => {
      const signal: InterAgentCommunication = {
        author: '/path/a',
        recipient: '/path/b',
        content: 'non-trigger-signal',
        triggerTurn: false,
        timestamp: new Date().toISOString(),
      };
      mailbox.sendInterAgent(signal);
      expect(mailbox.hasPendingTriggerTurn()).toBe(false);
    });

    it('should clear trigger after read', () => {
      const signal: InterAgentCommunication = {
        author: '/path/a',
        recipient: '/path/b',
        content: 'trigger-signal',
        triggerTurn: true,
        timestamp: new Date().toISOString(),
      };
      const { id } = mailbox.sendInterAgent(signal);
      mailbox.markRead(id);
      expect(mailbox.hasPendingTriggerTurn()).toBe(false);
    });
  });

  describe('signaling message filtering', () => {
    it('should filter by messageType', () => {
      const signal: InterAgentCommunication = {
        author: '/path/a',
        recipient: '/path/b',
        content: 's1',
        triggerTurn: true,
        timestamp: new Date().toISOString(),
      };
      mailbox.sendInterAgent(signal);
      mailbox.append('/path/c', { content: 'regular-msg' });

      const signalingMsgs = mailbox.list({ messageType: 'inter_agent' });
      expect(signalingMsgs).toHaveLength(1);
      expect(signalingMsgs[0].messageType).toBe('inter_agent');
    });

    it('should filter by target path (recipient maps to target)', () => {
      const s1: InterAgentCommunication = {
        author: '/path/a',
        recipient: '/path/b',
        content: 'to-b',
        triggerTurn: true,
        timestamp: new Date().toISOString(),
      };
      const s2: InterAgentCommunication = {
        author: '/path/a',
        recipient: '/path/c',
        content: 'to-c',
        triggerTurn: true,
        timestamp: new Date().toISOString(),
      };
      mailbox.sendInterAgent(s1);
      mailbox.sendInterAgent(s2);

      // recipient maps to target field in sendInterAgent
      const toB = mailbox.list({ target: '/path/b' });
      expect(toB).toHaveLength(1);
      expect(toB[0].target).toBe('/path/b');
    });
  });
});
