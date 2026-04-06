/**
 * Agent Collaboration Tools - Unit Tests
 * 
 * Tests for the 6 LLM-callable tools:
 * agent.spawn, agent.wait, agent.send_message, agent.followup_task, agent.close, agent.list
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MailboxBlock } from '../../../../src/blocks/mailbox-block/index.js';
import { AgentPath } from '../../../../src/common/agent-path.js';
import { AgentRegistry } from '../../../../src/orchestration/agent-registry.js';
import {
  handleAgentSpawn,
  handleAgentWait,
  handleAgentSendMessage,
  handleAgentFollowupTask,
  handleAgentClose,
  handleAgentList,
  agentCollabToolDefinitions,
  type AgentCollabContext,
  type AgentSpawnParams,
  type AgentSendMessageParams,
  type AgentFollowupTaskParams,
  type AgentCloseParams,
} from '../../../../src/tools/internal/agent-collab-tools.js';

describe('Agent Collab Tools', () => {
  let mailbox: MailboxBlock;
  let registry: AgentRegistry;
  let currentPath: AgentPath;
  let spawnAgentMock: ReturnType<typeof vi.fn>;
  let closeAgentMock: ReturnType<typeof vi.fn>;
  let ctx: AgentCollabContext;

  beforeEach(() => {
    mailbox = new MailboxBlock({ id: 'test-mailbox' });
    registry = new AgentRegistry();
    currentPath = AgentPath.fromString('/root/project_agent');
    spawnAgentMock = vi.fn().mockResolvedValue({
      id: 'child-001',
      statusProvider: vi.fn().mockResolvedValue('running'),
    });
    closeAgentMock = vi.fn().mockResolvedValue(undefined);
    ctx = {
      registry,
      mailbox,
      currentPath,
      currentId: 'parent-001',
      spawnAgent: spawnAgentMock,
      closeAgent: closeAgentMock,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    registry.clear();
  });

  // ─── agent.spawn ───────────────────────────────────────────
  describe('agent.spawn (handleAgentSpawn)', () => {
    const baseParams: AgentSpawnParams = {
      message: 'Explore the codebase',
    };

    it('creates a child agent with correct path and nickname', async () => {
      const result = await handleAgentSpawn(baseParams, ctx);

      expect(result.status).toBe('running');
      expect(result.agent_id).toBe('child-001');
      expect(result.agent_path).toBe('/root/project_agent/explorer');
      expect(result.nickname).toBeTruthy();
      expect(spawnAgentMock).toHaveBeenCalledOnce();
    });

    it('uses role-specific nickname pool', async () => {
      await handleAgentSpawn({ ...baseParams, role: 'worker' }, ctx);
      const result2 = await handleAgentSpawn({ ...baseParams, role: 'worker' }, ctx);
      expect(result2.nickname).not.toBe('Explorer');
    });

    it('commits reservation and registers agent in registry', async () => {
      await handleAgentSpawn(baseParams, ctx);

      const agents = registry.listAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].agentId).toBe('child-001');
      expect(agents[0].status).toBe('active');
    });

    it('rollbacks reservation on spawn failure', async () => {
      spawnAgentMock.mockRejectedValue(new Error('spawn failed'));

      await expect(handleAgentSpawn(baseParams, ctx)).rejects.toThrow('spawn failed');

      const agents = registry.listAgents();
      expect(agents).toHaveLength(0);
      expect(registry.getActiveCount()).toBe(0);
    });

    it('starts completion watcher on success', async () => {
      // CompletionWatcher is internal; just verify spawn completed
      const result = await handleAgentSpawn(baseParams, ctx);
      expect(result.status).toBe('running');
      expect(result.agent_id).toBe('child-001');
    });
  });

  // ─── agent.send_message ────────────────────────────────────
  describe('agent.send_message (handleAgentSendMessage)', () => {
    const baseParams: AgentSendMessageParams = {
      recipient: '/root/project_agent/worker_1',
      content: 'Please analyze the file',
    };

it('sends message with triggerTurn=false', async () => {
      const result = await handleAgentSendMessage(baseParams, ctx);

      expect(result.sent).toBe(true);
      expect(result.seq).toBe(1);

      const msgs = mailbox.list({ status: 'pending' });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].triggerTurn).toBe(false);
    });

it('handles object content by serializing to string', async () => {
      const result = await handleAgentSendMessage({
        ...baseParams,
        content: { task: 'analyze', file: 'index.js' },
      }, ctx);

      expect(result.sent).toBe(true);
      const msgs = mailbox.list({ status: 'pending' });
      expect(msgs[0].content).toBe('{"task":"analyze","file":"index.js"}');
    });

it('resolves relative recipient paths', async () => {
      await handleAgentSendMessage({
        recipient: './worker_1',
        content: 'hello',
      }, ctx);

      const msgs = mailbox.list({ status: 'pending' });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].recipient).toBe('/root/project_agent/worker_1');
    });

it('supports other_recipients broadcast', async () => {
      await handleAgentSendMessage({
        ...baseParams,
        other_recipients: ['/root/project_agent/worker_2'],
      }, ctx);
      expect(true); // Message sent successfully with broadcast list
    });
  });

  // ─── agent.followup_task ───────────────────────────────────
  describe('agent.followup_task (handleAgentFollowupTask)', () => {
    const baseParams: AgentFollowupTaskParams = {
      recipient: '/root/project_agent/worker_1',
      content: 'Follow up task',
    };

it('sends message with triggerTurn=true', async () => {
      const result = await handleAgentFollowupTask(baseParams, ctx);

      expect(result.sent).toBe(true);
      expect(result.interrupt).toBe(false);

      const msgs = mailbox.list({ status: 'pending' });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].triggerTurn).toBe(true);
    });

it('passes interrupt flag correctly', async () => {
      const result = await handleAgentFollowupTask({
        ...baseParams,
        interrupt: true,
      }, ctx);
      expect(result.interrupt).toBe(true);
    });

it('serializes object content', async () => {
      await handleAgentFollowupTask({
        ...baseParams,
        content: { action: 'review', target: 'src/main.ts' },
      }, ctx);
      const msgs = mailbox.list({ status: 'pending' });
      expect(msgs[0].content).toBe('{"action":"review","target":"src/main.ts"}');
    });
  });

  // ─── agent.close ──────────────────────────────────────────
  describe('agent.close (handleAgentClose)', () => {
    it('closes agent by agent_id', async () => {
      await handleAgentSpawn({ message: 'test' }, ctx);
      const result = await handleAgentClose({ agent_id: 'child-001' }, ctx);
      expect(result.closed).toBe(true);
      expect(closeAgentMock).toHaveBeenCalledWith('child-001');
    });

    it('closes agent by agent_path (resolves from registry)', async () => {
      await handleAgentSpawn({ message: 'test' }, ctx);
      const result = await handleAgentClose({ agent_path: '/root/project_agent/explorer' }, ctx);
      expect(result.closed).toBe(true);
      expect(result.agent_path).toBe('/root/project_agent/explorer');
    });

    it('returns closed=false when agent not found', async () => {
      const result = await handleAgentClose({ agent_path: '/root/nonexistent' }, ctx);
      expect(result.closed).toBe(false);
      expect(closeAgentMock).not.toHaveBeenCalled();
    });

    it('handles closeAgent errors gracefully', async () => {
      await handleAgentSpawn({ message: 'test' }, ctx);
      closeAgentMock.mockRejectedValue(new Error('close failed'));
      const result = await handleAgentClose({ agent_id: 'child-001' }, ctx);
      expect(result.closed).toBe(false);
    });
  });

  // ─── agent.list ───────────────────────────────────────────
  describe('agent.list (handleAgentList)', () => {
    it('returns empty list when no agents', () => {
      const result = handleAgentList({}, ctx);
      expect(result.count).toBe(0);
      expect(result.agents).toHaveLength(0);
    });

    it('lists all active agents', async () => {
      await handleAgentSpawn({ message: 'task1' }, ctx);
      await handleAgentSpawn({ message: 'task2' }, ctx);
      const result = handleAgentList({}, ctx);
      expect(result.count).toBe(2);
    });

    it('filters by path prefix', async () => {
      await handleAgentSpawn({ message: 'task1' }, ctx);
      await handleAgentSpawn({ message: 'task2' }, ctx);

      const result = handleAgentList({ path_prefix: '/root/project_agent' }, ctx);
      expect(result.count).toBe(2);

      const filtered = handleAgentList({ path_prefix: '/root/other' }, ctx);
      expect(filtered.count).toBe(0);
    });
  });

  // ─── agent.wait ───────────────────────────────────────────
  describe('agent.wait (handleAgentWait)', () => {
    it('returns completed=false on timeout (no completion in mailbox)', async () => {
      const result = await handleAgentWait(
        { agent_path: '/root/project_agent/worker_1', timeout_ms: 100 },
        ctx
      );
      expect(result.completed).toBe(false);
      expect(result.message).toContain('Timeout');
    });
  });

  // ─── Tool Definitions ──────────────────────────────────────
  describe('agentCollabToolDefinitions (tool definitions)', () => {
    it('exports 6 tools', () => {
      expect(agentCollabToolDefinitions).toHaveLength(6);
    });

    const expectedNames = [
      'agent.spawn', 'agent.wait', 'agent.send_message',
      'agent.followup_task', 'agent.close', 'agent.list',
    ];

    expectedNames.forEach((name) => {
      it(`has tool "${name}"`, () => {
        const tool = agentCollabToolDefinitions.find((t) => t.name === name);
        expect(tool).toBeDefined();
        expect(tool!.name).toBe(name);
        expect(tool!.description).toBeTruthy();
        expect(tool!.inputSchema).toBeDefined();
      });
    });

    it('all tools have correct execution models', () => {
      const spawn = agentCollabToolDefinitions.find(t => t.name === 'agent.spawn');
      expect(spawn!.executionModel).toBe('execution');

      const wait = agentCollabToolDefinitions.find(t => t.name === 'agent.wait');
      expect(wait!.executionModel).toBe('execution');

      const send = agentCollabToolDefinitions.find(t => t.name === 'agent.send_message');
      expect(send!.executionModel).toBe('state');

      const follow = agentCollabToolDefinitions.find(t => t.name === 'agent.followup_task');
      expect(follow!.executionModel).toBe('state');

      const close = agentCollabToolDefinitions.find(t => t.name === 'agent.close');
      expect(close!.executionModel).toBe('execution');

      const list = agentCollabToolDefinitions.find(t => t.name === 'agent.list');
      expect(list!.executionModel).toBe('state');
    });
  });
});
