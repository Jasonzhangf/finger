import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Mailbox, type MailboxMessage } from '../../../src/server/mailbox.js';

describe('Mailbox', () => {
  let mailbox: Mailbox;

  beforeEach(() => {
    mailbox = new Mailbox();
  });

  describe('createMessage', () => {
    it('should create a message with auto-generated id', () => {
      const id = mailbox.createMessage('agent-1', { data: 'test' });
      expect(id).toBeDefined();
      expect(id).toMatch(/^msg-/);
    });

    it('should create a message with sender', () => {
      const id = mailbox.createMessage('agent-1', { data: 'test' }, 'user-1');
      const msg = mailbox.getMessage(id);
      expect(msg?.sender).toBe('user-1');
    });

    it('should create message with pending status', () => {
      const id = mailbox.createMessage('target', {});
      const msg = mailbox.getMessage(id);
      expect(msg?.status).toBe('pending');
    });
  });

  describe('getMessage', () => {
    it('should return message by id', () => {
      const id = mailbox.createMessage('target', { data: 'value' });
      const msg = mailbox.getMessage(id);
      expect(msg?.content).toEqual({ data: 'value' });
    });

    it('should return undefined for non-existent message', () => {
      const msg = mailbox.getMessage('non-existent');
      expect(msg).toBeUndefined();
    });
  });

  describe('updateStatus', () => {
    it('should update message status', () => {
      const id = mailbox.createMessage('target', {});
      const result = mailbox.updateStatus(id, 'completed', { success: true });
      expect(result).toBe(true);
      const msg = mailbox.getMessage(id);
      expect(msg?.status).toBe('completed');
      expect(msg?.result).toEqual({ success: true });
    });

    it('should update message with error', () => {
      const id = mailbox.createMessage('target', {});
      mailbox.updateStatus(id, 'failed', undefined, 'Something went wrong');
      const msg = mailbox.getMessage(id);
      expect(msg?.status).toBe('failed');
      expect(msg?.error).toBe('Something went wrong');
    });

    it('should return false for non-existent message', () => {
      const result = mailbox.updateStatus('non-existent', 'completed');
      expect(result).toBe(false);
    });
  });

  describe('listMessages', () => {
    it('should list all messages', () => {
      mailbox.createMessage('agent-1', {});
      mailbox.createMessage('agent-2', {});
      const messages = mailbox.listMessages();
      expect(messages.length).toBe(2);
    });

    it('should filter by target', () => {
      mailbox.createMessage('agent-1', {});
      mailbox.createMessage('agent-2', {});
      mailbox.createMessage('agent-1', {});
      const messages = mailbox.listMessages({ target: 'agent-1' });
      expect(messages.length).toBe(2);
    });

    it('should filter by status', () => {
      const id = mailbox.createMessage('agent-1', {});
      mailbox.updateStatus(id, 'completed');
      mailbox.createMessage('agent-1', {});
      const messages = mailbox.listMessages({ status: 'completed' });
      expect(messages.length).toBe(1);
    });

    it('should support pagination', () => {
      mailbox.createMessage('agent', {});
      mailbox.createMessage('agent', {});
      mailbox.createMessage('agent', {});
      const messages = mailbox.listMessages({ limit: 2, offset: 1 });
      expect(messages.length).toBe(2);
    });
  });

  describe('subscribe', () => {
    it('should notify subscriber on message creation', () => {
      const callback = vi.fn();
      const id = mailbox.createMessage('target', {});
      mailbox.subscribe(id, callback);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should notify subscriber on status update', () => {
      const callback = vi.fn();
      const id = mailbox.createMessage('target', {});
      mailbox.subscribe(id, callback);
      callback.mockClear();
      mailbox.updateStatus(id, 'completed');
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should return unsubscribe function', () => {
      const callback = vi.fn();
      const id = mailbox.createMessage('target', {});
      const unsub = mailbox.subscribe(id, callback);
      callback.mockClear();
      unsub();
      mailbox.updateStatus(id, 'completed');
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('should keep only most recent messages', () => {
      for (let i = 0; i < 150; i++) {
        mailbox.createMessage('agent', { index: i });
      }
      mailbox.cleanup(100);
      const messages = mailbox.listMessages();
      expect(messages.length).toBe(100);
    });

    it('should not delete if under limit', () => {
      mailbox.createMessage('agent', {});
      mailbox.createMessage('agent', {});
      mailbox.cleanup(100);
      const messages = mailbox.listMessages();
      expect(messages.length).toBe(2);
    });
  });
});
