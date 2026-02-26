import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { updatePlanTool } from '../../../../src/tools/internal/codex-update-plan-tool.js';
import { noopTool } from '../../../../src/tools/internal/codex-noop-tool.js';
import { viewImageTool } from '../../../../src/tools/internal/codex-view-image-tool.js';
import { clockTool } from '../../../../src/tools/internal/codex-clock-tool.js';
import { codexShellTool } from '../../../../src/tools/internal/codex-shell-tool.js';
import { unifiedExecTool } from '../../../../src/tools/internal/codex-unified-exec-tool.js';
import { createWebSearchTool } from '../../../../src/tools/internal/codex-web-search-tool.js';

const TEST_CONTEXT = {
  invocationId: 'codex-extra-tools-test',
  cwd: process.cwd(),
  timestamp: new Date().toISOString(),
};

describe('codex extra tools', () => {
  it('update_plan accepts valid plan', async () => {
    const result = await updatePlanTool.execute({
      explanation: 'doing work',
      plan: [
        { step: 'step-1', status: 'in_progress' },
        { step: 'step-2', status: 'pending' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.plan).toHaveLength(2);
  });

  it('update_plan rejects multiple in_progress steps', async () => {
    await expect(
      updatePlanTool.execute({
        plan: [
          { step: 'step-1', status: 'in_progress' },
          { step: 'step-2', status: 'in_progress' },
        ],
      }),
    ).rejects.toThrow('at most one');
  });

  it('no-op returns structured progress output', async () => {
    const result = await noopTool.execute({
      progress: '编译中',
      details: '正在下载依赖',
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('编译中');
  });

  it('view_image validates local image file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-view-image-'));
    try {
      const imagePath = path.join(dir, 'demo.png');
      writeFileSync(
        imagePath,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      const result = await viewImageTool.execute(
        { path: imagePath },
        { ...TEST_CONTEXT, cwd: dir },
      );
      expect(result.ok).toBe(true);
      expect(result.mimeType).toBe('image/png');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clock supports create/list/cancel', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-clock-tool-'));
    const storePath = path.join(dir, 'clock.json');
    const oldStorePath = process.env.FINGER_CLOCK_STORE_PATH;
    process.env.FINGER_CLOCK_STORE_PATH = storePath;
    try {
      const created = await clockTool.execute({
        action: 'create',
        payload: {
          message: 'review code',
          schedule_type: 'delay',
          delay_seconds: 120,
        },
      });
      expect(created.ok).toBe(true);
      const timerId = created.timer_id;
      expect(timerId).toBeTruthy();

      const listed = await clockTool.execute({
        action: 'list',
        payload: { status: 'active' },
      });
      expect(listed.ok).toBe(true);
      expect(Array.isArray((listed.data as { timers?: unknown[] }).timers)).toBe(true);

      const canceled = await clockTool.execute({
        action: 'cancel',
        payload: { timer_id: timerId },
      });
      expect(canceled.ok).toBe(true);
      expect(canceled.action).toBe('cancel');
    } finally {
      if (oldStorePath === undefined) {
        delete process.env.FINGER_CLOCK_STORE_PATH;
      } else {
        process.env.FINGER_CLOCK_STORE_PATH = oldStorePath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clock supports cron schedule', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-clock-cron-'));
    const storePath = path.join(dir, 'clock.json');
    const oldStorePath = process.env.FINGER_CLOCK_STORE_PATH;
    process.env.FINGER_CLOCK_STORE_PATH = storePath;
    try {
      const created = await clockTool.execute({
        action: 'create',
        payload: {
          message: 'cron reminder',
          schedule_type: 'cron',
          cron: '*/5 * * * *',
          timezone: 'UTC',
        },
      });
      expect(created.ok).toBe(true);
      expect(created.action).toBe('create');
      const schedule = (created.data as { schedule?: Record<string, unknown> }).schedule;
      expect(schedule?.schedule_type).toBe('cron');
      expect(schedule?.cron).toBe('*/5 * * * *');
    } finally {
      if (oldStorePath === undefined) {
        delete process.env.FINGER_CLOCK_STORE_PATH;
      } else {
        process.env.FINGER_CLOCK_STORE_PATH = oldStorePath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shell runs command array', async () => {
    const result = await codexShellTool.execute(
      { command: ['bash', '-lc', 'echo codex_shell_ok'] },
      TEST_CONTEXT,
    );
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('codex_shell_ok');
  });

  it('unified_exec supports create-session then write', async () => {
    const initial = await unifiedExecTool.execute(
      { input: ['cat'], timeout_ms: 50 },
      TEST_CONTEXT,
    );
    expect(initial.termination.type).toBe('ongoing');
    const sessionId = initial.session_id;
    expect(typeof sessionId).toBe('number');

    const wrote = await unifiedExecTool.execute(
      {
        session_id: String(sessionId),
        input: ['hello-from-unified\n'],
        timeout_ms: 300,
      },
      TEST_CONTEXT,
    );
    expect(wrote.ok).toBe(true);
    expect(wrote.output).toContain('hello-from-unified');

    await unifiedExecTool.execute(
      {
        session_id: String(sessionId),
        input: ['\u0003'],
        timeout_ms: 200,
      },
      TEST_CONTEXT,
    );
  });

  it('web_search can be injected with custom performer', async () => {
    const tool = createWebSearchTool(async (query) => ({
      success: true,
      provider: 'mock',
      attemptedProviders: ['mock'],
      results: [{ title: 'ok', url: `https://example.com?q=${encodeURIComponent(query)}` }],
    }));
    const result = await tool.execute({ query: 'finger test' });
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('mock');
    expect(result.results).toHaveLength(1);
  });
});
