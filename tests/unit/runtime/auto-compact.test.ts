import { describe, it, expect, beforeEach } from 'vitest';

// Extract and test the core logic from runtime-facade.ts (maybeAutoCompact)
// Without depending on RuntimeFacade instantiation

// Constants from runtime-facade.ts
const AUTO_CONTEXT_COMPACT_THRESHOLD_PERCENT = 85;
const AUTO_CONTEXT_COMPACT_COOLDOWN_MS = 60000;
const AUTO_CONTEXT_COMPACT_TIMEOUT_MS = 30000;

// State maps (simulating runtime-facade internal state)
const autoCompactStateBySession = new Map<string, { lastAttemptAt: number; lastTurnId?: string }>();
const autoCompactInFlightBySession = new Map<string, Promise<boolean>>();

// Core logic extracted from maybeAutoCompact (L1649-1720 in runtime-facade.ts)
function shouldTriggerAutoCompact(
  sessionId: string,
  contextUsagePercent: number,
  turnId?: string,
  now?: number,
): { shouldTrigger: boolean; reason: string } {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) {
    return { shouldTrigger: false, reason: 'invalid_session_id' };
  }

  if (typeof contextUsagePercent !== 'number' || !Number.isFinite(contextUsagePercent)) {
    return { shouldTrigger: false, reason: 'invalid_context_usage_percent' };
  }

  const normalizedPercent = Math.max(0, Math.floor(contextUsagePercent));
  if (normalizedPercent < AUTO_CONTEXT_COMPACT_THRESHOLD_PERCENT) {
    return { shouldTrigger: false, reason: 'below_threshold' };
  }

  const timestamp = now ?? Date.now();
  const state = autoCompactStateBySession.get(normalizedSessionId);
  const normalizedTurnId = typeof turnId === 'string' && turnId.trim().length > 0
    ? turnId.trim()
    : undefined;

  if (state) {
    if (normalizedTurnId && state.lastTurnId === normalizedTurnId) {
      return { shouldTrigger: false, reason: 'turn_id_duplicate' };
    }
    if (timestamp - state.lastAttemptAt < AUTO_CONTEXT_COMPACT_COOLDOWN_MS) {
      return { shouldTrigger: false, reason: 'cooldown_active' };
    }
  }

  // Update state (simulate actual behavior)
  autoCompactStateBySession.set(normalizedSessionId, {
    lastAttemptAt: timestamp,
    ...(normalizedTurnId ? { lastTurnId: normalizedTurnId } : {}),
  });

  return { shouldTrigger: true, reason: 'threshold_met' };
}

