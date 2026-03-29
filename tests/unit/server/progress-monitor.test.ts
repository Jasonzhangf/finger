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

    const progress = monitor.getProgress('session-progress-delta');
    expect(progress).toBeTruthy();
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
    expect(updated).toBeTruthy();
    if (updated) updated.elapsedMs = 8000;

    await (monitor as any).generateProgressReport();

    expect(reports).toHaveLength(2);
    expect(reports[1]).toContain('rg');
    expect(reports[1]).not.toContain('🧭 shell.exec → ✅');
    expect(reports[1]).not.toContain('💭 需要检查 event-forwarding.ts 的逻辑');

    monitor.stop();
  });

  it('reports context window size and pushes update when context usage changes', async () => {
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

    const initial = monitor.getProgress('session-context-usage');
    expect(initial).toBeTruthy();
    if (initial) initial.elapsedMs = 4000;

    await (monitor as any).generateProgressReport();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('🧠 上下文: 41% · 53.2k/128k');

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
    expect(updated).toBeTruthy();
    if (updated) updated.elapsedMs = 6000;

    await (monitor as any).generateProgressReport();
    expect(reports).toHaveLength(2);
    expect(reports[1]).toContain('🧠 上下文: 55% · 70.4k/128k');
    expect(reports[1]).toContain('🧭 处理上下文');

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
});
