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
});
