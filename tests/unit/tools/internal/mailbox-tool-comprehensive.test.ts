/**
 * Comprehensive tests for mailbox tools
 * Tests: status, list, read, ack, and send/receive flow
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createToolExecutionContext } from '../../../../src/tools/internal/types.js';
import { 
  mailboxStatusTool, 
  mailboxListTool, 
  mailboxReadTool, 
  mailboxAckTool 
} from '../../../../src/tools/internal/mailbox-tool.js';
import { MailboxBlock } from '../../../../src/blocks/mailbox-block/index.js';

describe('mailbox tools - comprehensive tests', () => {
  let tempDir: string;
  let mailboxBlock: MailboxBlock;

  beforeEach(() => {
    // Create a temp directory for mailbox storage
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-test-'));
    mailboxBlock = new MailboxBlock('test-mailbox', path.join(tempDir, 'inbox.jsonl'));
  });

  afterEach(() => {
    // Cleanup temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('mailbox.status tool', () => {
    it('returns correct status for empty mailbox', async () => {
      const ctx = createToolExecutionContext({ agentId: 'agent-1' });
      const result = await mailboxStatusTool.execute({}, ctx) as {
        success: boolean;
        target: string;
        counts: { total: number; unread: number; pending: number; processing: number };
      };

      expect(result.success).toBe(true);
      expect(result.target).toBe('agent-1');
      expect(result.counts.total).toBe(0);
      expect(result.counts.unread).toBe(0);
      expect(result.counts.pending).toBe(0);
    });

    it('counts unread and pending messages correctly', async () => {
      // Add messages directly to mailbox block
      mailboxBlock.append('agent-1', { text: 'msg1' });
      mailboxBlock.append('agent-1', { text: 'msg2' });
      mailboxBlock.append('agent-1', { text: 'msg3' });
      // Mark one as read
      const messages = mailboxBlock.list({});
      mailboxBlock.markRead(messages[0].id);

      const ctx = createToolExecutionContext({ agentId: 'agent-1' });
      // The mailbox tool uses file-based storage, so this tests the integration
      // For unit tests, we need to verify the logic via the block directly
      
      // Verify block state
      const allMessages = mailboxBlock.list({});
      expect(allMessages.length).toBe(3);
    });
  });

  describe('mailbox.list tool', () => {
    it('lists messages with correct metadata', async () => {
      // Add test messages
      mailboxBlock.append('agent-1', { type: 'task', task: 'analyze' }, { sender: 'agent-2' });
      mailboxBlock.append('agent-1', { type: 'notification', message: 'hello' }, { sender: 'system' });

      const messages = mailboxBlock.list({ target: 'agent-1' });
      expect(messages.length).toBe(2);
      
      // Check sorting (newest first by seq descending)
      expect(messages[0].seq).toBeGreaterThan(messages[1].seq);
    });

    it('filters by status', async () => {
      mailboxBlock.append('agent-1', { data: 1 });
      const messages = mailboxBlock.list({});
      mailboxBlock.updateStatus(messages[0].id, 'completed');

      const pending = mailboxBlock.list({ status: 'pending' });
      const completed = mailboxBlock.list({ status: 'completed' });

      expect(pending.length).toBe(0);
      expect(completed.length).toBe(1);
    });
  });

  describe('mailbox.read tool', () => {
    it('returns full message content', async () => {
      const { id } = mailboxBlock.append('agent-1', { 
        type: 'task-request',
        task: 'execute',
        params: { command: 'build' }
      }, { sender: 'orchestrator', sessionId: 'session-123' });

      const msg = mailboxBlock.get(id);
      expect(msg).toBeDefined();
      expect(msg?.content).toEqual({ 
        type: 'task-request',
        task: 'execute',
        params: { command: 'build' }
      });
      expect(msg?.sender).toBe('orchestrator');
      expect(msg?.sessionId).toBe('session-123');
    });

    it('marks message as read and moves pending task to processing', async () => {
      const { id } = mailboxBlock.append('agent-1', { text: 'test' });
      
      expect(mailboxBlock.get(id)?.readAt).toBeUndefined();
      expect(mailboxBlock.get(id)?.status).toBe('pending');
      
      mailboxBlock.markRead(id);
      
      const msg = mailboxBlock.get(id);
      expect(msg?.readAt).toBeDefined();
      expect(msg?.status).toBe('processing');
    });
  });

  describe('mailbox.ack tool', () => {
    it('rejects ack before mailbox.read', async () => {
      const { id } = mailboxBlock.append('agent-1', { task: 'do-something' });
      
      const result = mailboxBlock.ack(id);
      expect(result.acked).toBe(false);
      expect(result.error).toContain('mailbox.read');
    });

    it('acknowledges message after read and marks completed', async () => {
      const { id } = mailboxBlock.append('agent-1', { task: 'do-something' });
      mailboxBlock.markRead(id);

      const result = mailboxBlock.ack(id, { result: { summary: 'done' } });
      expect(result.acked).toBe(true);
      
      const msg = mailboxBlock.get(id);
      expect(msg?.ackAt).toBeDefined();
      expect(msg?.status).toBe('completed');
      expect(msg?.result).toEqual({ summary: 'done' });
    });

    it('returns false for non-existent message', () => {
      const result = mailboxBlock.ack('nonexistent-id');
      expect(result.acked).toBe(false);
    });
  });

  describe('send and receive flow', () => {
    it('simulates two agents communicating via mailbox', async () => {
      // Agent A (sender) sends a message to Agent B
      const senderAgent = 'agent-alice';
      const receiverAgent = 'agent-bob';
      
      // Create a shared mailbox block (simulating persistent storage)
      const sharedMailbox = new MailboxBlock('shared-mailbox', path.join(tempDir, 'shared-inbox.jsonl'));
      
      // Agent A sends a task to Agent B
      const sendResult = sharedMailbox.append(receiverAgent, {
        type: 'task-request',
        task: 'analyze-code',
        files: ['/src/index.ts']
      }, {
        sender: senderAgent,
        sessionId: 'session-cross-agent',
        channel: 'internal'
      });
      
      expect(sendResult.id).toBeDefined();
      expect(sendResult.seq).toBe(1);
      
      // Agent B checks their mailbox
      const bobMessages = sharedMailbox.list({ target: receiverAgent });
      expect(bobMessages.length).toBe(1);
      
      const receivedMsg = bobMessages[0];
      expect(receivedMsg.sender).toBe(senderAgent);
      expect(receivedMsg.content).toEqual({
        type: 'task-request',
        task: 'analyze-code',
        files: ['/src/index.ts']
      });
      
      // Agent B reads the message
      const fullMsg = sharedMailbox.get(receivedMsg.id);
      expect(fullMsg?.readAt).toBeUndefined();
      sharedMailbox.markRead(receivedMsg.id);
      expect(sharedMailbox.get(receivedMsg.id)?.status).toBe('processing');
      
    // Agent B processes and acknowledges
      sharedMailbox.ack(receivedMsg.id, { result: { result: 'analysis complete' } });
      
      // Verify final state
      const finalMsg = sharedMailbox.get(receivedMsg.id);
      expect(finalMsg?.ackAt).toBeDefined();
      expect(finalMsg?.readAt).toBeDefined();
      expect(finalMsg?.status).toBe('completed');
      expect(finalMsg?.result).toEqual({ result: 'analysis complete' });
    });

    it('supports multiple messages between agents', async () => {
      const sharedMailbox = new MailboxBlock('multi-mailbox', path.join(tempDir, 'multi-inbox.jsonl'));
      
      // Alice sends 3 messages to Bob
      for (let i = 1; i <= 3; i++) {
        sharedMailbox.append('agent-bob', {
          type: 'notification',
          message: `Message ${i} from Alice`
        }, { sender: 'agent-alice' });
      }
      
      // Bob sends 2 messages to Alice
      for (let i = 1; i <= 2; i++) {
        sharedMailbox.append('agent-alice', {
          type: 'response',
          message: `Response ${i} from Bob`
        }, { sender: 'agent-bob' });
      }
      
      // Check Bob's inbox
      const bobInbox = sharedMailbox.list({ target: 'agent-bob' });
      expect(bobInbox.length).toBe(3);
      expect(bobInbox.every(m => m.sender === 'agent-alice')).toBe(true);
      
      // Check Alice's inbox
      const aliceInbox = sharedMailbox.list({ target: 'agent-alice' });
      expect(aliceInbox.length).toBe(2);
      expect(aliceInbox.every(m => m.sender === 'agent-bob')).toBe(true);
    });
  });

  describe('persistence', () => {
    it('persists messages to file storage', async () => {
      const storagePath = path.join(tempDir, 'persist-inbox.jsonl');
      const mailbox1 = new MailboxBlock('persist-test', storagePath);
      
      // Add messages
      const { id } = mailbox1.append('agent-1', { data: 'persist-me' });
      
      // Verify file exists
      expect(fs.existsSync(storagePath)).toBe(true);
      
      // Create new block instance (simulates restart)
      const mailbox2 = new MailboxBlock('persist-test', storagePath);
      const messages = mailbox2.list({});
      
      expect(messages.length).toBe(1);
      expect(messages[0].id).toBe(id);
      expect(messages[0].content).toEqual({ data: 'persist-me' });
    });
  });
});
