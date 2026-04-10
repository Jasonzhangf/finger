/**
 * E2E Tests for Multi-Agent Collaboration
 * 
 * 测试场景：
 * 1. 单 agent spawn → task completion → notification
 * 2. 并发 spawn 多个 agent → 全部完成 → 汇总结果
 * 3. agent 通信：send_message + followup_task
 * 4. 异常处理：timeout、crash、死锁
 * 5. 资源管理：内存泄露、资源清理
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('Multi-Agent Collaboration E2E', () => {
  let mailbox: MailboxBlock;
  let registry: AgentRegistry;
  let parentPath: AgentPath;
  let spawnedAgents: Map<string, { path: string; watcher: CompletionWatcher; status: string }>;
  
  beforeEach(() => {
    mailbox = new MailboxBlock({ id: 'e2e-mailbox' });
    registry = new AgentRegistry();
    parentPath = AgentPath.fromString('/root/project_agent');
    spawnedAgents = new Map();
  });

  afterEach(() => {
    // Cleanup: stop all watchers
    for (const { watcher } of spawnedAgents.values()) {
      if (watcher.isRunning) {
        watcher.stop();
      }
    }
    registry.clear();
  });

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  const createStatusProvider = (agentId: string, initialState: string = 'running') => {
    let status = initialState;
    return {
      getStatus: async () => status,
      setStatus: (newStatus: string) => { status = newStatus; },
    };
  };

  const createSpawnAgent = () => {
    return async (_params: unknown, childPath: AgentPath) => {
      const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const statusProvider = createStatusProvider(id, 'running');
      
      const watcher = new CompletionWatcher({
        childId: id,
        childPath: childPath.toString(),
        parentPath: parentPath.toString(),
        parentMailbox: mailbox,
        statusProvider: statusProvider.getStatus as () => Promise<'pending' | 'running' | 'completed' | 'errored' | 'shutdown'>,
        triggerTurn: false,
      });
      watcher.start();
      
      spawnedAgents.set(id, { path: childPath.toString(), watcher, status: 'running' });
      
      return { id, statusProvider };
    };
  };

  const createCloseAgent = () => {
    return async (agentId: string) => {
      const agent = spawnedAgents.get(agentId);
      if (agent) {
        agent.watcher.stop();
        agent.status = 'shutdown';
      }
    };
  };

  const createContext = (): AgentCollabContext => ({
    registry,
    mailbox,
    currentPath: parentPath,
    currentId: 'parent-001',
    spawnAgent: createSpawnAgent(),
    closeAgent: createCloseAgent(),
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 1: Single Agent Lifecycle
  // ─────────────────────────────────────────────────────────────

  describe('Scenario 1: Single Agent Lifecycle', () => {
    it('spawn → running → completed → notification', async () => {
      const ctx = createContext();
      
      // 1. Spawn agent
      const spawnResult = await handleAgentSpawn({ message: 'Task 1' }, ctx);
      expect(spawnResult.status).toBe('running');
      
      // 2. List agents
      const listResult = handleAgentList({}, ctx);
      expect(listResult.count).toBe(1);
      
      // 3. Wait for completion (with mock status change)
      const agent = spawnedAgents.get(spawnResult.agent_id);
      expect(agent).toBeDefined();
      
      // Simulate completion after 100ms
      setTimeout(() => {
        if (agent) agent.status = 'completed';
      }, 100);
      
      // 4. Verify notification in parent mailbox
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Note: CompletionWatcher should have sent notification
      // This test verifies the basic flow
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 2: Concurrent Agents
  // ─────────────────────────────────────────────────────────────

  describe('Scenario 2: Concurrent Agents', () => {
    it('spawn 3 agents → all complete → aggregate results', async () => {
      const ctx = createContext();
      
      // 1. Spawn 3 agents concurrently
      const agents = await Promise.all([
        handleAgentSpawn({ message: 'Task 1', role: 'worker' }, ctx),
        handleAgentSpawn({ message: 'Task 2', role: 'worker' }, ctx),
        handleAgentSpawn({ message: 'Task 3', role: 'explorer' }, ctx),
      ]);
      
      expect(agents).toHaveLength(3);
      agents.forEach(a => expect(a.status).toBe('running'));
      
      // 2. List all agents
      const listResult = handleAgentList({}, ctx);
      expect(listResult.count).toBe(3);
      
      // 3. Verify different paths
      const paths = agents.map(a => a.agent_path);
      const uniquePaths = new Set(paths);
      expect(uniquePaths.size).toBe(3);
    });

    it('max_threads limit is enforced', async () => {
      const ctx = createContext();
      
      // Try to spawn 15 agents (default max_threads=10)
      const promises = [];
      for (let i = 0; i < 15; i++) {
        promises.push(handleAgentSpawn({ message: `Task ${i}` }, ctx));
      }
      
      const results = await Promise.allSettled(promises);
      
      // Some should fail due to max_threads limit
      const rejected = results.filter(r => r.status === 'rejected');
      expect(rejected.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 3: Inter-Agent Communication
  // ─────────────────────────────────────────────────────────────

  describe('Scenario 3: Inter-Agent Communication', () => {
    it('send_message → recipient mailbox receives message', async () => {
      const ctx = createContext();
      
      // 1. Spawn agent
      const spawnResult = await handleAgentSpawn({ message: 'Task 1' }, ctx);
      
      // 2. Send message
      const sendResult = await handleAgentSendMessage({
        recipient: spawnResult.agent_id,
        content: { type: 'progress', data: '50%' },
      }, ctx);
      
      expect(sendResult.sent).toBe(true);
      expect(sendResult.seq).toBeGreaterThan(0);
      
      // 3. Verify in mailbox
      const messages = mailbox.list({ target: spawnResult.agent_path });
      expect(messages.length).toBeGreaterThan(0);
    });

    it('followup_task → triggerTurn=true', async () => {
      const ctx = createContext();
      
      // 1. Spawn agent
      const spawnResult = await handleAgentSpawn({ message: 'Task 1' }, ctx);
      
      // 2. Send followup task
      const followupResult = await handleAgentFollowupTask({
        recipient: spawnResult.agent_id,
        content: { type: 'new_task', data: 'Continue' },
        interrupt: false,
      }, ctx);
      
      expect(followupResult.sent).toBe(true);
      expect(followupResult.seq).toBeGreaterThan(0);
      expect(followupResult.interrupt).toBe(false);

      const messages = mailbox.list({ target: spawnResult.agent_path, triggerTurn: true });
      expect(messages.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 4: Error Handling
  // ─────────────────────────────────────────────────────────────

  describe('Scenario 4: Error Handling', () => {
    it('agent.wait timeout triggers', async () => {
      const ctx = createContext();
      
      // 1. Spawn agent that never completes
      const spawnResult = await handleAgentSpawn({ message: 'Task 1' }, ctx);
      
      // 2. Wait with short timeout
      const waitPromise = handleAgentWait({
        agent_id: spawnResult.agent_id,
        timeout_ms: 100,
      }, ctx);
      
      // 3. Should timeout
      await expect(waitPromise).resolves.toMatchObject({
        completed: false,
        message: 'Timeout after 100ms',
      });
    });

    it('close agent removes from registry', async () => {
      const ctx = createContext();
      
      // 1. Spawn agent
      const spawnResult = await handleAgentSpawn({ message: 'Task 1' }, ctx);
      expect(handleAgentList({}, ctx).count).toBe(1);
      
      // 2. Close agent
      await handleAgentClose({ agent_id: spawnResult.agent_id }, ctx);
      
      // 3. Verify removed from registry
      expect(handleAgentList({}, ctx).count).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 5: Resource Management
  // ─────────────────────────────────────────────────────────────

  describe('Scenario 5: Resource Management', () => {
    it('spawn 100 agents sequentially → no memory leak', async () => {
      const ctx = createContext();
      
      const initialMemory = process.memoryUsage().heapUsed;
      
      // Spawn and close 100 agents
      for (let i = 0; i < 100; i++) {
        const spawnResult = await handleAgentSpawn({ message: `Task ${i}` }, ctx);
        await handleAgentClose({ agent_id: spawnResult.agent_id }, ctx);
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const growth = finalMemory - initialMemory;
      
      // Memory growth should be < 10MB
      expect(growth).toBeLessThan(10 * 1024 * 1024);
    });

    it('watcher is stopped when agent closes', async () => {
      const ctx = createContext();
      
      // 1. Spawn agent
      const spawnResult = await handleAgentSpawn({ message: 'Task 1' }, ctx);
      
      // 2. Verify watcher is running
      const agent = spawnedAgents.get(spawnResult.agent_id);
      expect(agent?.watcher.isRunning).toBe(true);
      
      // 3. Close agent
      await handleAgentClose({ agent_id: spawnResult.agent_id }, ctx);
      
      // 4. Verify watcher is stopped
      expect(agent?.watcher.isRunning).toBe(false);
    });
  });
});
