import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  DailySummaryScheduler,
  calculateDeltaSlots,
  isHourInWindow,
  type DailySummaryTaskSpec,
} from '../../../src/server/modules/daily-summary-scheduler.js';

function writeLedger(filePath: string, lineCount: number): void {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i += 1) {
    lines.push(JSON.stringify({ id: `x-${i}`, timestamp_ms: 1775430000000 + i }));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

describe('daily-summary-scheduler helpers', () => {
  it('isHourInWindow supports same-day windows', () => {
    expect(isHourInWindow(0, 0, 7)).toBe(true);
    expect(isHourInWindow(7, 0, 7)).toBe(true);
    expect(isHourInWindow(8, 0, 7)).toBe(false);
  });

  it('isHourInWindow supports cross-day windows', () => {
    expect(isHourInWindow(23, 22, 3)).toBe(true);
    expect(isHourInWindow(2, 22, 3)).toBe(true);
    expect(isHourInWindow(12, 22, 3)).toBe(false);
  });

  it('calculateDeltaSlots resets on ledger rotation', () => {
    expect(calculateDeltaSlots(10, 5)).toEqual({ lastSummarySlot: 5, deltaSlots: 5, reset: false });
    expect(calculateDeltaSlots(3, 8)).toEqual({ lastSummarySlot: 0, deltaSlots: 3, reset: true });
  });
});

describe('DailySummaryScheduler task execution', () => {
  it('skips dispatch when delta slots is zero', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-summary-'));
    const ledgerPath = path.join(tmpDir, 'context-ledger.jsonl');
    const stateFile = path.join(tmpDir, 'state.json');
    const runtimeLog = path.join(tmpDir, 'runtime.log');
    writeLedger(ledgerPath, 3);
    fs.writeFileSync(stateFile, JSON.stringify({ lastSummarySlot: 3 }, null, 2));

    const dispatchTaskToAgent = vi.fn(async () => ({ dispatchId: 'd-1', status: 'queued' }));
    const spec: DailySummaryTaskSpec = {
      key: 'system',
      targetAgentId: 'finger-system-agent',
      source: 'daily-analysis-builtin',
      title: '每日系统分析',
      outputFileBuilder: (date) => path.join(tmpDir, `${date}.md`),
      stateFile,
      resolveLedgerPath: () => ledgerPath,
    };

    const scheduler = new DailySummaryScheduler(
      { dispatchTaskToAgent },
      {
        enabled: true,
        tickMs: 60_000,
        windowStartHour: 0,
        windowEndHour: 23,
        runtimeLogFile: runtimeLog,
      },
      [spec],
    );

    await (scheduler as any).processTask(spec, new Date('2026-04-06T01:00:00.000Z'));

    expect(dispatchTaskToAgent).not.toHaveBeenCalled();
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { lastSummarySlot: number };
    expect(state.lastSummarySlot).toBe(3);
    const logContent = fs.readFileSync(runtimeLog, 'utf8');
    expect(logContent).toContain('no new slots');
  });

  it('dispatches and advances state when delta exists', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-summary-'));
    const ledgerPath = path.join(tmpDir, 'context-ledger.jsonl');
    const stateFile = path.join(tmpDir, 'state.json');
    const runtimeLog = path.join(tmpDir, 'runtime.log');
    writeLedger(ledgerPath, 5);
    fs.writeFileSync(stateFile, JSON.stringify({ lastSummarySlot: 2 }, null, 2));

    const dispatchTaskToAgent = vi.fn(async () => ({ dispatchId: 'd-2', status: 'queued' }));
    const spec: DailySummaryTaskSpec = {
      key: 'project',
      targetAgentId: 'finger-project-agent',
      source: 'daily-project-analysis-builtin',
      title: '每日项目分析',
      outputFileBuilder: (date) => path.join(tmpDir, `${date}-project.md`),
      stateFile,
      resolveLedgerPath: () => ledgerPath,
    };

    const scheduler = new DailySummaryScheduler(
      { dispatchTaskToAgent },
      {
        enabled: true,
        tickMs: 60_000,
        windowStartHour: 0,
        windowEndHour: 23,
        runtimeLogFile: runtimeLog,
      },
      [spec],
    );

    await (scheduler as any).processTask(spec, new Date('2026-04-06T01:00:00.000Z'));

    expect(dispatchTaskToAgent).toHaveBeenCalledTimes(1);
    const call = dispatchTaskToAgent.mock.calls[0][0] as { metadata?: Record<string, unknown>; targetAgentId: string };
    expect(call.targetAgentId).toBe('finger-project-agent');
    expect(call.metadata?.dailySummary).toBe(true);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { lastSummarySlot: number; lastDispatchAt?: string };
    expect(state.lastSummarySlot).toBe(5);
    expect(typeof state.lastDispatchAt).toBe('string');
  });
});