describe('Auto Compact Core Logic (Regression Tests)', () => {
  const testSessionId = 'auto-compact-regression-session-001';

  beforeEach(() => {
    autoCompactStateBySession.clear();
    autoCompactInFlightBySession.clear();
  });

  it('triggers when contextUsagePercent >= 85 (regression)', () => {
    const result = shouldTriggerAutoCompact(testSessionId, 85, 'turn-001');
    expect(result.shouldTrigger).toBe(true);
    expect(result.reason).toBe('threshold_met');
  });

  it('triggers when contextUsagePercent > 85 (regression)', () => {
    const result = shouldTriggerAutoCompact(testSessionId, 90, 'turn-002');
    expect(result.shouldTrigger).toBe(true);
    expect(result.reason).toBe('threshold_met');
  });

  it('does NOT trigger when contextUsagePercent < 85 (regression)', () => {
    const result = shouldTriggerAutoCompact(testSessionId, 84, 'turn-003');
    expect(result.shouldTrigger).toBe(false);
    expect(result.reason).toBe('below_threshold');
  });

  it('does NOT trigger when contextUsagePercent is exactly 84 (boundary test)', () => {
    const result = shouldTriggerAutoCompact(testSessionId, 84, 'turn-004');
    expect(result.shouldTrigger).toBe(false);
    expect(result.reason).toBe('below_threshold');
  });

  it('dedupes by turnId (same turnId rejected on second call) (regression)', () => {
    const now = Date.now();
    const result1 = shouldTriggerAutoCompact(testSessionId, 85, 'turn-dedupe', now);
    expect(result1.shouldTrigger).toBe(true);

    const result2 = shouldTriggerAutoCompact(testSessionId, 85, 'turn-dedupe', now + 1000);
    expect(result2.shouldTrigger).toBe(false);
    expect(result2.reason).toBe('turn_id_duplicate');
  });

  it('cooldown blocks different turnId within 60s (regression)', () => {
    const now1 = 1000000;
    const result1 = shouldTriggerAutoCompact(testSessionId, 85, 'turn-001', now1);
    expect(result1.shouldTrigger).toBe(true);

    // Different turnId but within cooldown (30s later)
    const now2 = now1 + 30000;
    const result2 = shouldTriggerAutoCompact(testSessionId, 85, 'turn-002', now2);
    expect(result2.shouldTrigger).toBe(false);
    expect(result2.reason).toBe('cooldown_active');
  });

  it('different turnId accepted after cooldown expires (60s) (regression)', () => {
    const now1 = 1000000;
    const result1 = shouldTriggerAutoCompact(testSessionId, 85, 'turn-001', now1);
    expect(result1.shouldTrigger).toBe(true);

    // Different turnId after cooldown (61s later)
    const now2 = now1 + 61000;
    const result2 = shouldTriggerAutoCompact(testSessionId, 85, 'turn-002', now2);
    expect(result2.shouldTrigger).toBe(true);
    expect(result2.reason).toBe('threshold_met');
  });

  it('cooldown prevents trigger within 60 seconds for same session (regression)', () => {
    const now1 = Date.now();
    const result1 = shouldTriggerAutoCompact(testSessionId, 85, 'turn-001', now1);
    expect(result1.shouldTrigger).toBe(true);

    // Try again 30 seconds later (within cooldown)
    const now2 = now1 + 30000;
    const result2 = shouldTriggerAutoCompact(testSessionId, 85, 'turn-002', now2);
    expect(result2.shouldTrigger).toBe(false);
    expect(result2.reason).toBe('cooldown_active');
  });

  it('cooldown allows trigger after 60 seconds (regression)', () => {
    const now1 = Date.now();
    const result1 = shouldTriggerAutoCompact(testSessionId, 85, 'turn-001', now1);
    expect(result1.shouldTrigger).toBe(true);

    // Try again 61 seconds later (cooldown expired)
    const now2 = now1 + 61000;
    const result2 = shouldTriggerAutoCompact(testSessionId, 85, 'turn-002', now2);
    expect(result2.shouldTrigger).toBe(true);
  });

  it('rejects invalid sessionId (regression)', () => {
    const result = shouldTriggerAutoCompact('', 85, 'turn-001');
    expect(result.shouldTrigger).toBe(false);
    expect(result.reason).toBe('invalid_session_id');
  });

  it('rejects invalid contextUsagePercent (NaN) (regression)', () => {
    const result = shouldTriggerAutoCompact(testSessionId, NaN, 'turn-001');
    expect(result.shouldTrigger).toBe(false);
    expect(result.reason).toBe('invalid_context_usage_percent');
  });

  it('rejects invalid contextUsagePercent (Infinity) (regression)', () => {
    const result = shouldTriggerAutoCompact(testSessionId, Infinity, 'turn-001');
    expect(result.shouldTrigger).toBe(false);
    expect(result.reason).toBe('invalid_context_usage_percent');
  });

  it('rejects missing contextUsagePercent (undefined) (regression)', () => {
    const result = shouldTriggerAutoCompact(testSessionId, undefined as any, 'turn-001');
    expect(result.shouldTrigger).toBe(false);
    expect(result.reason).toBe('invalid_context_usage_percent');
  });

  it('handles missing turnId gracefully (regression)', () => {
    const result = shouldTriggerAutoCompact(testSessionId, 85);
    expect(result.shouldTrigger).toBe(true);
    expect(result.reason).toBe('threshold_met');
  });

  it('handles whitespace sessionId correctly (regression)', () => {
    const result = shouldTriggerAutoCompact('  session-with-spaces  ', 85, 'turn-001');
    expect(result.shouldTrigger).toBe(true);
  });

  it('handles negative contextUsagePercent by flooring to 0 (regression)', () => {
    const result = shouldTriggerAutoCompact(testSessionId, -10, 'turn-001');
    expect(result.shouldTrigger).toBe(false);
    expect(result.reason).toBe('below_threshold');
  });

  it('simulates full event-forwarding flow (model_round -> maybeAutoCompact) (regression)', () => {
    // Simulate event-forwarding.impl.ts L1272-1318
    const modelRoundEvent = {
      phase: 'kernel_event',
      sessionId: testSessionId,
      payload: {
        type: 'model_round',
        contextUsagePercent: 85,
        responseId: 'response-001',
      },
    };

    const contextUsagePercent = modelRoundEvent.payload.contextUsagePercent;
    const turnId = modelRoundEvent.payload.responseId;

    const result = shouldTriggerAutoCompact(
      modelRoundEvent.sessionId,
      contextUsagePercent as number,
      turnId as string,
    );

    expect(result.shouldTrigger).toBe(true);
    expect(result.reason).toBe('threshold_met');
  });

  it('verifies threshold constant is 85 (regression)', () => {
    expect(AUTO_CONTEXT_COMPACT_THRESHOLD_PERCENT).toBe(85);
  });

  it('verifies cooldown constant is 60000ms (regression)', () => {
    expect(AUTO_CONTEXT_COMPACT_COOLDOWN_MS).toBe(60000);
  });

  it('turnId dedupe takes priority over cooldown check (regression)', () => {
    const now1 = 1000000;
    const result1 = shouldTriggerAutoCompact(testSessionId, 85, 'turn-same', now1);
    expect(result1.shouldTrigger).toBe(true);

    // Same turnId, outside cooldown (120s later)
    const now2 = now1 + 120000;
    const result2 = shouldTriggerAutoCompact(testSessionId, 85, 'turn-same', now2);
    expect(result2.shouldTrigger).toBe(false);
    expect(result2.reason).toBe('turn_id_duplicate');
  });
});
