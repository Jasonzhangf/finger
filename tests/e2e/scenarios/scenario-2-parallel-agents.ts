/**
 * Scenario 2: Complex Task - Parallel Agents
 * 
 * Prompt: "帮我对 finger 项目进行代码审查：
 *   1. 分析 `src/blocks/` 的测试覆盖率
 *   2. 检查 `src/orchestration/` 的内存泄露隐患
 *   3. 审查 `src/tools/internal/` 工具实现
 *   请同时开始这三项审查"
 * 
 * Expected: System Agent spawns 2 workers, 3 agents run in parallel
 * 
 * Task: finger-280.8
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MailboxBlock } from '../../../src/blocks/mailbox-block/index.js';
import { AgentRegistry } from '../../../src/orchestration/agent-registry.js';
import { AgentPath } from '../../../src/common/agent-path.js';
import { PromptDriver, SCENARIO_PROMPTS } from '../framework/prompt-driver.js';
import { AssertionEngine } from '../framework/assertion-engine.js';
import { RegistryObserver } from '../observers/registry-observer.js';
import { MailboxObserver } from '../observers/mailbox-observer.js';
import { ResourceObserver } from '../observers/resource-observer.js';
import { LedgerObserver } from '../observers/ledger-observer.js';
import { 
  registerHook, 
  getCallRecords, 
  clearAllRecords, 
  clearAllHooks,
  type ToolCallHook 
} from '../../../src/test-support/tool-call-hook.js';
import {
  handleAgentSpawn,
  handleAgentList,
  handleAgentWait,
  type AgentCollabContext,
  type SpawnResult,
} from '../../../src/tools/internal/agent-collab-tools.js';
import { FailureInjector } from '../hooks/failure-injection.js';

describe('Scenario 2: Parallel Agents', () => {
  let mailbox: MailboxBlock;
  let registry: AgentRegistry;
  let promptDriver: PromptDriver;
  let assertionEngine: AssertionEngine;
  let registryObs: RegistryObserver;
  let mailboxObs: MailboxObserver;
  let resourceObs: ResourceObserver;

  beforeEach(() => {
    mailbox = new MailboxBlock({ id: 'scenario2-mailbox' });
    registry = new AgentRegistry();
    promptDriver = new PromptDriver({ defaultTimeoutMs: 60000 });
    assertionEngine = new AssertionEngine({ defaultTimeoutMs: 30000 });
    registryObs = new RegistryObserver(registry);
    mailboxObs = new MailboxObserver(mailbox, 'finger-system-agent');
    resourceObs = new ResourceObserver(registry);
  });

  afterEach(() => {
    resourceObs.stop();
    clearAllRecords();
    clearAllHooks();
    registry.clear();
  });

  it('should spawn 2 child agents for complex task', async () => {
    assertionEngine.start('scenario-2-spawn');
    resourceObs.start(500);

    const context: AgentCollabContext = {
      registry,
      mailbox,
      currentPath: AgentPath.fromString('/root/system_agent'),
      currentId: 'system-agent-001',
      spawnAgent: async (opts): Promise<SpawnResult> => {
        const id = `worker-${Date.now()}`;
        const path = AgentPath.fromString('/root/system_agent/worker');
        
        // Register in registry
        registry.register({
          id,
          path: path.toString(),
          nickname: opts.nickname ?? `worker-${id}`,
          role: opts.role ?? 'worker',
          status: 'active',
          spawnedAt: Date.now(),
          parentId: 'system-agent-001',
        });
        
        return { id, statusProvider: async () => 'running' };
      },
      closeAgent: async () => {},
    };

    // 1. Spawn worker-1
    const spawn1 = handleAgentSpawn({
      role: 'worker',
      nickname: 'blocks-coverage',
    }, context);
    expect(spawn1.id).toBeDefined();

    // 2. Spawn worker-2
    const spawn2 = handleAgentSpawn({
      role: 'worker',
      nickname: 'orchestration-memory',
    }, context);
    expect(spawn2.id).toBeDefined();

    // 3. Assert 2 agents spawned
    const spawnResult = await assertionEngine.assertAgentSpawned(registryObs, 2, 5000);
    expect(spawnResult.passed).toBe(true);

    // 4. Verify tool call records
    const spawnRecords = getCallRecords().filter(r => r.toolName === 'agent.spawn');
    expect(spawnRecords).toHaveLength(2);

    // 5. Memory growth should be reasonable
    await new Promise(r => setTimeout(r, 1000)); // Wait for resource sampling
    const memResult = assertionEngine.assertMemoryGrowthUnder(resourceObs, 10);
    expect(memResult.passed).toBe(true);

    const report = assertionEngine.generateReport(
      'scenario-2-spawn',
      SCENARIO_PROMPTS.scenario2_parallel_agents.template,
      resourceObs
    );
    expect(report.passed).toBe(true);
  });

  it('should run agents concurrently', async () => {
    assertionEngine.start('scenario-2-concurrent');

    // Setup: register 3 agents (1 parent + 2 children)
    registry.register({
      id: 'parent-001',
      path: '/root/system_agent',
      nickname: 'system-agent',
      role: 'system',
      status: 'active',
      spawnedAt: Date.now(),
    });

    registry.register({
      id: 'worker-001',
      path: '/root/system_agent/worker-1',
      nickname: 'blocks-coverage',
      role: 'worker',
      status: 'active',
      spawnedAt: Date.now(),
      parentId: 'parent-001',
    });

    registry.register({
      id: 'worker-002',
      path: '/root/system_agent/worker-2',
      nickname: 'orchestration-memory',
      role: 'worker',
      status: 'active',
      spawnedAt: Date.now(),
      parentId: 'parent-001',
    });

    // Assert concurrent execution
    const result = await assertionEngine.assertConcurrentExecution(registryObs, 2, 5000);
    expect(result.passed).toBe(true);

    const report = assertionEngine.generateReport(
      'scenario-2-concurrent',
      SCENARIO_PROMPTS.scenario2_parallel_agents.template
    );
    expect(report.assertions).toHaveLength(1);
  });

  it('should send completion notifications to parent mailbox', async () => {
    assertionEngine.start('scenario-2-completion');

    // Setup: register child agent
    registry.register({
      id: 'worker-001',
      path: '/root/system_agent/worker-1',
      nickname: 'test-worker',
      role: 'worker',
      status: 'completed',
      spawnedAt: Date.now(),
      parentId: 'parent-001',
    });

    // Simulate completion notification
    mailbox.sendAgentCompletion({
      childId: 'worker-001',
      childPath: '/root/system_agent/worker-1',
      parentPath: '/root/system_agent',
      status: 'completed',
      triggerTurn: false,
    });

    // Assert notification received
    const result = await assertionEngine.assertCompletionReceived(mailboxObs, 'worker-001', 5000);
    expect(result.passed).toBe(true);
  });

  it('should enforce max_threads limit', async () => {
    const smallRegistry = new AgentRegistry({ maxThreads: 2 });
    
    // Register 2 agents (at limit)
    smallRegistry.register({
      id: 'worker-001',
      path: '/root/w1',
      nickname: 'w1',
      role: 'worker',
      status: 'active',
      spawnedAt: Date.now(),
    });
    
    smallRegistry.register({
      id: 'worker-002',
      path: '/root/w2',
      nickname: 'w2',
      role: 'worker',
      status: 'active',
      spawnedAt: Date.now(),
    });

    // Try to spawn 3rd - should fail
    const context: AgentCollabContext = {
      registry: smallRegistry,
      mailbox,
      currentPath: AgentPath.fromString('/root'),
      currentId: 'parent',
      spawnAgent: async () => {
        // This should not be called
        throw new Error('Should not reach here');
      },
      closeAgent: async () => {},
    };

    // max_threads=2, already have 2, spawn should fail
    expect(() => {
      smallRegistry.reserveSpawnSlot({ maxThreads: 2 });
    }).toThrow();

    smallRegistry.clear();
  });
});
