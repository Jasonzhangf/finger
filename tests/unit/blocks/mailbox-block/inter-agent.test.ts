import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MailboxBlock } from '../../../../src/blocks/mailbox-block/index.js';
import type { InterAgentCommunication, AgentCompletionNotification } from '../../../../src/blocks/mailbox-block/protocol.js';

describe('MailboxBlock - InterAgentCommunication', () => {
  let mailbox: MailboxBlock;

  beforeEach(() => {
    mailbox = new MailboxBlock('test-mailbox');
  });

  describe('sendInterAgent', () => {
    it('should create message with triggerTurn=true', () => {
      const comm: InterAgentCommunication = {
        author: '/root/worker-1',
        recipient: '/root/worker-2',
        content: 'hello',
        triggerTurn: true,
        timestamp: new Date().toISOString(),
      };
      const result = mailbox.sendInterAgent(comm);
      expect(result.id).toBeTruthy();
      expect(result.seq).toBe(1);
      const msg = mailbox.get(result.id);
      expect(msg).toBeDefined();
      expect(msg!.triggerTurn).toBe(true);
      expect(msg!.messageType).toBe('inter_agent');
      expect(msg!.author).toBe('/root/worker-1');
      expect(msg!.recipient).toBe('/root/worker-2');
      expect(msg!.target).toBe('/root/worker-2');
    });

    it('should create message with triggerTurn=false', () => {
      const comm: InterAgentCommunication = {
        author: '/root/worker-1',
        recipient: '/root/worker-2',
        content: 'ping',
        triggerTurn: false,
        timestamp: new Date().toISOString(),
      };
      const result = mailbox.sendInterAgent(comm);
      const msg = mailbox.get(result.id);
      expect(msg!.triggerTurn).toBe(false);
    });

    it('should include otherRecipients in content', () => {
      const comm: InterAgentCommunication = {
        author: '/root/worker-1',
        recipient: '/root/worker-2',
        otherRecipients: ['/root/worker-3'],
        content: 'broadcast',
        triggerTurn: true,
        timestamp: new Date().toISOString(),
      };
      mailbox.sendInterAgent(comm);
      const list = mailbox.list({ messageType: 'inter_agent' });
      expect(list).toHaveLength(1);
    });
  });

  describe('sendAgentCompletion', () => {
    it('should create completion notification', () => {
      const notif: AgentCompletionNotification = {
        author: '/root/worker-1',
        recipient: '/root',
        content: 'Task done',
        triggerTurn: true,
        timestamp: new Date().toISOString(),
        completionStatus: 'completed',
        finalMessage: 'Result: 42',
      };
      const result = mailbox.sendAgentCompletion(notif);
      const msg = mailbox.get(result.id);
      expect(msg!.messageType).toBe('inter_agent');
      expect(msg!.triggerTurn).toBe(true);
    });
  });

  describe('hasPendingTriggerTurn', () => {
    it('should return true when triggerTurn=true pending exists', () => {
      const comm: InterAgentCommunication = {
        author: '/root/w1',
        recipient: '/root/w2',
        content: 'msg',
        triggerTurn: true,
        timestamp: new Date().toISOString(),
      };
      mailbox.sendInterAgent(comm);
      expect(mailbox.hasPendingTriggerTurn()).toBe(true);
    });

    it('should return false when no triggerTurn messages', () => {
      const comm: InterAgentCommunication = {
        author: '/root/w1',
        recipient: '/root/w2',
        content: 'msg',
        triggerTurn: false,
        timestamp: new Date().toISOString(),
      };
      mailbox.sendInterAgent(comm);
      expect(mailbox.hasPendingTriggerTurn()).toBe(false);
    });

    it('should return false when triggerTurn=true but already processed', () => {
      const comm: InterAgentCommunication = {
        author: '/root/w1',
        recipient: '/root/w2',
        content: 'msg',
        triggerTurn: true,
        timestamp: new Date().toISOString(),
      };
      const { id } = mailbox.sendInterAgent(comm);
      mailbox.markRead(id);
      expect(mailbox.hasPendingTriggerTurn()).toBe(false);
    });
  });

  describe('getPendingTriggerTurnMessages', () => {
    it('should return only triggerTurn=true pending messages', () => {
      mailbox.sendInterAgent({
        author: '/root/w1',
        recipient: '/root/w2',
        content: 'trigger',
        triggerTurn: true,
        timestamp: new Date().toISOString(),
      });
      mailbox.sendInterAgent({
        author: '/root/w1',
        recipient: '/root/w2',
        content: 'no-trigger',
        triggerTurn: false,
        timestamp: new Date().toISOString(),
      });
      const msgs = mailbox.getPendingTriggerTurnMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].triggerTurn).toBe(true);
    });

    it('should return empty when no triggerTurn pending', () => {
      expect(mailbox.getPendingTriggerTurnMessages()).toHaveLength(0);
    });
  });

  describe('list filters', () => {
    it('should filter by triggerTurn=true', () => {
      mailbox.sendInterAgent({
        author: '/root/w1', recipient: '/root/w2',
        content: 'a', triggerTurn: true, timestamp: new Date().toISOString(),
      });
      mailbox.sendInterAgent({
        author: '/root/w1', recipient: '/root/w2',
        content: 'b', triggerTurn: false, timestamp: new Date().toISOString(),
      });
      expect(mailbox.list({ triggerTurn: true })).toHaveLength(1);
      expect(mailbox.list({ triggerTurn: false })).toHaveLength(1);
    });

    it('should filter by author', () => {
      mailbox.sendInterAgent({
        author: '/root/w1', recipient: '/root/w2',
        content: 'a', triggerTurn: true, timestamp: new Date().toISOString(),
      });
      mailbox.sendInterAgent({
        author: '/root/w3', recipient: '/root/w2',
        content: 'b', triggerTurn: true, timestamp: new Date().toISOString(),
      });
      expect(mailbox.list({ author: '/root/w1' })).toHaveLength(1);
    });

    it('should filter by messageType', () => {
      mailbox.sendInterAgent({
        author: '/root/w1', recipient: '/root/w2',
        content: 'a', triggerTurn: true, timestamp: new Date().toISOString(),
      });
      expect(mailbox.list({ messageType: 'inter_agent' })).toHaveLength(1);
      expect(mailbox.list({ messageType: 'user' })).toHaveLength(0);
    });

    it('backward compat: old messages without triggerTurn default to false', () => {
      mailbox.append('target-1', { data: 'old' });
      const msgs = mailbox.list({ triggerTurn: true });
      expect(msgs).toHaveLength(0);
    });
  });

  describe('subscribeToSeq', () => {
    it('should resolve when new message arrives after subscribe', async () => {
      const sub = mailbox.subscribeToSeq();
      mailbox.append('t1', 'msg');
      const changed = await sub.waitForChange(1000);
      expect(changed).toBe(true);
      sub.unsubscribe();
    });

    it('should resolve when new message arrives', async () => {
      const sub = mailbox.subscribeToSeq();
      setTimeout(() => mailbox.append('t1', 'msg'), 10);
      const changed = await sub.waitForChange(5000);
      expect(changed).toBe(true);
      sub.unsubscribe();
    });

    it('should timeout when no new message', async () => {
      const sub = mailbox.subscribeToSeq();
      const changed = await sub.waitForChange(100);
      expect(changed).toBe(false);
      sub.unsubscribe();
    });

    it('should clean up on unsubscribe', () => {
      const sub = mailbox.subscribeToSeq();
      expect(() => sub.unsubscribe()).not.toThrow();
    });
  });
});
