import { describe, it, expect, vi } from 'vitest';
import { UnifiedEventBus } from '../../../src/runtime/event-bus.js';
import { ProgressMonitor } from '../../../src/server/modules/progress-monitor.js';
import type { AgentRuntimeDeps } from '../../../src/server/modules/agent-runtime/types.js';

function createMinimalDeps(): AgentRuntimeDeps {
  return {
    sessionManager: {
      getSession: vi.fn(() => null),
    } as unknown as AgentRuntimeDeps['sessionManager'],
    agentRuntimeBlock: {
      execute: vi.fn(async () => ({ agents: [] })),
    } as unknown as AgentRuntimeDeps['agentRuntimeBlock'],
  } as AgentRuntimeDeps;
}

async function flushEventLoop(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('ProgressMonitor incremental updates', () => {
  it('reuses turn_start context snapshot when first tracked event is tool-only', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: string[] = [];
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {
        onProgressReport: (report) => {
          reports.push(report.summary);
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    // Simulate turn_start without explicit agent id in event root, but with context snapshot.
    await eventBus.emit({
      type: 'turn_start',
      sessionId: 'session-tool-only-context',
      timestamp: new Date().toISOString(),
      payload: {
        contextBreakdown: {
          historyContextTokens: 4200,
          historyCurrentTokens: 1800,
          historyTotalTokens: 6000,
          totalKnownTokens: 25000,
        },
      },
    } as any);

    // Later tool event creates the progress entry.
    await eventBus.emit({
      type: 'tool_call',
      sessionId: 'session-tool-only-context',
      agentId: 'finger-system-agent',
      toolId: 'tool-only-1',
      toolName: 'reasoning.stop',
      timestamp: new Date().toISOString(),
      payload: {
        input: {},
      },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId: 'session-tool-only-context',
      agentId: 'finger-system-agent',
      toolId: 'tool-only-1',
      toolName: 'reasoning.stop',
      timestamp: new Date().toISOString(),
      payload: {
        input: {},
        output: 'ok',
      },
    } as any);

    await flushEventLoop();
    await (monitor as any).generateProgressReport();

    expect(reports.length).toBeGreaterThan(0);
    const latest = reports[reports.length - 1];
    expect(latest).toContain('🧠 上下文:');
    expect(latest).not.toContain('当前为工具流，尚未收到本轮 model_round 统计');

    monitor.stop();
  });

  it('applies session-level context snapshot to existing progress entry even without explicit agentId', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: string[] = [];
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {
        onProgressReport: (report) => {
          reports.push(report.summary);
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    await eventBus.emit({
      type: 'tool_call',
      sessionId: 'session-system-snapshot',
      agentId: 'finger-system-agent',
      toolId: 'ss-1',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: { input: { cmd: 'echo bootstrap' } },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId: 'session-system-snapshot',
      agentId: 'finger-system-agent',
      toolId: 'ss-1',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: { input: { cmd: 'echo bootstrap' }, output: 'ok' },
    } as any);
    await flushEventLoop();
    await (monitor as any).generateProgressReport();
    expect(reports[0]).toContain('工具执行阶段，等待模型回传上下文统计');

    await eventBus.emit({
      type: 'system_notice',
      sessionId: 'session-system-snapshot',
      timestamp: new Date().toISOString(),
      payload: {
        source: 'auto_compact_probe',
        contextUsagePercent: 42,
        estimatedTokensInContextWindow: 110000,
        maxInputTokens: 262144,
        contextBreakdown: {
          historyContextTokens: 18000,
          historyCurrentTokens: 12000,
          historyTotalTokens: 30000,
          totalKnownTokens: 64000,
        },
      },
    } as any);

    await eventBus.emit({
      type: 'tool_call',
      sessionId: 'session-system-snapshot',
      agentId: 'finger-system-agent',
      toolId: 'ss-2',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: { input: { cmd: 'echo follow-up' } },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId: 'session-system-snapshot',
      agentId: 'finger-system-agent',
      toolId: 'ss-2',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: { input: { cmd: 'echo follow-up' }, output: 'ok' },
    } as any);
    await flushEventLoop();
    await (monitor as any).generateProgressReport();

    expect(reports.length).toBeGreaterThanOrEqual(2);
    const latest = reports[reports.length - 1];
    expect(latest).toContain('🧠 上下文:');
    expect(latest).not.toContain('尚未收到本轮 model_round');

    monitor.stop();
  });

  it('does not repeat already-reported task/reasoning in next progress update', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: string[] = [];
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {
        onProgressReport: (report) => {
          reports.push(report.summary);
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    await eventBus.emit({
      type: 'agent_runtime_status',
      sessionId: 'session-progress-delta',
      agentId: 'finger-system-agent',
      timestamp: new Date().toISOString(),
      payload: {
        status: 'running',
        summary: '分析代码',
      },
    } as any);
    await eventBus.emit({
      type: 'model_round',
      sessionId: 'session-progress-delta',
      agentId: 'finger-system-agent',
      timestamp: new Date().toISOString(),
      payload: {
        reasoning: '需要检查 event-forwarding.ts 的逻辑',
      },
    } as any);
    await eventBus.emit({
      type: 'tool_call',
      sessionId: 'session-progress-delta',
      agentId: 'finger-system-agent',
      toolId: 'tool-1',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: { cmd: 'cat src/index.ts' },
      },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId: 'session-progress-delta',
      agentId: 'finger-system-agent',
      toolId: 'tool-1',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: { cmd: 'cat src/index.ts' },
        output: 'ok',
      },
    } as any);
    await flushEventLoop();

    const progress = monitor.getProgress('session-progress-delta');
    if (progress) progress.elapsedMs = 5000;

    await (monitor as any).generateProgressReport();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('🧭 cat → ✅');
    expect(reports[0]).toContain('💭 需要检查 event-forwarding.ts 的逻辑');
    expect(reports[0]).toContain('cat');

    await eventBus.emit({
      type: 'tool_call',
      sessionId: 'session-progress-delta',
      agentId: 'finger-system-agent',
      toolId: 'tool-2',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: { cmd: 'rg "progress" src/server' },
      },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId: 'session-progress-delta',
      agentId: 'finger-system-agent',
      toolId: 'tool-2',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: { cmd: 'rg "progress" src/server' },
        output: 'match',
      },
    } as any);

    const updated = monitor.getProgress('session-progress-delta');
    if (updated) updated.elapsedMs = 8000;

    await (monitor as any).generateProgressReport();

    expect(reports).toHaveLength(2);
    expect(reports[1]).toContain('rg');
    expect(reports[1]).not.toContain('🧭 shell.exec → ✅');
    expect(reports[1]).not.toContain('💭 需要检查 event-forwarding.ts 的逻辑');

    monitor.stop();
  });

  it('does not advance progress dedup cursor when progress callback fails', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: string[] = [];
    let shouldFail = true;
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {
        onProgressReport: async (report) => {
          if (shouldFail) {
            throw new Error('simulated progress delivery failure');
          }
          reports.push(report.summary);
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    await eventBus.emit({
      type: 'tool_call',
      sessionId: 'session-progress-failure-retry',
      agentId: 'finger-system-agent',
      toolId: 'tool-fail-1',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: { input: { cmd: 'echo first' } },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId: 'session-progress-failure-retry',
      agentId: 'finger-system-agent',
      toolId: 'tool-fail-1',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: { input: { cmd: 'echo first' }, output: 'ok' },
    } as any);
    await flushEventLoop();

    await (monitor as any).generateProgressReport();
    const afterFailed = monitor.getProgress('session-progress-failure-retry');
    expect(afterFailed?.lastReportedToolSeq).toBeUndefined();

    shouldFail = false;
    await (monitor as any).generateProgressReport();
    const afterSuccess = monitor.getProgress('session-progress-failure-retry');
    expect((afterSuccess?.lastReportedToolSeq ?? 0)).toBeGreaterThan(0);
    expect(reports.length).toBeGreaterThan(0);

    monitor.stop();
  });

  it('does not push progress update when only context usage changes (no tool calls)', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: string[] = [];
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {
        onProgressReport: (report) => {
          reports.push(report.summary);
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    await eventBus.emit({
      type: 'agent_runtime_status',
      sessionId: 'session-context-usage',
      agentId: 'finger-system-agent',
      timestamp: new Date().toISOString(),
      payload: {
        status: 'running',
        summary: '处理上下文',
      },
    } as any);
    await eventBus.emit({
      type: 'model_round',
      sessionId: 'session-context-usage',
      agentId: 'finger-system-agent',
      timestamp: new Date().toISOString(),
      payload: {
        contextUsagePercent: 41,
        estimatedTokensInContextWindow: 53200,
        maxInputTokens: 128000,
      },
    } as any);
    await flushEventLoop();

    const initial = monitor.getProgress('session-context-usage');
    if (initial) initial.elapsedMs = 4000;

    await (monitor as any).generateProgressReport();
    expect(reports).toHaveLength(0);

    // Only context changed; should still generate another progress update.
    await eventBus.emit({
      type: 'model_round',
      sessionId: 'session-context-usage',
      agentId: 'finger-system-agent',
      timestamp: new Date().toISOString(),
      payload: {
        contextUsagePercent: 55,
        estimatedTokensInContextWindow: 70400,
        maxInputTokens: 128000,
      },
    } as any);

    const updated = monitor.getProgress('session-context-usage');
    if (updated) updated.elapsedMs = 6000;

    await (monitor as any).generateProgressReport();
    expect(reports).toHaveLength(0);

    monitor.stop();
  });

  it('increments history/current breakdown when tool events add context between model rounds', async () => {
    const eventBus = new UnifiedEventBus();
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {},
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    await eventBus.emit({
      type: 'model_round',
      sessionId: 'session-breakdown-growth',
      agentId: 'finger-system-agent',
      timestamp: new Date().toISOString(),
      payload: {
        contextUsagePercent: 51,
        estimatedTokensInContextWindow: 134000,
        maxInputTokens: 262144,
        contextBreakdown: {
          historyContextTokens: 7300,
          historyCurrentTokens: 7900,
          historyTotalTokens: 15200,
          totalKnownTokens: 57500,
        },
      },
    } as any);

    await eventBus.emit({
      type: 'tool_call',
      sessionId: 'session-breakdown-growth',
      agentId: 'finger-system-agent',
      toolId: 'tool-growth-1',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: {
          cmd: 'cat /Users/fanzhang/.finger/logs/daemon.log | tail -n 120',
        },
      },
    } as any);

    await flushEventLoop();
    const progress = monitor.getProgress('session-breakdown-growth');
    expect(progress).toBeTruthy();
    expect(progress?.contextBreakdown?.historyCurrentTokens).toBeGreaterThan(7900);
    expect(progress?.contextBreakdown?.historyTotalTokens).toBeGreaterThan(15200);
    expect(progress?.contextBreakdown?.totalKnownTokens).toBeGreaterThan(57500);

    monitor.stop();
  });

  it('does not reset grown history/current breakdown when later model_round carries stale baseline snapshot', async () => {
    const eventBus = new UnifiedEventBus();
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {},
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    const baselineBreakdown = {
      historyContextTokens: 7300,
      historyCurrentTokens: 7900,
      historyTotalTokens: 15200,
      totalKnownTokens: 57500,
    };

    await eventBus.emit({
      type: 'model_round',
      sessionId: 'session-breakdown-no-reset',
      agentId: 'finger-system-agent',
      timestamp: new Date().toISOString(),
      payload: {
        contextUsagePercent: 51,
        estimatedTokensInContextWindow: 134000,
        maxInputTokens: 262144,
        contextBreakdown: baselineBreakdown,
      },
    } as any);

    await eventBus.emit({
      type: 'tool_call',
      sessionId: 'session-breakdown-no-reset',
      agentId: 'finger-system-agent',
      toolId: 'tool-grow-1',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: { input: { cmd: 'rg "context" src/server/modules/progress-monitor-event-handlers.ts' } },
    } as any);
    await flushEventLoop();

    const afterTool = monitor.getProgress('session-breakdown-no-reset');
    expect(afterTool?.contextBreakdown?.historyCurrentTokens).toBeGreaterThan(7900);
    const grownCurrent = afterTool?.contextBreakdown?.historyCurrentTokens ?? 0;
    const grownKnown = afterTool?.contextBreakdown?.totalKnownTokens ?? 0;

    // Kernel keeps emitting the same baseline breakdown snapshot for this turn.
    await eventBus.emit({
      type: 'model_round',
      sessionId: 'session-breakdown-no-reset',
      agentId: 'finger-system-agent',
      timestamp: new Date().toISOString(),
      payload: {
        contextUsagePercent: 53,
        estimatedTokensInContextWindow: 139000,
        maxInputTokens: 262144,
        contextBreakdown: baselineBreakdown,
      },
    } as any);
    await flushEventLoop();

    const afterSecondRound = monitor.getProgress('session-breakdown-no-reset');
    expect(afterSecondRound?.contextBreakdown?.historyCurrentTokens).toBeGreaterThanOrEqual(grownCurrent);
    expect(afterSecondRound?.contextBreakdown?.totalKnownTokens).toBeGreaterThanOrEqual(grownKnown);

    monitor.stop();
  });

  it('emits heartbeat progress when running session stalls without new events', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: string[] = [];
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {
        onProgressReport: (report) => {
          reports.push(report.summary);
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    await eventBus.emit({
      type: 'agent_runtime_status',
      sessionId: 'session-stalled-progress',
      agentId: 'finger-system-agent',
      timestamp: new Date().toISOString(),
      payload: {
        status: 'running',
        summary: '处理中',
      },
    } as any);
    await eventBus.emit({
      type: 'tool_call',
      sessionId: 'session-stalled-progress',
      agentId: 'finger-system-agent',
      toolId: 'tool-pending',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: { cmd: 'rg "dispatch" src/server/modules' },
      },
    } as any);
    await flushEventLoop();

    const progress = monitor.getProgress('session-stalled-progress');
    expect(progress).toBeTruthy();
    if (progress) {
      const now = Date.now();
      progress.startTime = now - 180_000;
      progress.lastUpdateTime = now - 65_000;
      progress.lastReportTime = now - 65_000;
      progress.status = 'running';
      progress.contextUsagePercent = 41;
      progress.estimatedTokensInContextWindow = 53_200;
      progress.maxInputTokens = 128_000;
      progress.lastReportedToolSeq = progress.toolSeqCounter;
      progress.lastReportedContextUsagePercent = 41;
      progress.lastReportedEstimatedTokensInContextWindow = 53_200;
      progress.lastReportedMaxInputTokens = 128_000;
    }

    await (monitor as any).generateProgressReport();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('无新事件');
    expect(reports[0]).toContain('等待工具');
    expect(reports[0]).toContain('🧠 上下文: 41% · 53.2k/128k');

    monitor.stop();
  });

  it('throttles heartbeat for stalled open turn without pending tool and marks internal wait layer', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: string[] = [];
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {
        onProgressReport: (report) => {
          reports.push(report.summary);
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    await eventBus.emit({
      type: 'turn_start',
      sessionId: 'session-stalled-open-turn-no-tool',
      agentId: 'finger-system-agent',
      timestamp: new Date().toISOString(),
      payload: {
        prompt: '继续执行任务',
      },
    } as any);
    await flushEventLoop();

    const progress = monitor.getProgress('session-stalled-open-turn-no-tool');
    expect(progress).toBeTruthy();
    if (progress) {
      const now = Date.now();
      progress.startTime = now - 180_000;
      progress.lastUpdateTime = now - 65_000;
      progress.lastReportTime = now - 65_000;
      progress.status = 'running';
      progress.hasOpenTurn = true;
      progress.currentTask = '继续执行任务';
      progress.contextUsagePercent = 23;
      progress.estimatedTokensInContextWindow = 62_500;
      progress.maxInputTokens = 262_144;
    }

    await (monitor as any).generateProgressReport();

    // no pending tool: heartbeat is throttled to reduce no-value noise
    expect(reports).toHaveLength(0);

    if (progress) {
      const now = Date.now();
      progress.lastUpdateTime = now - 190_000;
      progress.lastReportTime = now - 190_000;
    }

    await (monitor as any).generateProgressReport();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('疑似卡住');
    expect(reports[0]).toContain('分层状态: 内部等待');
    expect(reports[0]).toContain('<##@system:progress:reset##>');
    expect(reports[0]).toContain('🧠 上下文: 23%');

    monitor.stop();
  });

  it('marks provider waiting as external layer instead of internal stall', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: string[] = [];
    const sessionState = new Map<string, any>();
    sessionState.set('session-provider-wait', {
      id: 'session-provider-wait',
      context: {
        executionLifecycle: {
          stage: 'waiting_model',
          substage: 'model_round',
          startedAt: new Date().toISOString(),
          lastTransitionAt: new Date().toISOString(),
          retryCount: 0,
        },
      },
    });
    const deps = createMinimalDeps();
    (deps.sessionManager as any).getSession = vi.fn((sessionId: string) => sessionState.get(sessionId) ?? null);
    const monitor = new ProgressMonitor(
      eventBus,
      deps,
      {
        onProgressReport: (report) => {
          reports.push(report.summary);
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    await eventBus.emit({
      type: 'turn_start',
      sessionId: 'session-provider-wait',
      agentId: 'finger-system-agent',
      timestamp: new Date().toISOString(),
      payload: {
        prompt: '等待 provider 返回',
      },
    } as any);
    await flushEventLoop();

    const progress = monitor.getProgress('session-provider-wait');
    expect(progress).toBeTruthy();
    if (progress) {
      const now = Date.now();
      progress.startTime = now - 180_000;
      progress.lastUpdateTime = now - 190_000;
      progress.lastReportTime = now - 190_000;
      progress.status = 'running';
      progress.hasOpenTurn = true;
    }

    await (monitor as any).generateProgressReport();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('🧠 内部阶段: waiting_model');
    expect(reports[0]).toContain('分层状态: 外部等待 · provider');
    expect(reports[0]).not.toContain('分层状态: 内部等待');
    expect(reports[0]).not.toContain('<##@system:progress:reset##>');

    monitor.stop();
  });

  it('includes recent round digest with tool and file evidence', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: string[] = [];
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {
        onProgressReport: (report) => {
          reports.push(report.summary);
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();
    const sessionId = 'session-round-digest';

    await eventBus.emit({
      type: 'tool_call',
      sessionId,
      agentId: 'finger-system-agent',
      toolId: 'rd-1',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: { cmd: 'cat src/server/modules/progress-monitor.ts' },
      },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId,
      agentId: 'finger-system-agent',
      toolId: 'rd-1',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: { cmd: 'cat src/server/modules/progress-monitor.ts' },
        output: 'ok',
      },
    } as any);
    await flushEventLoop();
    await (monitor as any).generateProgressReport();

    await eventBus.emit({
      type: 'tool_call',
      sessionId,
      agentId: 'finger-system-agent',
      toolId: 'rd-2',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: { cmd: 'rg \"waitLayer\" src/serverx/modules/progress-monitor.impl.ts' },
      },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId,
      agentId: 'finger-system-agent',
      toolId: 'rd-2',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: { cmd: 'rg \"waitLayer\" src/serverx/modules/progress-monitor.impl.ts' },
        output: 'match',
      },
    } as any);
    await flushEventLoop();
    await (monitor as any).generateProgressReport();

    expect(reports.length).toBeGreaterThanOrEqual(2);
    const latest = reports[reports.length - 1];
    expect(latest).toContain('🕘 最近轮次:');
    expect(latest).toContain('src/serverx/modules/progress-monitor.impl.ts');

    monitor.stop();
  });

  it('treats lifecycle retrying as external provider wait before timeout watchdog', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: string[] = [];
    const sessionState = new Map<string, any>();
    sessionState.set('session-retrying-provider-wait', {
      id: 'session-retrying-provider-wait',
      context: {
        executionLifecycle: {
          stage: 'retrying',
          substage: 'turn_retry',
          startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
          lastTransitionAt: new Date(Date.now() - 90_000).toISOString(),
          retryCount: 1,
          timeoutMs: 600_000,
          recoveryAction: 'retry',
          detail: 'attempt=2',
        },
      },
    });
    const deps = createMinimalDeps();
    (deps.sessionManager as any).getSession = vi.fn((sessionId: string) => sessionState.get(sessionId) ?? null);
    const monitor = new ProgressMonitor(
      eventBus,
      deps,
      {
        onProgressReport: (report) => {
          reports.push(report.summary);
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    await eventBus.emit({
      type: 'turn_start',
      sessionId: 'session-retrying-provider-wait',
      agentId: 'finger-system-agent',
      timestamp: new Date().toISOString(),
      payload: {
        prompt: '重试中，等待 provider',
      },
    } as any);
    await flushEventLoop();

    const progress = monitor.getProgress('session-retrying-provider-wait');
    expect(progress).toBeTruthy();
    if (progress) {
      const now = Date.now();
      progress.startTime = now - 180_000;
      progress.lastUpdateTime = now - 190_000;
      progress.lastReportTime = now - 190_000;
      progress.status = 'running';
      progress.hasOpenTurn = true;
    }

    await (monitor as any).generateProgressReport();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('分层状态: 外部等待 · provider');
    expect(reports[0]).toContain('retrying');
    expect(reports[0]).not.toContain('分层状态: 内部等待');
    expect(reports[0]).not.toContain('<##@system:progress:reset##>');

    monitor.stop();
  });

  it('escalates stale retrying lifecycle to internal wait with reset hint after watchdog threshold', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: string[] = [];
    const sessionState = new Map<string, any>();
    sessionState.set('session-retrying-watchdog-exceeded', {
      id: 'session-retrying-watchdog-exceeded',
      context: {
        executionLifecycle: {
          stage: 'retrying',
          substage: 'turn_retry',
          startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
          lastTransitionAt: new Date(Date.now() - (12 * 60_000 + 5_000)).toISOString(),
          retryCount: 2,
          timeoutMs: 600_000,
          recoveryAction: 'retry',
          detail: 'attempt=3',
        },
      },
    });
    const deps = createMinimalDeps();
    (deps.sessionManager as any).getSession = vi.fn((sessionId: string) => sessionState.get(sessionId) ?? null);
    const monitor = new ProgressMonitor(
      eventBus,
      deps,
      {
        onProgressReport: (report) => {
          reports.push(report.summary);
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    await eventBus.emit({
      type: 'turn_start',
      sessionId: 'session-retrying-watchdog-exceeded',
      agentId: 'finger-system-agent',
      timestamp: new Date().toISOString(),
      payload: {
        prompt: '重试超时',
      },
    } as any);
    await flushEventLoop();

    const progress = monitor.getProgress('session-retrying-watchdog-exceeded');
    expect(progress).toBeTruthy();
    if (progress) {
      const now = Date.now();
      progress.startTime = now - 1_800_000;
      progress.lastUpdateTime = now - 190_000;
      progress.lastReportTime = now - 190_000;
      progress.status = 'running';
      progress.hasOpenTurn = true;
    }

    await (monitor as any).generateProgressReport();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('分层状态: 内部等待');
    expect(reports[0]).toContain('retry watchdog exceeded');
    expect(reports[0]).toContain('<##@system:progress:reset##>');

    monitor.stop();
  });

  it('keeps tool-only running progress alive for heartbeat window, then auto-demotes to idle after prolonged inactivity', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: string[] = [];
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {
        onProgressReport: (report) => {
          reports.push(report.summary);
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    await eventBus.emit({
      type: 'tool_call',
      sessionId: 'session-tool-only-idle',
      agentId: 'finger-project-agent',
      toolId: 'tool-only-1',
      toolName: 'agent.dispatch',
      timestamp: new Date().toISOString(),
      payload: {
        input: { target_agent_id: 'finger-project-agent-2', task: 'dispatch work item' },
      },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId: 'session-tool-only-idle',
      agentId: 'finger-project-agent',
      toolId: 'tool-only-1',
      toolName: 'agent.dispatch',
      timestamp: new Date().toISOString(),
      payload: {
        input: { target_agent_id: 'finger-project-agent-2', task: 'dispatch work item' },
        output: { ok: true, status: 'queued' },
      },
    } as any);
    await flushEventLoop();

    await (monitor as any).generateProgressReport();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('工具执行阶段，等待模型回传上下文统计');
    expect(reports[0]).not.toContain('未关闭');

    const progress = monitor.getProgress('session-tool-only-idle');
    expect(progress?.status).toBe('running');

    if (progress) {
      const now = Date.now();
      progress.lastUpdateTime = now - (5 * 60_000 + 1_000);
      progress.lastReportTime = now - 190_000;
      progress.hasOpenTurn = false;
      progress.modelRoundsCount = 0;
      progress.currentTask = undefined;
      progress.latestReasoning = undefined;
    }

    await (monitor as any).generateProgressReport();
    expect(reports.length).toBeGreaterThanOrEqual(2);
    const latest = monitor.getProgress('session-tool-only-idle');
    expect(latest?.status).toBe('idle');

    monitor.stop();
  });

  it('dedups tool lines independently for system/project agents in same session', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: Array<{ agentId: string; summary: string }> = [];
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {
        onProgressReport: (report) => {
          reports.push({
            agentId: report.agentId,
            summary: report.summary,
          });
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    const sessionId = 'session-multi-agent-dedup';
    await eventBus.emit({
      type: 'tool_call',
      sessionId,
      agentId: 'finger-system-agent',
      toolId: 'sys-1',
      toolName: 'command.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: 'git status',
      },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId,
      agentId: 'finger-system-agent',
      toolId: 'sys-1',
      toolName: 'command.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: 'git status',
        output: 'ok',
      },
    } as any);

    await eventBus.emit({
      type: 'tool_call',
      sessionId,
      agentId: 'finger-project-agent',
      toolId: 'proj-1',
      toolName: 'command.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: 'pnpm build',
      },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId,
      agentId: 'finger-project-agent',
      toolId: 'proj-1',
      toolName: 'command.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: 'pnpm build',
        output: 'ok',
      },
    } as any);

    await (monitor as any).generateProgressReport();
    expect(reports).toHaveLength(2);
    const firstSystem = reports.find((item) => item.agentId === 'finger-system-agent');
    const firstProject = reports.find((item) => item.agentId === 'finger-project-agent');
    expect(firstSystem?.summary).toContain('git status');
    expect(firstProject?.summary).toContain('pnpm build');

    await eventBus.emit({
      type: 'tool_call',
      sessionId,
      agentId: 'finger-system-agent',
      toolId: 'sys-2',
      toolName: 'command.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: 'python -V',
      },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId,
      agentId: 'finger-system-agent',
      toolId: 'sys-2',
      toolName: 'command.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: 'python -V',
        output: 'ok',
      },
    } as any);

    await (monitor as any).generateProgressReport();
    expect(reports).toHaveLength(3);
    const latest = reports[2];
    expect(latest.agentId).toBe('finger-system-agent');
    expect(latest.summary).toContain('python -V');
    expect(latest.summary).toContain('🕘 最近轮次');
    expect(latest.summary).not.toContain('pnpm build');

    monitor.stop();
  });

  it('marks progress completed when self-target dispatch reports completed (without waiting model_round close)', async () => {
    const eventBus = new UnifiedEventBus();
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {},
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    await eventBus.emit({
      type: 'agent_runtime_status',
      sessionId: 'session-reviewer-close',
      agentId: 'finger-reviewer',
      timestamp: new Date().toISOString(),
      payload: {
        status: 'running',
        summary: '执行中',
      },
    } as any);

    await eventBus.emit({
      type: 'agent_runtime_dispatch',
      sessionId: 'session-reviewer-close',
      agentId: 'finger-reviewer',
      timestamp: new Date().toISOString(),
      payload: {
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-reviewer',
        status: 'completed',
      },
    } as any);

    await flushEventLoop();

    const progress = monitor.getProgress('session-reviewer-close');
    expect(progress).toBeTruthy();
    expect(progress?.status).toBe('completed');
    expect(progress?.currentTask).toContain('派发 finger-reviewer (completed)');

    monitor.stop();
  });

  it('does not apply heartbeat session context stats into business session progress', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: Array<{ sessionId: string; summary: string }> = [];
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {
        onProgressReport: (report) => {
          reports.push({
            sessionId: report.sessionId,
            summary: report.summary,
          });
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    const businessSessionId = 'session-business-context-isolated';
    await eventBus.emit({
      type: 'tool_call',
      sessionId: businessSessionId,
      agentId: 'finger-system-agent',
      toolId: 't1',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: { cmd: 'echo phase-1' },
      },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId: businessSessionId,
      agentId: 'finger-system-agent',
      toolId: 't1',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: { cmd: 'echo phase-1' },
        output: 'ok',
      },
    } as any);
    await flushEventLoop();

    await (monitor as any).generateProgressReport();
    expect(reports).toHaveLength(1);
    expect(reports[0].sessionId).toBe(businessSessionId);
    expect(reports[0].summary).toContain('工具执行阶段，等待模型回传上下文统计');

    // Heartbeat session sends auto compact probe context stats.
    // Business session progress must stay isolated and MUST NOT inherit heartbeat stats.
    await eventBus.emit({
      type: 'system_notice',
      sessionId: 'hb-session-finger-system-agent-global',
      timestamp: new Date().toISOString(),
      payload: {
        source: 'auto_compact_probe',
        agentId: 'finger-system-agent',
        contextUsagePercent: 33,
        estimatedTokensInContextWindow: 86000,
        maxInputTokens: 262000,
      },
    } as any);
    await flushEventLoop();

    await eventBus.emit({
      type: 'tool_call',
      sessionId: businessSessionId,
      agentId: 'finger-system-agent',
      toolId: 't2',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: { cmd: 'echo phase-2' },
      },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId: businessSessionId,
      agentId: 'finger-system-agent',
      toolId: 't2',
      toolName: 'shell.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: { cmd: 'echo phase-2' },
        output: 'ok',
      },
    } as any);
    await flushEventLoop();

    await (monitor as any).generateProgressReport();
    expect(reports).toHaveLength(2);
    expect(reports[1].summary).toContain('工具执行阶段，等待模型回传上下文统计');
    expect(reports[1].summary).not.toContain('/262k');

    monitor.stop();
  });

  it('stops heartbeat spam when waiting_for_user is emitted', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: string[] = [];
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {
        onProgressReport: (report) => {
          reports.push(report.summary);
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    const sessionId = 'session-waiting-user-no-heartbeat';
    await eventBus.emit({
      type: 'tool_call',
      sessionId,
      agentId: 'finger-system-agent',
      toolId: 'pending-1',
      toolName: 'exec_command',
      timestamp: new Date().toISOString(),
      payload: {
        input: { cmd: 'long-running-op' },
      },
    } as any);
    await flushEventLoop();

    const beforeWaiting = monitor.getProgress(sessionId);
    expect(beforeWaiting?.status).toBe('running');
    if (beforeWaiting) {
      beforeWaiting.lastUpdateTime = Date.now() - 61_000;
      beforeWaiting.lastReportTime = Date.now() - 61_000;
    }
    await (monitor as any).generateProgressReport();
    expect(reports.length).toBeGreaterThan(0);

    await eventBus.emit({
      type: 'waiting_for_user',
      sessionId,
      workflowId: sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        reason: 'confirmation_required',
        options: [],
        context: {
          question: '需要用户回复后继续',
        },
      },
    } as any);
    await flushEventLoop();

    const afterWaiting = monitor.getProgress(sessionId);
    expect(afterWaiting?.status).toBe('idle');
    expect(afterWaiting?.currentTask).toContain('需要用户回复后继续');

    if (afterWaiting) {
      afterWaiting.lastUpdateTime = Date.now() - 61_000;
      afterWaiting.lastReportTime = Date.now() - 61_000;
    }
    const reportCountBefore = reports.length;
    await (monitor as any).generateProgressReport();
    expect(reports.length).toBe(reportCountBefore);

    monitor.stop();
  });

  it('does not resume running heartbeat after turn_complete + stop_gate system_notice', async () => {
    const eventBus = new UnifiedEventBus();
    const reports: string[] = [];
    const monitor = new ProgressMonitor(
      eventBus,
      createMinimalDeps(),
      {
        onProgressReport: (report) => {
          reports.push(report.summary);
        },
      },
      {
        enabled: true,
        progressUpdates: true,
        intervalMs: 60_000,
      },
    );

    monitor.start();

    const sessionId = 'session-stop-gate-no-heartbeat-resume';
    await eventBus.emit({
      type: 'turn_start',
      sessionId,
      agentId: 'finger-system-agent',
      timestamp: new Date().toISOString(),
      payload: {
        prompt: '继续执行任务',
      },
    } as any);
    await flushEventLoop();

    const runningProgress = monitor.getProgress(sessionId);
    expect(runningProgress?.status).toBe('running');
    if (runningProgress) {
      const now = Date.now();
      runningProgress.startTime = now - 180_000;
      runningProgress.lastUpdateTime = now - 190_000;
      runningProgress.lastReportTime = now - 190_000;
      runningProgress.hasOpenTurn = true;
    }
    await (monitor as any).generateProgressReport();
    expect(reports.length).toBeGreaterThan(0);

    await eventBus.emit({
      type: 'turn_complete',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        finishReason: 'stop',
        replyPreview: 'done',
      },
    } as any);
    await eventBus.emit({
      type: 'system_notice',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        source: 'stop_gate',
        hold: true,
      },
    } as any);
    await flushEventLoop();

    const afterComplete = monitor.getProgress(sessionId);
    expect(afterComplete?.status).toBe('idle');
    if (afterComplete) {
      afterComplete.lastUpdateTime = Date.now() - 65_000;
      afterComplete.lastReportTime = Date.now() - 65_000;
    }
    const reportCountBefore = reports.length;
    await (monitor as any).generateProgressReport();
    expect(reports.length).toBe(reportCountBefore);

    monitor.stop();
  });
});
