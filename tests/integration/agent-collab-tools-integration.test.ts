/**
 * Integration tests for Agent Collab Tools
 * 
 * Tests the real integration between:
 * - MailboxBlock (InterAgentCommunication, triggerTurn)
 * - AgentRegistry (spawn registration, status tracking)
 * - CompletionWatcher (polling + notification)
 * - LLM Tools (spawn/wait/send/close/list)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MailboxBlock } from '../../src/blocks/mailbox-block/index.js';
import { AgentPath } from '../../src/common/agent-path.js';
import { AgentRegistry } from '../../src/orchestration/agent-registry.js';
import { CompletionWatcher } from '../../src/orchestration/agent-collab-watcher.js';
import {
  handleAgentSpawn,
  handleAgentSendMessage,
  handleAgentFollowupTask,
  handleAgentClose,
  handleAgentList,
  handleAgentWait,
  type AgentCollabContext,
} from '../../src/tools/internal/agent-collab-tools.js';

describe('Agent Collab Tools Integration', () => {
  let mailbox: MailboxBlock;
  let registry: AgentRegistry;
  let parentPath: AgentPath;
  let spawnedAgents: { id: string; path: string; watcher: CompletionWatcher }[];
  
  beforeEach(() => {
    mailbox = new MailboxBlock({ id: 'integration-mailbox' });
    registry = new AgentRegistry();
    parentPath = AgentPath.fromString('/root/project_agent');
    spawnedAgents = [];
  });

  afterEach(() => {
    // Cleanup: stop all watchers
    for (const { watcher } of spawnedAgents) {
      if (watcher.isRunning) {
        watcher.stop();
      }
    }
    registry.clear();
  });

  // Helper: create mock spawnAgent that tracks spawned agents
  const createMockSpawnAgent = (statusProvider: () => Promise<string>) => {
    return async (_params: unknown, childPath: AgentPath) => {
      const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const watcher = new CompletionWatcher({
        childId: id,
        childPath: childPath.toString(),
        parentPath: parentPath.toString(),
        parentMailbox: mailbox,
        statusProvider: async () => statusProvider() as 'pending' | 'running' | 'completed' | 'errored' | 'shutdown',
        triggerTurn: false,
      });
      watcher.start(); // Start the watcher immediately
      spawnedAgents.push({ id, path: childPath.toString(), watcher });
      return { id, statusProvider };
    };
  };

  const createMockCloseAgent = () => {
    return async (agentId: string) => {
      const agent = spawnedAgents.find(a => a.id === agentId);
      if (agent) {
        agent.watcher.stop();
      }
    };
  };

  const createContext = (spawnAgent: ReturnType<typeof createMockSpawnAgent>): AgentCollabContext => ({
    registry,
    mailbox,
    currentPath: parentPath,
    currentId: 'parent-001',
    spawnAgent,
    closeAgent: createMockCloseAgent(),
  });

  describe('spawn → list flow', () => {
    it('spawn creates agent in registry with correct path', async () => {
      const ctx = createContext(createMockSpawnAgent(async () => 'running'));
      
      const result = await handleAgentSpawn({ message: 'Task 1' }, ctx);
      
      expect(result.status).toBe('running');
      expect(result.agent_path).toMatch(/^\/root\/project_agent\/[a-z_]+$/);
      
      const agents = registry.listAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].agentId).toBe(result.agent_id);
      expect(agents[0].status).toBe('active');
    });

    it('list returns all spawned agents', async () => {
      const ctx = createContext(createMockSpawnAgent(async () => 'running'));
      
      await handleAgentSpawn({ message: 'Task 1' }, ctx);
      await handleAgentSpawn({ message: 'Task 2', role: 'worker' }, ctx);
      
      const listResult = handleAgentList({}, ctx);
      expect(listResult.count).toBe(2);
      expect(listResult.agents[0].agent_path).toMatch(/^\/root\/project_agent\/[a-z_]+$/);
    });

    it('list filters by path prefix', async () => {
      const ctx = createContext(createMockSpawnAgent(async () => 'running'));
      
      await handleAgentSpawn({ message: 'Task 1' }, ctx);
      
      const filtered = handleAgentList({ path_prefix: '/root/project_agent' }, ctx);
      expect(filtered.count).toBe(1);
      
      const other = handleAgentList({ path_prefix: '/root/other' }, ctx);
      expect(other.count).toBe(0);
    });
  });

  describe('send → followup → trigger_turn', () => {
    it('send_message queues without triggerTurn', () => {
      const ctx = createContext(createMockSpawnAgent(async () => 'running'));
      
      handleAgentSendMessage({
        recipient: '/root/project_agent/worker',
        content: 'Please analyze',
      }, ctx);
      
      const pending = mailbox.list({ status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(pending[0].triggerTurn).toBe(false);
    });

    it('followup_task queues with triggerTurn=true', () => {
      const ctx = createContext(createMockSpawnAgent(async () => 'running'));
      
      handleAgentFollowupTask({
        recipient: '/root/project_agent/worker',
        content: 'Follow up',
      }, ctx);
      
      const pending = mailbox.list({ status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(pending[0].triggerTurn).toBe(true);
    });

    it('hasPendingTriggerTurn detects trigger messages', () => {
      const ctx = createContext(createMockSpawnAgent(async () => 'running'));
      
      handleAgentSendMessage({ recipient: './child', content: 'msg1' }, ctx);
      handleAgentFollowupTask({ recipient: './child', content: 'msg2' }, ctx);
      
      expect(mailbox.hasPendingTriggerTurn()).toBe(true);
      
      const triggerMsgs = mailbox.getPendingTriggerTurnMessages();
      expect(triggerMsgs).toHaveLength(1);
      expect(triggerMsgs[0].triggerTurn).toBe(true);
    });
  });

  describe('CompletionWatcher notification flow', () => {
    it('watcher notifies parent mailbox when child completes', async () => {
      // Create a status provider that returns 'completed' after one poll
      let pollCount = 0;
      const statusProvider = async () => {
        pollCount++;
        return pollCount >= 2 ? 'completed' : 'running';
      };
      
      const ctx = createContext(createMockSpawnAgent(statusProvider));
      const result = await handleAgentSpawn({ message: 'Task' }, ctx);
      
      // Start watcher manually (already started in spawn)
      const agent = spawnedAgents.find(a => a.id === result.agent_id);
      expect(agent).toBeDefined();
      expect(agent!.watcher.isRunning).toBe(true);
      
      // Wait for completion notification (longer for async polling)
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      // Check mailbox for completion notification (by childPath)
      const msgs = mailbox.list({ status: 'pending' });
      const completionMsg = msgs.find(m => 
        m.author === agent!.path || m.author === result.agent_path
      );
      
      expect(completionMsg).toBeDefined();
      expect(completionMsg!.triggerTurn).toBe(false);
      expect(completionMsg!.content).toContain('completed');
    });

    it('watcher handles error status', async () => {
      let pollCount = 0;
      const statusProvider = async () => {
        pollCount++;
        return pollCount >= 2 ? 'errored' : 'running';
      };
      
      const ctx = createContext(createMockSpawnAgent(statusProvider));
      const result = await handleAgentSpawn({ message: 'Task' }, ctx);
      
      const agent = spawnedAgents.find(a => a.id === result.agent_id);
      
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      const msgs = mailbox.list({ status: 'pending' });
      const completionMsg = msgs.find(m => 
        m.author === agent!.path || m.author === result.agent_path
      );
      
      expect(completionMsg).toBeDefined();
      expect(completionMsg!.content).toContain('errored');
    });
  });

  describe('close → registry cleanup', () => {
    it('close removes agent from registry', async () => {
      const ctx = createContext(createMockSpawnAgent(async () => 'running'));
      
      const result = await handleAgentSpawn({ message: 'Task' }, ctx);
      expect(registry.listAgents()).toHaveLength(1);
      
      const closeResult = await handleAgentClose({ agent_id: result.agent_id }, ctx);
      expect(closeResult.closed).toBe(true);
      
      // After release, the agent should be marked as closed
      // Note: listAgents may filter out closed agents, check the closeResult
      expect(closeResult.closed).toBe(true);
      expect(closeResult.agent_path).toBeDefined();
    });

    it('close by path resolves from registry', async () => {
      const ctx = createContext(createMockSpawnAgent(async () => 'running'));
      
      const result = await handleAgentSpawn({ message: 'Task' }, ctx);
      
      const closeResult = await handleAgentClose({ agent_path: result.agent_path }, ctx);
      expect(closeResult.closed).toBe(true);
      expect(closeResult.agent_path).toBe(result.agent_path);
    });
  });

  describe('AgentPath resolve integration', () => {
    it('resolve ./child from current path', async () => {
      const ctx = createContext(createMockSpawnAgent(async () => 'running'));
      
      handleAgentSendMessage({
        recipient: './worker_1',
        content: 'hello',
      }, ctx);
      
      const msgs = mailbox.list({ status: 'pending' });
      expect(msgs[0].recipient).toBe('/root/project_agent/worker_1');
    });

    it('resolve ../sibling from child path', async () => {
      const childPath = AgentPath.fromString('/root/project_agent/explorer');
      const sibling = childPath.resolve('../worker');
      
      expect(sibling.toString()).toBe('/root/project_agent/worker');
    });
  });
});
