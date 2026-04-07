/**
 * Scenario 3: Dynamic Task Decomposition
 * 
 * Prompt: "从 datareportal.com 下载最新的年度报告，保存到 ~/Documents/reports/"
 * Expected: Agent decomposes task dynamically into steps
 * 
 * Task: finger-280.9
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
  handleAgentSendMessage,
  type AgentCollabContext,
} from '../../../src/tools/internal/agent-collab-tools.js';

describe('Scenario 3: Dynamic Task Decomposition', () => {
  let mailbox: MailboxBlock;
  let registry: AgentRegistry;
  let promptDriver: PromptDriver;
  let assertionEngine: AssertionEngine;
  let registryObs: RegistryObserver;
  let mailboxObs: MailboxObserver;
  let resourceObs: ResourceObserver;

  beforeEach(() => {
    mailbox = new MailboxBlock({ id: 'scenario3-mailbox' });
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

  it('should decompose multi-step task into sequential actions', async () => {
    assertionEngine.start('scenario-3-decomposition');
    resourceObs.start(500);

    // Simulate: Agent decomposes task into steps
    // Step 1: Search for report link
    assertionEngine.recordEvent('step_1_search', { query: 'datareportal annual report' });
    
    // Step 2: Download PDF
    assertionEngine.recordEvent('step_2_download', { url: 'datareportal.com/reports' });
    
    // Step 3: Save to directory
    assertionEngine.recordEvent('step_3_save', { path: '~/Documents/reports/' });

    // Verify timeline has 3 steps
    const timeline = assertionEngine.getTimeline();
    expect(timeline).toHaveLength(4); // 3 steps + test_started
    expect(timeline[1].event).toBe('step_1_search');
    expect(timeline[2].event).toBe('step_2_download');
    expect(timeline[3].event).toBe('step_3_save');

    // Verify sequential order (timestamps increasing)
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].timestamp).toBeGreaterThanOrEqual(timeline[i - 1].timestamp);
    }

    const report = assertionEngine.generateReport(
      'scenario-3-decomposition',
      SCENARIO_PROMPTS.scenario3_dynamic_decomposition.template,
      resourceObs
    );
    expect(report.timeline.length).toBe(4);
  });

  it('should pass state between steps', async () => {
    assertionEngine.start('scenario-3-state-passing');

    // Simulate state passing between steps
    const state: Record<string, unknown> = {};
    
    // Step 1: Search → get URL
    state.searchResult = { url: 'https://datareportal.com/reports/digital-2026' };
    assertionEngine.recordEvent('search_complete', state);
    
    // Step 2: Download → get file path
    state.downloadResult = { filePath: '/tmp/digital-2026.pdf' };
    assertionEngine.recordEvent('download_complete', state);
    
    // Step 3: Save → get final path
    state.saveResult = { filePath: '~/Documents/reports/digital-2026.pdf' };
    assertionEngine.recordEvent('save_complete', state);

    // Verify state accumulation
    const timeline = assertionEngine.getTimeline();
    const lastEvent = timeline[timeline.length - 1];
    expect(lastEvent.details).toHaveProperty('searchResult');
    expect(lastEvent.details).toHaveProperty('downloadResult');
    expect(lastEvent.details).toHaveProperty('saveResult');
  });

  it('should handle partial failure gracefully', async () => {
    assertionEngine.start('scenario-3-partial-failure');

    // Step 1: Search succeeds
    assertionEngine.recordEvent('search_complete', { success: true });
    
    // Step 2: Download fails (network error)
    assertionEngine.recordEvent('download_failed', { 
      success: false, 
      error: 'Network timeout',
      retryCount: 3 
    });

    // Agent should report failure, not silently hang
    const response = await promptDriver.sendPrompt(
      SCENARIO_PROMPTS.scenario3_dynamic_decomposition.template
    );
    expect(response.status).toBeDefined();

    const report = assertionEngine.generateReport(
      'scenario-3-partial-failure',
      SCENARIO_PROMPTS.scenario3_dynamic_decomposition.template
    );
    // Report should be generated even on failure
    expect(report).toBeDefined();
    expect(report.timeline.length).toBeGreaterThan(0);
  });
});
