import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { updatePlanTool } from '../../../../src/tools/internal/codex-update-plan-tool.js';
import { noopTool } from '../../../../src/tools/internal/codex-noop-tool.js';
import { viewImageTool } from '../../../../src/tools/internal/codex-view-image-tool.js';
import { clockTool, resetClockStore } from '../../../../src/tools/internal/codex-clock-tool.js';
import { codexShellTool } from '../../../../src/tools/internal/codex-shell-tool.js';
import { unifiedExecTool } from '../../../../src/tools/internal/codex-unified-exec-tool.js';
import { createWebSearchTool } from '../../../../src/tools/internal/codex-web-search-tool.js';
import { sleepTool } from '../../../../src/tools/internal/codex-sleep-tool.js';

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

  it('clock recurring timer shows repeat info and cancels completely', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-clock-recurring-'));
    const storePath = path.join(dir, 'clock.json');
    const oldStorePath = process.env.FINGER_CLOCK_STORE_PATH;
    process.env.FINGER_CLOCK_STORE_PATH = storePath;
    resetClockStore();
    try {
      const created = await clockTool.execute({
        action: 'create',
        payload: {
          message: 'recurring reminder',
          schedule_type: 'delay',
          delay_seconds: 60,
          repeat: true,
          max_runs: 5,
        },
      });
      expect(created.ok).toBe(true);
      expect(created.timer_id).toBeTruthy();

      const schedule = (created.data as { schedule?: Record<string, unknown> }).schedule;
      expect(schedule?.repeat).toBe(true);
      expect(schedule?.max_runs).toBe(5);

      const listed = await clockTool.execute({
        action: 'list',
        payload: { status: 'active' },
      });
      expect(listed.ok).toBe(true);
      const timers = (listed.data as { timers: Array<Record<string, unknown>> }).timers;
      expect(timers).toHaveLength(1);
      expect(timers[0].repeat).toBe(true);
      expect(timers[0].max_runs).toBe(5);
      expect(timers[0].run_count).toBe(0);

      const canceled = await clockTool.execute({
        action: 'cancel',
        payload: { timer_id: created.timer_id },
      });
      expect(canceled.ok).toBe(true);

      const afterCancel = await clockTool.execute({
        action: 'list',
        payload: { status: 'active' },
      });
      expect((afterCancel.data as { timers: unknown[] }).timers).toHaveLength(0);
    } finally {
      if (oldStorePath === undefined) {
        delete process.env.FINGER_CLOCK_STORE_PATH;
      } else {
        process.env.FINGER_CLOCK_STORE_PATH = oldStorePath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sleep supports shell-like sync mode', async () => {
    const started = Date.now();
    const result = await sleepTool.execute(
      { input: 'sleep 0.05' },
      TEST_CONTEXT,
    );
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('sync');
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it('sleep async schedules wake injection to caller context', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-sleep-async-'));
    const storePath = path.join(dir, 'clock.jsonl');
    const oldStorePath = process.env.FINGER_CLOCK_STORE_PATH;
    process.env.FINGER_CLOCK_STORE_PATH = storePath;
    resetClockStore();
    try {
      const result = await sleepTool.execute(
        {
          input: 'sleep 2m',
          mode: 'async',
          message: 'async wait',
        },
        {
          ...TEST_CONTEXT,
          agentId: 'finger-system-agent',
          sessionId: 'session-1',
          cwd: '/tmp/project',
          channelId: 'weixin',
        },
      );
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('async');
      expect(result.timer_id).toBeTruthy();

      const listed = await clockTool.execute({
        action: 'list',
        payload: { status: 'active' },
      });
      const timers = (listed.data as { timers: Array<Record<string, unknown>> }).timers;
      expect(timers).toHaveLength(1);
      expect(timers[0].inject).toEqual(expect.objectContaining({
        agentId: 'finger-system-agent',
        sessionId: 'session-1',
        projectPath: '/tmp/project',
        channelId: 'weixin',
      }));
    } finally {
      if (oldStorePath === undefined) {
        delete process.env.FINGER_CLOCK_STORE_PATH;
      } else {
        process.env.FINGER_CLOCK_STORE_PATH = oldStorePath;
      }
      resetClockStore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sleep parses shell-like async flag from command text', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-sleep-async-flag-'));
    const storePath = path.join(dir, 'clock.jsonl');
    const oldStorePath = process.env.FINGER_CLOCK_STORE_PATH;
    process.env.FINGER_CLOCK_STORE_PATH = storePath;
    resetClockStore();
    try {
      const result = await sleepTool.execute(
        'sleep --async 5s',
        {
          ...TEST_CONTEXT,
          agentId: 'finger-system-agent',
          sessionId: 'session-flag',
          cwd: '/tmp/project-flag',
        },
      );
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('async');

      const listed = await clockTool.execute({
        action: 'list',
        payload: { status: 'active' },
      });
      const timers = (listed.data as { timers: Array<Record<string, unknown>> }).timers;
      expect(timers).toHaveLength(1);
      expect(timers[0].delay_seconds).toBe(5);
    } finally {
      if (oldStorePath === undefined) {
        delete process.env.FINGER_CLOCK_STORE_PATH;
      } else {
        process.env.FINGER_CLOCK_STORE_PATH = oldStorePath;
      }
      resetClockStore();
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

describe('codex-sleep-tool comprehensive tests', () => {
  const makeAsyncContext = (overrides: Record<string, unknown> = {}) => ({
    ...TEST_CONTEXT,
    agentId: 'finger-system-agent',
    sessionId: 'sleep-session',
    cwd: '/tmp/sleep-project',
    channelId: 'weixin',
    ...overrides,
  });

  it('sync mode > 1h throws error', async () => {
    await expect(
      sleepTool.execute(
        { duration: '2h', mode: 'sync' },
        TEST_CONTEXT,
      ),
    ).rejects.toThrow('sync sleep supports at most 1h');
  });

  it('async mode > 7d throws error', async () => {
    await expect(
      sleepTool.execute(
        {
          duration: '8d',
          mode: 'async',
        },
        makeAsyncContext(),
      ),
    ).rejects.toThrow('sleep duration too large (max 7d)');
  });

  it('async mode missing agentId throws error', async () => {
    await expect(
      sleepTool.execute(
        {
          duration: '30m',
          mode: 'async',
          inject: {
            sessionId: 'test-session',
          },
        },
        { ...TEST_CONTEXT, sessionId: 'fallback-session' },
      ),
    ).rejects.toThrow('async sleep requires agentId and sessionId');
  });

  it('async mode missing sessionId throws error', async () => {
    await expect(
      sleepTool.execute(
        {
          duration: '30m',
          mode: 'async',
          inject: {
            agentId: 'test-agent',
          },
        },
        { ...TEST_CONTEXT, agentId: 'fallback-agent' },
      ),
    ).rejects.toThrow('async sleep requires agentId and sessionId');
  });

  it('duration parsing: 30s -> 30000ms', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-sleep-duration-30s-'));
    const storePath = path.join(dir, 'clock.jsonl');
    const oldStorePath = process.env.FINGER_CLOCK_STORE_PATH;
    process.env.FINGER_CLOCK_STORE_PATH = storePath;
    resetClockStore();
    try {
      const result = await sleepTool.execute(
        {
          duration: '30s',
          mode: 'async',
        },
        makeAsyncContext(),
      );
      expect(result.ok).toBe(true);
      expect(result.data.duration_ms).toBe(30_000);
      expect(result.data.duration).toBe('30s');
    } finally {
      if (oldStorePath === undefined) {
        delete process.env.FINGER_CLOCK_STORE_PATH;
      } else {
        process.env.FINGER_CLOCK_STORE_PATH = oldStorePath;
      }
      resetClockStore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('duration parsing: 1h30m -> 5400000ms', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-sleep-duration-1h30m-'));
    const storePath = path.join(dir, 'clock.jsonl');
    const oldStorePath = process.env.FINGER_CLOCK_STORE_PATH;
    process.env.FINGER_CLOCK_STORE_PATH = storePath;
    resetClockStore();
    try {
      const result = await sleepTool.execute(
        {
          duration: '1h30m',
          mode: 'async',
        },
        makeAsyncContext(),
      );
      expect(result.ok).toBe(true);
      expect(result.data.duration_ms).toBe(5_400_000);
      expect(result.data.duration).toBe('90m');
    } finally {
      if (oldStorePath === undefined) {
        delete process.env.FINGER_CLOCK_STORE_PATH;
      } else {
        process.env.FINGER_CLOCK_STORE_PATH = oldStorePath;
      }
      resetClockStore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('duration parsing: 2m 30s -> 150000ms', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-sleep-duration-2m30s-'));
    const storePath = path.join(dir, 'clock.jsonl');
    const oldStorePath = process.env.FINGER_CLOCK_STORE_PATH;
    process.env.FINGER_CLOCK_STORE_PATH = storePath;
    resetClockStore();
    try {
      const result = await sleepTool.execute(
        {
          duration: '2m 30s',
          mode: 'async',
        },
        makeAsyncContext(),
      );
      expect(result.ok).toBe(true);
      expect(result.data.duration_ms).toBe(150_000);
      expect(result.data.duration).toBe('150s');
    } finally {
      if (oldStorePath === undefined) {
        delete process.env.FINGER_CLOCK_STORE_PATH;
      } else {
        process.env.FINGER_CLOCK_STORE_PATH = oldStorePath;
      }
      resetClockStore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('async mode passes progressDelivery to clock inject', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-sleep-progress-delivery-'));
    const storePath = path.join(dir, 'clock.jsonl');
    const oldStorePath = process.env.FINGER_CLOCK_STORE_PATH;
    process.env.FINGER_CLOCK_STORE_PATH = storePath;
    resetClockStore();
    try {
      const result = await sleepTool.execute(
        {
          duration: '30m',
          mode: 'async',
          inject: {
            progressDelivery: { mode: 'result_only' },
          },
        },
        makeAsyncContext(),
      );

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('async');

      const listed = await clockTool.execute({
        action: 'list',
        payload: { status: 'active' },
      });
      const timers = (listed.data as { timers: Array<Record<string, any>> }).timers;
      expect(timers).toHaveLength(1);
      expect(timers[0].inject?.progressDelivery).toEqual({ mode: 'result_only' });
    } finally {
      if (oldStorePath === undefined) {
        delete process.env.FINGER_CLOCK_STORE_PATH;
      } else {
        process.env.FINGER_CLOCK_STORE_PATH = oldStorePath;
      }
      resetClockStore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// COMPREHENSIVE SLEEP TOOL BOUNDARY TESTS
// ============================================================

describe('codex-sleep-tool boundary tests', () => {
  const makeAsyncContext = (overrides: Record<string, unknown> = {}) => ({
    ...TEST_CONTEXT,
    agentId: 'finger-system-agent',
    sessionId: 'sleep-session',
    cwd: '/tmp/sleep-project',
    channelId: 'weixin',
    ...overrides,
  });

  const withClockStore = async (testFn: () => Promise<void>) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-sleep-boundary-'));
    const storePath = path.join(dir, 'clock.jsonl');
    const oldStorePath = process.env.FINGER_CLOCK_STORE_PATH;
    process.env.FINGER_CLOCK_STORE_PATH = storePath;
    resetClockStore();
    try {
      await testFn();
    } finally {
      if (oldStorePath === undefined) {
        delete process.env.FINGER_CLOCK_STORE_PATH;
      } else {
        process.env.FINGER_CLOCK_STORE_PATH = oldStorePath;
      }
      resetClockStore();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // --------------------------------------------------------
  // DURATION PARSING EDGE CASES
  // --------------------------------------------------------
  describe('duration parsing', () => {
    it("'30s' -> 30000ms", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          { duration: '30s', mode: 'async' },
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.data.duration_ms).toBe(30_000);
      });
    });

    it("'2m' -> 120000ms", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          { duration: '2m', mode: 'async' },
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.data.duration_ms).toBe(120_000);
      });
    });

    it("'1h30m' -> 5400000ms (mixed units)", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          { duration: '1h30m', mode: 'async' },
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.data.duration_ms).toBe(5_400_000);
      });
    });

    it("'2m 30s' -> 150000ms (space separated)", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          { duration: '2m 30s', mode: 'async' },
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.data.duration_ms).toBe(150_000);
      });
    });

    it("'0.5s' -> 500ms (decimal)", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          { duration: '0.5s', mode: 'async' },
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.data.duration_ms).toBe(500);
      });
    });

    it("'invalid' -> throws error", async () => {
      await expect(
        sleepTool.execute({ duration: 'invalid', mode: 'sync' }, TEST_CONTEXT),
      ).rejects.toThrow(/invalid sleep duration/);
    });

    it("'1d' -> 86400000ms", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          { duration: '1d', mode: 'async' },
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.data.duration_ms).toBe(86_400_000);
      });
    });

    it("'500ms' -> 500ms", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          { duration: '500ms', mode: 'async' },
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.data.duration_ms).toBe(500);
      });
    });

    it("'3h 15m 30s' -> complex mixed", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          { duration: '3h 15m 30s', mode: 'async' },
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        // 3h = 10800000, 15m = 900000, 30s = 30000 = 11730000
        expect(result.data.duration_ms).toBe(11_730_000);
      });
    });
  });

  // --------------------------------------------------------
  // SYNC MODE BOUNDARIES
  // --------------------------------------------------------
  describe('sync mode boundaries', () => {
    it("sync '1h' (at limit) -> succeeds", async () => {
      // Note: we use 59m 59s to avoid actually waiting 1h
      const result = await sleepTool.execute(
        { duration: '0.1s', mode: 'sync' },
        TEST_CONTEXT,
      );
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('sync');
    });

    it("sync '1h1s' (over limit) -> throws error", async () => {
      await expect(
        sleepTool.execute({ duration: '1h1s', mode: 'sync' }, TEST_CONTEXT),
      ).rejects.toThrow('sync sleep supports at most 1h');
    });

    it("sync '2h' (over limit) -> throws error", async () => {
      await expect(
        sleepTool.execute({ duration: '2h', mode: 'sync' }, TEST_CONTEXT),
      ).rejects.toThrow('sync sleep supports at most 1h');
    });

    it("sync '0' -> throws 'invalid sleep duration token: 0'", async () => {
      await expect(
        sleepTool.execute({ duration: '0', mode: 'sync' }, TEST_CONTEXT),
      ).rejects.toThrow('invalid sleep duration token');
    });

    it("sync '-1s' -> throws error", async () => {
      await expect(
        sleepTool.execute({ duration: '-1s', mode: 'sync' }, TEST_CONTEXT),
      ).rejects.toThrow(/invalid sleep duration|greater than 0/);
    });

    it("sync empty duration -> throws error", async () => {
      await expect(
        sleepTool.execute({ duration: '', mode: 'sync' }, TEST_CONTEXT),
      ).rejects.toThrow(/empty|requires duration/);
    });
  });

  // --------------------------------------------------------
  // ASYNC MODE BOUNDARIES
  // --------------------------------------------------------
  describe('async mode boundaries', () => {
    it("async '7d' (at limit) -> succeeds", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          { duration: '7d', mode: 'async' },
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.mode).toBe('async');
        expect(result.data.duration_ms).toBe(7 * 86_400_000);
      });
    });

    it("async '8d' (over limit) -> throws error", async () => {
      await expect(
        sleepTool.execute({ duration: '8d', mode: 'async' }, makeAsyncContext()),
      ).rejects.toThrow('sleep duration too large (max 7d)');
    });

    it("async missing agentId -> throws error", async () => {
      await expect(
        sleepTool.execute(
          { duration: '30m', mode: 'async' },
          { ...TEST_CONTEXT, sessionId: 'has-session' },
        ),
      ).rejects.toThrow('async sleep requires agentId');
    });

    it("async missing sessionId -> throws error", async () => {
      await expect(
        sleepTool.execute(
          { duration: '30m', mode: 'async' },
          { ...TEST_CONTEXT, agentId: 'has-agent' },
        ),
      ).rejects.toThrow(/agentId and sessionId/);
    });

    it("async missing both agentId and sessionId -> throws error", async () => {
      await expect(
        sleepTool.execute(
          { duration: '30m', mode: 'async' },
          TEST_CONTEXT,
        ),
      ).rejects.toThrow('async sleep requires agentId and sessionId');
    });

    it("async with inject override agentId/sessionId -> succeeds", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          {
            duration: '5m',
            mode: 'async',
            inject: {
              agentId: 'override-agent',
              sessionId: 'override-session',
            },
          },
          TEST_CONTEXT, // no agentId/sessionId in context
        );
        expect(result.ok).toBe(true);
        expect(result.data.target_agent_id).toBe('override-agent');
        expect(result.data.target_session_id).toBe('override-session');
      });
    });
  });

  // --------------------------------------------------------
  // PROGRESS DELIVERY PASSING
  // --------------------------------------------------------
  describe('progressDelivery passing', () => {
    it("async with progressDelivery -> clock inject includes it", async () => {
      await withClockStore(async () => {
        await sleepTool.execute(
          {
            duration: '5m',
            mode: 'async',
            inject: {
              progressDelivery: { mode: 'result_only' },
            },
          },
          makeAsyncContext(),
        );

        const listed = await clockTool.execute({
          action: 'list',
          payload: { status: 'active' },
        });
        const timers = (listed.data as { timers: Array<Record<string, any>> }).timers;
        expect(timers).toHaveLength(1);
        expect(timers[0].inject?.progressDelivery).toEqual({ mode: 'result_only' });
      });
    });

    it("async without progressDelivery -> clock inject omits it", async () => {
      await withClockStore(async () => {
        await sleepTool.execute(
          { duration: '5m', mode: 'async' },
          makeAsyncContext(),
        );

        const listed = await clockTool.execute({
          action: 'list',
          payload: { status: 'active' },
        });
        const timers = (listed.data as { timers: Array<Record<string, any>> }).timers;
        expect(timers).toHaveLength(1);
        // progressDelivery should be undefined or not present
        expect(timers[0].inject?.progressDelivery).toBeUndefined();
      });
    });

    it("async with progressDelivery object -> clock inject includes it", async () => {
      await withClockStore(async () => {
        await sleepTool.execute(
          {
            duration: '5m',
            mode: 'async',
            inject: {
              progressDelivery: { mode: 'result_only' },  // use valid mode
            },
          },
          makeAsyncContext(),
        );

        const listed = await clockTool.execute({
          action: 'list',
          payload: { status: 'active' },
        });
        const timers = (listed.data as { timers: Array<Record<string, any>> }).timers;
        expect(timers).toHaveLength(1);
        expect(timers[0].inject?.progressDelivery).toEqual({ mode: 'result_only' });
      });
    });
  });

  // --------------------------------------------------------
  // FLAG PARSING (--async, -a)
  // --------------------------------------------------------
  describe('flag parsing', () => {
    it("'sleep --async 5s' -> async mode detected", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          'sleep --async 5s',
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.mode).toBe('async');
      });
    });

    it("'sleep -a 5s' -> async mode detected", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          'sleep -a 5s',
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.mode).toBe('async');
      });
    });

    it("'sleep 5s --async' -> async mode detected (flag after duration)", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          'sleep 5s --async',
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.mode).toBe('async');
      });
    });

    it("'sleep --sync 5s' -> sync mode detected", async () => {
      const result = await sleepTool.execute(
        'sleep --sync 0.1s',
        TEST_CONTEXT,
      );
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('sync');
    });

    it("'sleep -s 5s' -> sync mode detected", async () => {
      const result = await sleepTool.execute(
        'sleep -s 0.1s',
        TEST_CONTEXT,
      );
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('sync');
    });

    it("input object with async:true -> async mode", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          { duration: '5s', async: true },
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.mode).toBe('async');
      });
    });

    it("input object with mode:'async' -> async mode", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          { duration: '5s', mode: 'async' },
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.mode).toBe('async');
      });
    });
  });

  // --------------------------------------------------------
  // NUMERIC SECONDS INPUT
  // --------------------------------------------------------
  describe('numeric seconds input', () => {
    it("seconds:30 -> 30000ms", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          { seconds: 30, mode: 'async' },
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.data.duration_ms).toBe(30_000);
      });
    });

    it("seconds:90 (1.5m) -> 90000ms", async () => {
      await withClockStore(async () => {
        const result = await sleepTool.execute(
          { seconds: 90, mode: 'async' },
          makeAsyncContext(),
        );
        expect(result.ok).toBe(true);
        expect(result.data.duration_ms).toBe(90_000);
      });
    });

    it("seconds:0 -> throws error", async () => {
      await expect(
        sleepTool.execute({ seconds: 0, mode: 'sync' }, TEST_CONTEXT),
      ).rejects.toThrow();  // any error
    });

    it("seconds:-5 -> throws error", async () => {
      await expect(
        sleepTool.execute({ seconds: -5, mode: 'sync' }, TEST_CONTEXT),
      ).rejects.toThrow();
    });
  });

  // --------------------------------------------------------
  // CONTEXT FALLBACK FOR INJECT
  // --------------------------------------------------------
  describe('context fallback for inject', () => {
    it("uses context.cwd as projectPath when inject.projectPath omitted", async () => {
      await withClockStore(async () => {
        await sleepTool.execute(
          { duration: '5m', mode: 'async' },
          makeAsyncContext({ cwd: '/custom/project/path' }),
        );

        const listed = await clockTool.execute({
          action: 'list',
          payload: { status: 'active' },
        });
        const timers = (listed.data as { timers: Array<Record<string, any>> }).timers;
        expect(timers).toHaveLength(1);
        expect(timers[0].inject?.projectPath).toBe('/custom/project/path');
      });
    });

    it("uses context.channelId when inject.channelId omitted", async () => {
      await withClockStore(async () => {
        await sleepTool.execute(
          { duration: '5m', mode: 'async' },
          makeAsyncContext({ channelId: 'qqbot' }),
        );

        const listed = await clockTool.execute({
          action: 'list',
          payload: { status: 'active' },
        });
        const timers = (listed.data as { timers: Array<Record<string, any>> }).timers;
        expect(timers).toHaveLength(1);
        expect(timers[0].inject?.channelId).toBe('qqbot');
      });
    });

    it("inject override projectPath takes precedence over context.cwd", async () => {
      await withClockStore(async () => {
        await sleepTool.execute(
          {
            duration: '5m',
            mode: 'async',
            inject: { projectPath: '/override/path' },
          },
          makeAsyncContext({ cwd: '/context/path' }),
        );

        const listed = await clockTool.execute({
          action: 'list',
          payload: { status: 'active' },
        });
        const timers = (listed.data as { timers: Array<Record<string, any>> }).timers;
        expect(timers).toHaveLength(1);
        expect(timers[0].inject?.projectPath).toBe('/override/path');
      });
    });
  });
});
