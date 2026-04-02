import { describe, expect, it } from 'vitest';
import { __fingerRoleModulesInternals } from '../../../src/server/modules/finger-role-modules';

const { isEffectivelyEmptyHistoryForBootstrap, hasHistoricalContextZone, resolveBootstrapRebuildPolicy } = __fingerRoleModulesInternals as {
  isEffectivelyEmptyHistoryForBootstrap: (messages: Array<{ role: string; content: string }>) => boolean;
  hasHistoricalContextZone: (
    messages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: string; metadata?: Record<string, unknown> }>
  ) => boolean;
  resolveBootstrapRebuildPolicy: (
    historyEmpty: boolean,
    hasHistoryContext: boolean,
  ) => { shouldBootstrap: boolean; enforceOnceGuard: boolean; trigger: 'history_empty' | 'history_context_zero' | 'none' };
  keepDigestOnlyHistoricalMessages: (
    messages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: string; metadata?: Record<string, unknown> }>
  ) => Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: string; metadata?: Record<string, unknown> }>;
  buildHistoricalFallbackFromSeed: (
    seedMessages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: string; metadata?: Record<string, unknown> }>,
    budgetTokens: number,
    limit: number,
  ) => Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: string; metadata?: Record<string, unknown> }>;
  resolveBootstrapPrompt: (
    sessionMessages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: string; metadata?: Record<string, unknown> }>,
    bootstrapSeedMessages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: string; metadata?: Record<string, unknown> }>,
  ) => { prompt?: string; source: 'session_messages' | 'bootstrap_seed' | 'none' };
  parsePersistedBootstrapOnceState: (
    sessionContext: Record<string, unknown> | undefined,
  ) => {
    version: 1;
    byAgent: Record<string, {
      lastAttemptAt: string;
      lastOutcome: 'started' | 'success' | 'failed' | 'no_historical';
      lastTrigger: 'history_empty' | 'history_context_zero' | 'none';
      messageCountAtAttempt: number;
    }>;
  } | null;
  shouldAllowBootstrapFromPersistedState: (
    state: {
      version: 1;
      byAgent: Record<string, {
        lastAttemptAt: string;
        lastOutcome: 'started' | 'success' | 'failed' | 'no_historical';
        lastTrigger: 'history_empty' | 'history_context_zero' | 'none';
        messageCountAtAttempt: number;
      }>;
    } | null,
    agentId: string,
    sessionMessageCount: number,
    nowMs: number,
    cooldownMs?: number,
  ) => {
    allowed: boolean;
    reason: string;
    previous?: {
      lastAttemptAt: string;
      lastOutcome: 'started' | 'success' | 'failed' | 'no_historical';
      lastTrigger: 'history_empty' | 'history_context_zero' | 'none';
      messageCountAtAttempt: number;
    };
  };
};

