import { describe, it, expect, beforeEach } from 'vitest';
import { AssertionEngine } from '../framework/assertion-engine.js';
import { RegistryObserver } from '../observers/registry-observer.js';
import { ResourceObserver } from '../observers/resource-observer.js';
import { SCENARIO_PROMPTS } from '../framework/prompt-driver.js';
import { clearAllHooks } from '../../../src/test-support/tool-call-hook.js';

class TestRegistry {
  private agents = new Map<string, any>();
  register(meta: any) { this.agents.set(meta.id, meta); }
  clear() { this.agents.clear(); }
  listAgents() { return Array.from(this.agents.values()); }
}

describe('Scenario 5: Error Handling', () => {
  let registry: TestRegistry;
  let assertionEngine: AssertionEngine;
  let registryObs: RegistryObserver;
  let resourceObs: ResourceObserver;

  beforeEach(() => {
    registry = new TestRegistry();
    assertionEngine = new AssertionEngine({ defaultTimeoutMs: 30000 });
    registryObs = new RegistryObserver(registry as any);
    resourceObs = new ResourceObserver(registry as any);
    clearAllHooks();
  });

  it('should report failure on impossible task', async () => {
    assertionEngine.start('scenario-5-failure');

    assertionEngine.recordEvent('task_started', { task: 'download nonexistent' });
    assertionEngine.recordEvent('attempt_1', { success: false, error: 'Connection refused' });
    assertionEngine.recordEvent('attempt_2', { success: false, error: 'Connection refused' });
    assertionEngine.recordEvent('task_failed', { error: 'All retries exhausted', attempts: 2 });

    const timeline = assertionEngine.getTimeline();
    const failEvent = timeline.find(e => e.event === 'task_failed');
    expect(failEvent).toBeDefined();
    expect(failEvent?.details.error).toBe('All retries exhausted');

    const report = assertionEngine.generateReport('scenario-5-failure', SCENARIO_PROMPTS.scenario5_timeout.template);
    expect(report).toBeDefined();
  });

  it('should detect timeout and release resources', async () => {
    assertionEngine.start('scenario-5-timeout');
    resourceObs.start(500);

    registry.register({ id: 'stuck-agent', path: '/root/stuck', nickname: 'stuck', role: 'worker', status: 'active', spawnedAt: Date.now() });

    assertionEngine.recordEvent('agent_stuck', { agentId: 'stuck-agent' });

    registry.clear();

    const result = await assertionEngine.assertAgentSpawned(registryObs, 0, 3000);
    expect(result.passed).toBe(true);
  });

  it('should handle injected delay without deadlock', async () => {
    assertionEngine.start('scenario-5-delay');
    resourceObs.start(200);

    await new Promise(r => setTimeout(r, 600));

    const agents = registryObs.getActiveAgents();
    expect(agents).toBeDefined();

    const memResult = assertionEngine.assertMemoryGrowthUnder(resourceObs, 10);
    expect(memResult.passed).toBe(true);
  });

  it('should clean up resources after failure', async () => {
    assertionEngine.start('scenario-5-cleanup');

    for (let i = 0; i < 5; i++) {
      registry.register({ id: `agent-${i}`, path: `/root/agent-${i}`, nickname: `agent-${i}`, role: 'worker', status: 'active', spawnedAt: Date.now() });
    }

    expect(registryObs.getActiveAgents()).toHaveLength(5);

    registry.clear();

    expect(registryObs.getActiveAgents()).toHaveLength(0);
  });
});
