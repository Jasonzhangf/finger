import { describe, expect, it } from 'vitest';
import {
  consumeContextBuilderOnDemandView,
  peekContextBuilderOnDemandView,
  resetContextBuilderBootstrapOnce,
  setContextBuilderOnDemandView,
  shouldRunContextBuilderBootstrapOnce,
} from '../../../src/runtime/context-builder-on-demand-state.js';

describe('context-builder-on-demand-state', () => {
  it('stores, peeks, and consumes staged on-demand rebuild view', () => {
    const sessionId = 'state-test-session';
    const agentId = 'finger-system-agent';

    setContextBuilderOnDemandView({
      sessionId,
      agentId,
      mode: 'main',
      buildMode: 'moderate',
      targetBudget: 100000,
      selectedBlockIds: ['task-1', 'task-2'],
      metadata: { rawTaskBlockCount: 2 },
      messages: [],
      createdAt: new Date().toISOString(),
    });

    const peeked = peekContextBuilderOnDemandView(sessionId, agentId);
    expect(peeked).toBeDefined();
    expect(peeked?.selectedBlockIds).toEqual(['task-1', 'task-2']);

    const consumed = consumeContextBuilderOnDemandView(sessionId, agentId);
    expect(consumed).toBeDefined();
    expect(consumed?.buildMode).toBe('moderate');

    const consumedAgain = consumeContextBuilderOnDemandView(sessionId, agentId);
    expect(consumedAgain).toBeUndefined();
  });

  it('allows bootstrap rebuild only once per session+agent unless reset', () => {
    const sessionId = 'bootstrap-state-session';
    const agentId = 'finger-system-agent';

    resetContextBuilderBootstrapOnce(sessionId, agentId);
    expect(shouldRunContextBuilderBootstrapOnce(sessionId, agentId)).toBe(true);
    expect(shouldRunContextBuilderBootstrapOnce(sessionId, agentId)).toBe(false);

    resetContextBuilderBootstrapOnce(sessionId, agentId);
    expect(shouldRunContextBuilderBootstrapOnce(sessionId, agentId)).toBe(true);
  });
});
