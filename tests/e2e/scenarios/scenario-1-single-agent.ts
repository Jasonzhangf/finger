/**
 * Scenario 1: Simple Task - Single Agent
 * 
 * Prompt: "帮我分析当前 finger 项目的日志结构，列出所有模块的日志覆盖情况"
 * Expected: System Agent 直接执行，无 spawn，返回结果
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
import { getCallRecords, clearAllRecords, clearAllHooks } from '../../../src/test-support/tool-call-hook.js';
import {
  handleAgentSpawn,
  handleAgentList,
  type AgentCollabContext,
} from '../../../src/tools/internal/agent-collab-tools.js';

describe('Scenario 1: Single Agent - No Spawn', () => {
  let mailbox: MailboxBlock;
  let registry: AgentRegistry;
  let promptDriver: PromptDriver;
  let assertionEngine: AssertionEngine;
  let registryObs: RegistryObserver;
  let mailboxObs: MailboxObserver;
  let resourceObs: ResourceObserver;

  beforeEach(() => {
    mailbox = new MailboxBlock({ id: 'scenario1-mailbox' });
    registry = new AgentRegistry();
    promptDriver = new PromptDriver({ defaultTimeoutMs: 30000 });
    assertionEngine = new AssertionEngine({ defaultTimeoutMs: 15000 });
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

  it('should not spawn any child agents for simple task', async () => {
    assertionEngine.start('scenario-1-single-agent');
    resourceObs.start(500);

    // 1. Verify registry is empty initially
    expect(registryObs.getActiveAgents()).toHaveLength(0);

    // 2. For a simple task, no agent.spawn should be called
    // Simulate: System Agent processes task directly without spawn
    // (In real E2E, prompt is sent to daemon; here we test framework wiring)
    const context: AgentCollabContext = {
      registry,
      mailbox,
      currentPath: AgentPath.fromString('/root/system_agent'),
      currentId: 'system-agent-001',
      spawnAgent: async () => ({ id: 'should-not-be-called', statusProvider: async () => 'running' }),
      closeAgent: async () => {},
    };

    // 3. Call agent.list - should return empty
    const listResult = handleAgentList({}, context);
    expect(listResult.count).toBe(0);
    expect(listResult.agents).toHaveLength(0);

    // 4. Verify no spawn calls in tool call records
    const spawnRecords = getCallRecords().filter(r => r.toolName === 'agent.spawn');
    expect(spawnRecords).toHaveLength(0);

    // 5. Memory should stay flat
    const memResult = assertionEngine.assertMemoryGrowthUnder(resourceObs, 5);
    expect(memResult.passed).toBe(true);

    // 6. Generate report
    const report = assertionEngine.generateReport(
      'scenario-1-single-agent',
      SCENARIO_PROMPTS.scenario1_single_agent.template,
      resourceObs
    );
    expect(report.passed).toBe(true);
    expect(report.summary).toContain('PASSED');
  });

  it('should complete task and return result directly', async () => {
    assertionEngine.start('scenario-1-direct-execution');

    // Simulate System Agent processing directly
    // In real E2E: send prompt → wait for response → verify content
    const response = await promptDriver.sendPrompt(
      SCENARIO_PROMPTS.scenario1_single_agent.template
    );

    expect(response.status).toBe('completed');
    expect(response.durationMs).toBeGreaterThan(0);

    // Registry should still be empty (no spawn)
    expect(registryObs.getActiveAgents()).toHaveLength(0);

    const report = assertionEngine.generateReport(
      'scenario-1-direct-execution',
      SCENARIO_PROMPTS.scenario1_single_agent.template
    );
    expect(report.passed).toBe(true);
  });
});