describe('finger-role-modules bootstrap gating', () => {
  it('treats empty history as bootstrap-eligible', () => {
    expect(isEffectivelyEmptyHistoryForBootstrap([])).toBe(true);
    expect(resolveBootstrapRebuildPolicy(true, false)).toEqual({
      shouldBootstrap: true,
      enforceOnceGuard: true,
      trigger: 'history_empty',
    });
  });

  it('forces bootstrap rebuild when history context is zero', () => {
    const historyEmpty = isEffectivelyEmptyHistoryForBootstrap([
      { role: 'user', content: '继续执行这个任务' },
    ]);
    expect(historyEmpty).toBe(false);
    expect(resolveBootstrapRebuildPolicy(historyEmpty, false)).toEqual({
      shouldBootstrap: true,
      enforceOnceGuard: false,
      trigger: 'history_context_zero',
    });
  });

  it('does not bootstrap when historical context already exists', () => {
    expect(resolveBootstrapRebuildPolicy(false, true)).toEqual({
      shouldBootstrap: false,
      enforceOnceGuard: false,
      trigger: 'none',
    });
  });

  it('detects historical context from compactDigest metadata even without contextZone', () => {
    const hasHistorical = hasHistoricalContextZone([
      {
        id: 'h-1',
        role: 'assistant',
        content: 'digest history',
        timestamp: '2026-03-28T00:00:00.000Z',
        metadata: { compactDigest: true },
      },
    ]);
    expect(hasHistorical).toBe(true);
  });

  it('keeps historical messages when no compactDigest is available to avoid history=0 loop', () => {
    const mapped = __fingerRoleModulesInternals.keepDigestOnlyHistoricalMessages([
      {
        id: 'h-1',
        role: 'assistant',
        content: 'history raw',
        timestamp: '2026-03-28T00:00:00.000Z',
        metadata: { contextZone: 'historical_memory' },
      },
      {
        id: 'c-1',
        role: 'user',
        content: 'current',
        timestamp: '2026-03-28T00:00:01.000Z',
        metadata: { contextZone: 'working_set' },
      },
    ]);
    expect(mapped.map((item) => item.id)).toEqual(['h-1', 'c-1']);
  });

  it('keeps only compact historical messages when compact digests are present', () => {
    const mapped = __fingerRoleModulesInternals.keepDigestOnlyHistoricalMessages([
      {
        id: 'h-raw',
        role: 'assistant',
        content: 'history raw',
        timestamp: '2026-03-28T00:00:00.000Z',
        metadata: { contextZone: 'historical_memory' },
      },
      {
        id: 'h-digest',
        role: 'assistant',
        content: 'history digest',
        timestamp: '2026-03-28T00:00:00.500Z',
        metadata: { contextZone: 'historical_memory', compactDigest: true },
      },
      {
        id: 'c-1',
        role: 'user',
        content: 'current',
        timestamp: '2026-03-28T00:00:01.000Z',
        metadata: { contextZone: 'working_set' },
      },
    ]);
    expect(mapped.map((item) => item.id)).toEqual(['h-digest', 'c-1']);
  });

  it('builds historical fallback entries from seed messages when bootstrap has no historical output', () => {
    const mapped = __fingerRoleModulesInternals.buildHistoricalFallbackFromSeed([
      {
        id: 'm-1',
        role: 'user',
        content: '用户请求 A',
        timestamp: '2026-03-31T00:00:00.000Z',
      },
      {
        id: 'm-2',
        role: 'assistant',
        content: '执行结果 A',
        timestamp: '2026-03-31T00:00:01.000Z',
      },
    ], 4000, 10);
    expect(mapped.length).toBeGreaterThan(0);
    expect(mapped.every((item) => item.metadata?.contextZone === 'historical_memory')).toBe(true);
  });

  it('prefers the current session latest user prompt for bootstrap ranking', () => {
    const resolved = __fingerRoleModulesInternals.resolveBootstrapPrompt(
      [
        { id: 'u-current', role: 'user', content: '当前任务：修复 context rebuild', timestamp: '2026-03-31T01:00:00.000Z' },
      ],
      [
        { id: 'u-seed', role: 'user', content: '旧任务：检查 cron', timestamp: '2026-03-31T00:00:00.000Z' },
      ],
    );
    expect(resolved).toEqual({
      prompt: '当前任务：修复 context rebuild',
      source: 'session_messages',
    });
  });

  it('falls back to bootstrap seed prompt when current session has no user prompt', () => {
    const resolved = __fingerRoleModulesInternals.resolveBootstrapPrompt(
      [
        { id: 'a-current', role: 'assistant', content: '处理中', timestamp: '2026-03-31T01:00:00.000Z' },
      ],
      [
        { id: 'u-seed', role: 'user', content: '旧任务：检查 cron', timestamp: '2026-03-31T00:00:00.000Z' },
      ],
    );
    expect(resolved).toEqual({
      prompt: '旧任务：检查 cron',
      source: 'bootstrap_seed',
    });
  });

  it('parses persisted bootstrap once state from session context', () => {
    const parsed = __fingerRoleModulesInternals.parsePersistedBootstrapOnceState({
      contextBuilderBootstrapOnceState: {
        version: 1,
        byAgent: {
          'finger-system-agent': {
            lastAttemptAt: '2026-04-02T01:00:00.000Z',
            lastOutcome: 'failed',
            lastTrigger: 'history_empty',
            messageCountAtAttempt: 0,
          },
        },
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.byAgent['finger-system-agent']?.lastOutcome).toBe('failed');
  });

  it('blocks bootstrap once when persisted outcome already succeeded', () => {
    const parsed = __fingerRoleModulesInternals.parsePersistedBootstrapOnceState({
      contextBuilderBootstrapOnceState: {
        version: 1,
        byAgent: {
          'finger-system-agent': {
            lastAttemptAt: '2026-04-02T01:00:00.000Z',
            lastOutcome: 'success',
            lastTrigger: 'history_empty',
            messageCountAtAttempt: 1,
          },
        },
      },
    });
    const decision = __fingerRoleModulesInternals.shouldAllowBootstrapFromPersistedState(
      parsed,
      'finger-system-agent',
      1,
      Date.parse('2026-04-02T01:10:00.000Z'),
      120_000,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('already_succeeded');
  });

  it('allows retry after cooldown for persisted failed bootstrap once', () => {
    const parsed = __fingerRoleModulesInternals.parsePersistedBootstrapOnceState({
      contextBuilderBootstrapOnceState: {
        version: 1,
        byAgent: {
          'finger-system-agent': {
            lastAttemptAt: '2026-04-02T01:00:00.000Z',
            lastOutcome: 'failed',
            lastTrigger: 'history_empty',
            messageCountAtAttempt: 3,
          },
        },
      },
    });
    const decision = __fingerRoleModulesInternals.shouldAllowBootstrapFromPersistedState(
      parsed,
      'finger-system-agent',
      3,
      Date.parse('2026-04-02T01:03:01.000Z'),
      120_000,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('retry_cooldown_elapsed');
  });

  it('allows retry immediately when new messages arrived since failed attempt', () => {
    const parsed = __fingerRoleModulesInternals.parsePersistedBootstrapOnceState({
      contextBuilderBootstrapOnceState: {
        version: 1,
        byAgent: {
          'finger-system-agent': {
            lastAttemptAt: '2026-04-02T01:00:00.000Z',
            lastOutcome: 'failed',
            lastTrigger: 'history_empty',
            messageCountAtAttempt: 3,
          },
        },
      },
    });
    const decision = __fingerRoleModulesInternals.shouldAllowBootstrapFromPersistedState(
      parsed,
      'finger-system-agent',
      4,
      Date.parse('2026-04-02T01:00:30.000Z'),
      120_000,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('new_messages_since_attempt');
  });
});
