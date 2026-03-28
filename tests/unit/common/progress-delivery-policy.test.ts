import { describe, expect, it } from 'vitest';
import {
  applyProgressDeliveryPolicy,
  normalizeProgressDeliveryPolicy,
} from '../../../src/common/progress-delivery-policy.js';
import type { PushSettings } from '../../../src/bridges/types.js';

const base: PushSettings = {
  updateMode: 'both',
  reasoning: true,
  bodyUpdates: true,
  statusUpdate: true,
  toolCalls: true,
  stepUpdates: true,
  stepBatch: 5,
  progressUpdates: true,
};

describe('progress-delivery-policy', () => {
  it('normalizes snake_case and returns undefined for empty payload', () => {
    expect(normalizeProgressDeliveryPolicy({})).toBeUndefined();
    const normalized = normalizeProgressDeliveryPolicy({
      mode: 'result_only',
      fields: {
        body_updates: true,
        status_update: false,
      },
    });
    expect(normalized).toEqual({
      mode: 'result_only',
      fields: {
        bodyUpdates: true,
        statusUpdate: false,
      },
    });
  });

  it('applies result_only defaults and explicit field overrides', () => {
    const policy = normalizeProgressDeliveryPolicy({
      mode: 'result_only',
      fields: { statusUpdate: true },
    });
    const next = applyProgressDeliveryPolicy(base, policy);
    expect(next.bodyUpdates).toBe(true);
    expect(next.reasoning).toBe(false);
    expect(next.toolCalls).toBe(false);
    expect(next.progressUpdates).toBe(false);
    expect(next.statusUpdate).toBe(true);
  });
});

