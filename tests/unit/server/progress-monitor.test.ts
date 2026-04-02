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
      payload: { input: { cmd: 'rg \"context\" src/server/modules/progress-monitor-event-handlers.ts' } },
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
        input: 'echo system-first',
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
        input: 'echo system-first',
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
        input: 'echo project-first',
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
        input: 'echo project-first',
        output: 'ok',
      },
    } as any);

    await (monitor as any).generateProgressReport();
    expect(reports).toHaveLength(2);
    const firstSystem = reports.find((item) => item.agentId === 'finger-system-agent');
    const firstProject = reports.find((item) => item.agentId === 'finger-project-agent');
    expect(firstSystem?.summary).toContain('system-first');
    expect(firstProject?.summary).toContain('project-first');

    await eventBus.emit({
      type: 'tool_call',
      sessionId,
      agentId: 'finger-system-agent',
      toolId: 'sys-2',
      toolName: 'command.exec',
      timestamp: new Date().toISOString(),
      payload: {
        input: 'echo system-second',
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
        input: 'echo system-second',
        output: 'ok',
      },
    } as any);

    await (monitor as any).generateProgressReport();
    expect(reports).toHaveLength(3);
    const latest = reports[2];
    expect(latest.agentId).toBe('finger-system-agent');
    expect(latest.summary).toContain('system-second');
    expect(latest.summary).not.toContain('system-first');
    expect(latest.summary).not.toContain('project-first');

    monitor.stop();
  });
});
