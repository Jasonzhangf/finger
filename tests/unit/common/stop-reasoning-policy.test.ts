import { describe, expect, it } from 'vitest';
import { resolveStopReasoningPolicy, isStopReasoningStopTool } from '../../../src/common/stop-reasoning-policy.js';

describe('stop-reasoning-policy', () => {
  it('defaults to gate enabled (single strategy)', () => {
    const policy = resolveStopReasoningPolicy();
    expect(policy.requireToolForStop).toBe(true);
    expect(policy.stopToolNames.length).toBeGreaterThan(0);
  });

  it('supports metadata overrides for tool list while gate stays enabled', () => {
    const policy = resolveStopReasoningPolicy({
      requireStopToolForEndTurn: true,
      stopToolNames: ['reasoning.stop', 'custom.stop'],
      stopToolMaxAutoContinueTurns: 3,
    });
    expect(policy.requireToolForStop).toBe(true);
    expect(policy.stopToolNames).toContain('custom.stop');
    expect(policy.maxAutoContinueTurns).toBe(3);
  });

  it('matches stop tools case-insensitively', () => {
    expect(isStopReasoningStopTool('Reasoning.Stop', ['reasoning.stop'])).toBe(true);
    expect(isStopReasoningStopTool('other.tool', ['reasoning.stop'])).toBe(false);
  });
});
