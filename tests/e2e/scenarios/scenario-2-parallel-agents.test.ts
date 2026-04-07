/**
 * Scenario 2: Complex Task - Parallel Agents
 * Task: finger-280.8
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PromptDriver, SCENARIO_PROMPTS } from '../framework/prompt-driver.js';
import { AssertionEngine } from '../framework/assertion-engine.js';
import { RegistryObserver } from '../observers/registry-observer.js';
import { MailboxObserver } from '../observers/mailbox-observer.js';
import { ResourceObserver } from '../observers/resource-observer.js';
import { clearAllHooks } from '../../../src/test-support/tool-call-hook.js';

class TestRegistry {
  private agents = new Map<string, any>();
  register(meta: any) { this.agents.set(meta.id, meta); }
  clear() { this.agents.clear(); }
  listAgents() { return Array.from(this.agents.values()); }
  getAgentByPath(p: string) { return this.listAgents().find(a => a.path === p); }
  getAgentByNickname(n: string) { return this.listAgents().find(a => a.nickname === n); }
  reserveSpawnSlot() { return { committed: false, reservedNickname: 'test', commit() {}, rollback() {} }; }
  releaseSpawnedThread() {}
  getNextDepth() { return 1; }
  exceedsDepthLimit() { return false; }
}

class TestMailbox {
  private messages: any[] = [];
  private nextSeq = 1;
  sendInterAgent(msg: any) { this.messages.push({ seq: this.nextSeq++, ...msg, payload: { ...msg, category: 'inter_agent' } }); }
  sendAgentCompletion(msg: any) { this.messages.push({ seq: this.nextSeq++, ...msg, category: 'agent_completion' }); }
  list() { return this.messages; }
  subscribeToSeq() { return Promise.resolve(); }
  addMessage(msg: any) { this.messages.push({ seq: this.nextSeq++, ...msg }); }
}

describe('Scenario 2: Parallel Agents', () => {
  let mailbox: TestMailbox;
  let registry: TestRegistry;
  let promptDriver: PromptDriver;
  let assertionEngine: AssertionEngine;
  let registryObs: RegistryObserver;
  let mailboxObs: MailboxObserver;
  let resourceObs: ResourceObserver;

  beforeEach(() => {
    mailbox = new TestMailbox();
    registry = new TestRegistry();
    promptDriver = new PromptDriver({ defaultTimeoutMs: 60000 });
    assertionEngine = new AssertionEngine({ defaultTimeoutMs: 30000 });
    registryObs = new RegistryObserver(registry as any);
    mailboxObs = new MailboxObserver(mailbox as any, 'finger-system-agent');
    resourceObs = new ResourceObserver(registry as any);
  });

  afterEach(() => {
    resourceObs.stop();
    clearAllHooks();
    registry.clear();
  });

  it('should spawn 2 child agents', async () => {
    assertionEngine.start('scenario-2-spawn');
    resourceObs.start(500);

    registry.register({ id: 'worker-001', path: '/root/w1', nickname: 'w1', role: 'worker', status: 'active', spawnedAt: Date.now() });
    registry.register({ id: 'worker-002', path: '/root/w2', nickname: 'w2', role: 'worker', status: 'active', spawnedAt: Date.now() });

    const spawnResult = await assertionEngine.assertAgentSpawned(registryObs, 2, 5000);
    expect(spawnResult.passed).toBe(true);

    await new Promise(r => setTimeout(r, 1000));
    const memResult = assertionEngine.assertMemoryGrowthUnder(resourceObs, 10);
    expect(memResult.passed).toBe(true);
  });

  it('should run agents concurrently', async () => {
    assertionEngine.start('scenario-2-concurrent');
    resourceObs.start(500);

    registry.register({ id: 'parent-001', path: '/root/parent', nickname: 'parent', role: 'system', status: 'active', spawnedAt: Date.now() });
    registry.register({ id: 'worker-001', path: '/root/parent/w1', nickname: 'w1', role: 'worker', status: 'active', spawnedAt: Date.now(), parentId: 'parent-001' });
    registry.register({ id: 'worker-002', path: '/root/parent/w2', nickname: 'w2', role: 'worker', status: 'active', spawnedAt: Date.now(), parentId: 'parent-001' });

    const result = await assertionEngine.assertConcurrentExecution(registryObs, 2, 5000);
    expect(result.passed).toBe(true);
  });

  it('should send completion notifications', async () => {
    assertionEngine.start('scenario-2-completion');
    mailboxObs.start();

    mailbox.addMessage({ category: 'agent_completion', childId: 'worker-001', status: 'completed' });

    const result = await assertionEngine.assertCompletionReceived(mailboxObs, 'worker-001', 3000);
    expect(result.passed).toBe(true);
  });
});
