import { describe, it, expect, beforeEach } from 'vitest';
import { AssertionEngine } from '../framework/assertion-engine.js';
import { RegistryObserver } from '../observers/registry-observer.js';
import { MailboxObserver } from '../observers/mailbox-observer.js';
import { clearAllHooks } from '../../../src/test-support/tool-call-hook.js';

class TestRegistry {
  private agents = new Map<string, any>();
  register(meta: any) { this.agents.set(meta.id, meta); }
  clear() { this.agents.clear(); }
  listAgents() { return Array.from(this.agents.values()); }
}

class TestMailbox {
  private messages: any[] = [];
  private nextSeq = 1;
  sendInterAgent(msg: any) { this.messages.push({ seq: this.nextSeq++, ...msg, payload: { ...msg, category: 'inter_agent', triggerTurn: msg.triggerTurn } }); }
  list() { return this.messages; }
  subscribeToSeq() { return Promise.resolve(); }
}

describe('Scenario 4: Inter-Agent Communication', () => {
  let mailbox: TestMailbox;
  let registry: TestRegistry;
  let assertionEngine: AssertionEngine;
  let registryObs: RegistryObserver;
  let mailboxObs: MailboxObserver;

  beforeEach(() => {
    mailbox = new TestMailbox();
    registry = new TestRegistry();
    assertionEngine = new AssertionEngine({ defaultTimeoutMs: 30000 });
    registryObs = new RegistryObserver(registry as any);
    mailboxObs = new MailboxObserver(mailbox as any, 'finger-system-agent');
    clearAllHooks();
  });

  it('should spawn 2 agents for different projects', async () => {
    assertionEngine.start('scenario-4-spawn');

    registry.register({ id: 'webauto-agent', path: '/root/webauto', nickname: 'webauto', role: 'worker', status: 'active', spawnedAt: Date.now() });
    registry.register({ id: 'heartbeat-agent', path: '/root/heartbeat', nickname: 'heartbeat', role: 'worker', status: 'active', spawnedAt: Date.now() });

    const result = await assertionEngine.assertAgentSpawned(registryObs, 2, 5000);
    expect(result.passed).toBe(true);
  });

  it('should receive InterAgentCommunication from both agents', async () => {
    assertionEngine.start('scenario-4-iac');
    mailboxObs.start();

    mailbox.sendInterAgent({ from: 'webauto-agent', to: 'system-agent', content: 'WebAuto healthy', triggerTurn: false });
    mailbox.sendInterAgent({ from: 'heartbeat-agent', to: 'system-agent', content: 'Heartbeat RUNNING', triggerTurn: false });

    const messages = mailboxObs.getNewMessages();
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const iacMessages = messages.filter(m => m.payload?.category === 'inter_agent');
    expect(iacMessages.length).toBe(2);
  });

  it('should aggregate results', async () => {
    assertionEngine.start('scenario-4-aggregation');

    assertionEngine.recordEvent('child_1_result', { agentId: 'webauto-agent', status: 'healthy' });
    assertionEngine.recordEvent('child_2_result', { agentId: 'heartbeat-agent', status: 'healthy' });
    assertionEngine.recordEvent('aggregation_complete', { totalAgents: 2, healthyCount: 2 });

    const timeline = assertionEngine.getTimeline();
    expect(timeline.filter(e => e.event.startsWith('child_')).length).toBe(2);
  });

  it('should handle trigger_turn correctly', async () => {
    assertionEngine.start('scenario-4-trigger-turn');
    mailboxObs.start();

    mailbox.sendInterAgent({ from: 'worker-1', to: 'system-agent', content: 'Status update', triggerTurn: false });
    mailbox.sendInterAgent({ from: 'worker-2', to: 'system-agent', content: 'Task result', triggerTurn: true });

    const messages = mailboxObs.getNewMessages();

    const noTriggerMsg = messages.find(m => m.payload?.from === 'worker-1' && m.payload?.category === 'inter_agent');
    const triggerMsg = messages.find(m => m.payload?.from === 'worker-2' && m.payload?.category === 'inter_agent');

    expect(noTriggerMsg?.payload?.triggerTurn).toBe(false);
    expect(triggerMsg?.payload?.triggerTurn).toBe(true);
  });
});
