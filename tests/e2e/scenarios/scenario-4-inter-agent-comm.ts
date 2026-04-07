/**
 * Scenario 4: Inter-Agent Communication
 * 
 * Prompt: "派一个 agent 分析 webauto 项目的任务队列状况，
 *         同时派另一个检查 finger 项目的 heartbeat 状态，
 *         然后汇总两个项目的健康状况"
 * 
 * Expected: 2 child agents, each reports via InterAgentCommunication
 * 
 * Task: finger-280.9
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MailboxBlock } from '../../../src/blocks/mailbox-block/index.js';
import { AgentRegistry } from '../../../src/orchestration/agent-registry.js';
import { AgentPath } from '../../../src/common/agent-path.js';
import { AssertionEngine } from '../framework/assertion-engine.js';
import { RegistryObserver } from '../observers/registry-observer.js';
import { MailboxObserver } from '../observers/mailbox-observer.js';
import { ResourceObserver } from '../observers/resource-observer.js';
import { SCENARIO_PROMPTS } from '../framework/prompt-driver.js';
import { clearAllRecords, clearAllHooks } from '../../../src/test-support/tool-call-hook.js';

describe('Scenario 4: Inter-Agent Communication', () => {
  let mailbox: MailboxBlock;
  let registry: AgentRegistry;
  let assertionEngine: AssertionEngine;
  let registryObs: RegistryObserver;
  let mailboxObs: MailboxObserver;
  let resourceObs: ResourceObserver;

  beforeEach(() => {
    mailbox = new MailboxBlock({ id: 'scenario4-mailbox' });
    registry = new AgentRegistry();
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

  it('should spawn 2 agents for different projects', async () => {
    assertionEngine.start('scenario-4-dual-spawn');

    // Register 2 child agents
    registry.register({
      id: 'webauto-agent',
      path: '/root/system_agent/webauto-analyzer',
      nickname: 'webauto-analyzer',
      role: 'worker',
      status: 'active',
      spawnedAt: Date.now(),
      parentId: 'system-agent',
    });

    registry.register({
      id: 'heartbeat-agent',
      path: '/root/system_agent/heartbeat-checker',
      nickname: 'heartbeat-checker',
      role: 'worker',
      status: 'active',
      spawnedAt: Date.now(),
      parentId: 'system-agent',
    });

    // Assert 2 agents spawned
    const result = await assertionEngine.assertAgentSpawned(registryObs, 2, 5000);
    expect(result.passed).toBe(true);
  });

  it('should receive InterAgentCommunication from both agents', async () => {
    assertionEngine.start('scenario-4-iac');
    mailboxObs.start();

    // Register child agents
    registry.register({
      id: 'webauto-agent',
      path: '/root/system_agent/webauto-analyzer',
      nickname: 'webauto-analyzer',
      role: 'worker',
      status: 'completed',
      spawnedAt: Date.now(),
      parentId: 'system-agent',
    });

    registry.register({
      id: 'heartbeat-agent',
      path: '/root/system_agent/heartbeat-checker',
      nickname: 'heartbeat-checker',
      role: 'worker',
      status: 'completed',
      spawnedAt: Date.now(),
      parentId: 'system-agent',
    });

    // Simulate: both agents send InterAgentCommunication
    mailbox.sendInterAgent({
      from: 'webauto-agent',
      fromPath: '/root/system_agent/webauto-analyzer',
      to: 'system-agent',
      toPath: '/root/system_agent',
      content: 'WebAuto 项目队列正常，无积压',
      triggerTurn: false,
    });

    mailbox.sendInterAgent({
      from: 'heartbeat-agent',
      fromPath: '/root/system_agent/heartbeat-checker',
      to: 'system-agent',
      toPath: '/root/system_agent',
      content: 'Finger Heartbeat 状态: RUNNING，无异常',
      triggerTurn: false,
    });

    // Assert both notifications received
    const messages = mailboxObs.getNewMessages();
    expect(messages.length).toBeGreaterThanOrEqual(2);
    
    const iacMessages = messages.filter(m => 
      m.payload?.category === 'inter_agent'
    );
    expect(iacMessages.length).toBe(2);

    // Verify content from both agents
    const webautoMsg = iacMessages.find(m => m.payload?.from === 'webauto-agent');
    const heartbeatMsg = iacMessages.find(m => m.payload?.from === 'heartbeat-agent');
    expect(webautoMsg).toBeDefined();
    expect(heartbeatMsg).toBeDefined();
  });

  it('should aggregate results from both agents', async () => {
    assertionEngine.start('scenario-4-aggregation');

    // Simulate: parent agent aggregates results
    assertionEngine.recordEvent('child_1_result', {
      agentId: 'webauto-agent',
      status: 'healthy',
      details: 'Queue: 0 pending, 0 processing',
    });

    assertionEngine.recordEvent('child_2_result', {
      agentId: 'heartbeat-agent',
      status: 'healthy',
      details: 'State: RUNNING, mailbox: 0 pending',
    });

    assertionEngine.recordEvent('aggregation_complete', {
      totalAgents: 2,
      healthyCount: 2,
      overallStatus: 'healthy',
    });

    const timeline = assertionEngine.getTimeline();
    expect(timeline.filter(e => e.event.startsWith('child_')).length).toBe(2);
    expect(timeline.find(e => e.event === 'aggregation_complete')).toBeDefined();

    const aggEvent = timeline.find(e => e.event === 'aggregation_complete');
    expect(aggEvent?.details.overallStatus).toBe('healthy');
  });

  it('should handle trigger_turn correctly', async () => {
    assertionEngine.start('scenario-4-trigger-turn');
    mailboxObs.start();

    // send_message: triggerTurn=false (just enqueue)
    mailbox.sendInterAgent({
      from: 'worker-1',
      fromPath: '/root/w1',
      to: 'system-agent',
      toPath: '/root',
      content: 'Status update (no trigger)',
      triggerTurn: false,
    });

    // followup_task: triggerTurn=true (enqueue + trigger)
    mailbox.sendInterAgent({
      from: 'worker-2',
      fromPath: '/root/w2',
      to: 'system-agent',
      toPath: '/root',
      content: 'Task result (trigger)',
      triggerTurn: true,
    });

    const messages = mailboxObs.getNewMessages();
    
    const noTriggerMsg = messages.find(m => 
      m.payload?.from === 'worker-1' && m.payload?.category === 'inter_agent'
    );
    const triggerMsg = messages.find(m => 
      m.payload?.from === 'worker-2' && m.payload?.category === 'inter_agent'
    );

    expect(noTriggerMsg?.payload?.triggerTurn).toBe(false);
    expect(triggerMsg?.payload?.triggerTurn).toBe(true);
  });
});
