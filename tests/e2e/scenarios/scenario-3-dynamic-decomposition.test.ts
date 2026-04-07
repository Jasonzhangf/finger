import { describe, it, expect, beforeEach } from 'vitest';
import { AssertionEngine } from '../framework/assertion-engine.js';
import { ResourceObserver } from '../observers/resource-observer.js';
import { SCENARIO_PROMPTS } from '../framework/prompt-driver.js';
import { clearAllHooks } from '../../../src/test-support/tool-call-hook.js';

class TestRegistry {
  private agents = new Map<string, any>();
  register(meta: any) { this.agents.set(meta.id, meta); }
  clear() { this.agents.clear(); }
  listAgents() { return Array.from(this.agents.values()); }
}

describe('Scenario 3: Dynamic Task Decomposition', () => {
  let assertionEngine: AssertionEngine;
  let resourceObs: ResourceObserver;

  beforeEach(() => {
    assertionEngine = new AssertionEngine({ defaultTimeoutMs: 30000 });
    resourceObs = new ResourceObserver(new TestRegistry() as any);
    clearAllHooks();
  });

  it('should decompose multi-step task', async () => {
    assertionEngine.start('scenario-3');
    resourceObs.start(500);

    assertionEngine.recordEvent('step_1_search', { query: 'datareportal' });
    assertionEngine.recordEvent('step_2_download', { url: 'datareportal.com/reports' });
    assertionEngine.recordEvent('step_3_save', { path: '~/Documents/reports/' });

    const timeline = assertionEngine.getTimeline();
    expect(timeline).toHaveLength(4);
    expect(timeline[1].event).toBe('step_1_search');
    expect(timeline[2].event).toBe('step_2_download');
    expect(timeline[3].event).toBe('step_3_save');

    const report = assertionEngine.generateReport('scenario-3', SCENARIO_PROMPTS.scenario3_dynamic_decomposition.template, resourceObs);
    expect(report.timeline.length).toBe(4);
  });

  it('should pass state between steps', async () => {
    assertionEngine.start('scenario-3-state');
    const state: Record<string, unknown> = {};
    
    state.searchResult = { url: 'https://datareportal.com/reports/digital-2026' };
    assertionEngine.recordEvent('search_complete', state);
    
    state.downloadResult = { filePath: '/tmp/digital-2026.pdf' };
    assertionEngine.recordEvent('download_complete', state);
    
    state.saveResult = { filePath: '~/Documents/reports/digital-2026.pdf' };
    assertionEngine.recordEvent('save_complete', state);

    const timeline = assertionEngine.getTimeline();
    const lastEvent = timeline[timeline.length - 1];
    expect(lastEvent.details).toHaveProperty('searchResult');
    expect(lastEvent.details).toHaveProperty('downloadResult');
    expect(lastEvent.details).toHaveProperty('saveResult');
  });

  it('should handle partial failure', async () => {
    assertionEngine.start('scenario-3-failure');

    assertionEngine.recordEvent('search_complete', { success: true });
    assertionEngine.recordEvent('download_failed', { success: false, error: 'Network timeout', retryCount: 3 });

    const timeline = assertionEngine.getTimeline();
    const failEvent = timeline.find(e => e.event === 'download_failed');
    expect(failEvent).toBeDefined();
    expect(failEvent?.details.error).toBe('Network timeout');
  });
});
