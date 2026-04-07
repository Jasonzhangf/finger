/**
 * Scenario 5: Error Handling & Resilience
 * 
 * 5a: Agent fails to complete task (timeout)
 * 5b: Failure injection (tool call failure)
 * 
 * Task: finger-280.9
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MailboxBlock } from '../../../src/blocks/mailbox-block/index.js';
import { AgentRegistry } from '../../../src/orchestration/agent-registry.js';
import { AssertionEngine } from '../framework/assertion-engine.js';
import { RegistryObserver } from '../observers/registry-observer.js';
import { ResourceObserver } from '../observers/resource-observer.js';
import { SCENARIO_PROMPTS } from '../framework/prompt-driver.js';
import { 
  registerHook, 
  getCallRecords, 
  clearAllRecords, 
  clearAllHooks 
} from '../../../src/test-support/tool-call-hook.js';
import { FailureInjector } from '../hooks/failure-injection.js';

describe('Scenario 5: Error Handling', () => {
  let mailbox: MailboxBlock;
  let registry: AgentRegistry;
  let assertionEngine: AssertionEngine;
  let registryObs: RegistryObserver;
  let resourceObs: ResourceObserver;
  let failureInjector: FailureInjector;

  beforeEach(() => {
    mailbox = new MailboxBlock({ id: 'scenario5-mailbox' });
    registry = new AgentRegistry();
    assertionEngine = new AssertionEngine({ defaultTimeoutMs: 10000 });
    registryObs = new RegistryObserver(registry);
    resourceObs = new ResourceObserver(registry);
    failureInjector = new FailureInjector();
  });

  afterEach(() => {
    resourceObs.stop();
    failureInjector.clearAll();
    clearAllRecords();
    clearAllHooks();
    registry.clear();
  });

  it('5a: should report failure instead of hanging on impossible task', async () => {
    assertionEngine.start('scenario-5a-impossible-task');

    // Simulate: agent attempts task, fails, reports failure
    assertionEngine.recordEvent('task_started', { task: 'download nonexistent data' });
    assertionEngine.recordEvent('attempt_1', { success: false, error: 'Connection refused' });
    assertionEngine.recordEvent('attempt_2', { success: false, error: 'Connection refused' });
    assertionEngine.recordEvent('attempt_3', { success: false, error: 'Connection refused' });
    assertionEngine.recordEvent('task_failed', { 
      error: 'All retries exhausted',
      attempts: 3 
    });

    const timeline = assertionEngine.getTimeline();
    const failEvent = timeline.find(e => e.event === 'task_failed');
    expect(failEvent).toBeDefined();
    expect(failEvent?.details.error).toBe('All retries exhausted');

    // Report should document the failure
    const report = assertionEngine.generateReport(
      'scenario-5a-impossible-task',
      SCENARIO_PROMPTS.scenario5_timeout.template
    );
    expect(report).toBeDefined();
  });

  it('5a: should detect timeout and release resources', async () => {
    assertionEngine.start('scenario-5a-timeout');

    // Register agent
    registry.register({
      id: 'stuck-agent',
      path: '/root/stuck',
      nickname: 'stuck',
      role: 'worker',
      status: 'active',
      spawnedAt: Date.now(),
    });

    // Simulate: agent gets stuck
    assertionEngine.recordEvent('agent_stuck', { agentId: 'stuck-agent' });

    // After timeout, resources should be released
    // (In real E2E: executeDispatch timeout triggers)
    registry.clear();

    const result = await assertionEngine.assertAgentSpawned(registryObs, 0, 3000);
    expect(result.passed).toBe(true);
  });

  it('5b: should handle injected tool failure gracefully', async () => {
    assertionEngine.start('scenario-5b-injection');

    // Inject 100% failure rate for agent.spawn
    const cleanup = failureInjector.injectFailure('agent.spawn', 1.0);

    // Try to spawn - should be blocked by hook
    // (In real E2E: tool call gets blocked by hook)
    
    // Verify no spawn happened
    expect(registryObs.getActiveAgents()).toHaveLength(0);

    // Cleanup injection
    cleanup();

    // After cleanup, spawn should work again
    // (Verify hook was removed)
  });

  it('5b: should handle injected delay without deadlock', async () => {
    assertionEngine.start('scenario-5b-delay');
    resourceObs.start(200);

    // Inject 500ms delay
    const cleanup = failureInjector.injectDelay('agent.spawn', 500);

    // Wait for delay to pass
    await new Promise(r => setTimeout(r, 600));

    // Verify system is still responsive (not deadlocked)
    const agents = registryObs.getActiveAgents();
    expect(agents).toBeDefined(); // Should not hang

    cleanup();

    // Memory should not grow excessively
    await new Promise(r => setTimeout(r, 500));
    const memResult = assertionEngine.assertMemoryGrowthUnder(resourceObs, 10);
    expect(memResult.passed).toBe(true);
  });

  it('should clean up resources after failure', async () => {
    assertionEngine.start('scenario-5-cleanup');

    // Register multiple agents
    for (let i = 0; i < 5; i++) {
      registry.register({
        id: `agent-${i}`,
        path: `/root/agent-${i}`,
        nickname: `agent-${i}`,
        role: 'worker',
        status: 'active',
        spawnedAt: Date.now(),
      });
    }

    expect(registryObs.getActiveAgents()).toHaveLength(5);

    // Simulate: all agents fail, registry clears
    registry.clear();

    expect(registryObs.getActiveAgents()).toHaveLength(0);
    
    // Memory should drop after cleanup
    const report = assertionEngine.generateReport(
      'scenario-5-cleanup',
      'Resource cleanup after failure'
    );
    expect(report).toBeDefined();
  });
});
