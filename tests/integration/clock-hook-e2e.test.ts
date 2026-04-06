import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { ClockTaskInjector } from '../../src/orchestration/clock-task-injector.js';
import { clockTool } from '../../src/tools/internal/codex-clock-tool.js';
import { sleepTool } from '../../src/tools/internal/codex-sleep-tool.js';

vi.setConfig({ testTimeout: 15000 });

const TEST_DIR = path.join(os.tmpdir(), 'finger-clock-e2e-test');
const TEST_STORE = path.join(TEST_DIR, 'clock-timers.jsonl');

function readClockTimers(filePath: string): any[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf-8');
  return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function forceTimersDue(filePath: string): void {
  const timers = readClockTimers(filePath);
  const now = Date.now() - 1000;
  for (const t of timers) {
    t.next_fire_at = new Date(now).toISOString();
    t.status = 'active';
  }
  writeFileSync(filePath, timers.map(t => JSON.stringify(t)).join('\n') + '\n', 'utf-8');
}

describe('Clock Hook E2E', () => {
  let injector: ClockTaskInjector;
  let dispatchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.FINGER_CLOCK_STORE_PATH = TEST_STORE;

    dispatchMock = vi.fn().mockResolvedValue({ ok: true });
    injector = new ClockTaskInjector(
      { dispatchTaskToAgent: dispatchMock, ensureSession: vi.fn(), log: vi.fn() },
      TEST_STORE,
    );
  });

  afterEach(() => {
    delete process.env.FINGER_CLOCK_STORE_PATH;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('hook success + inject dispatched', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook-success-test',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: 'echo hook-output-success',
            timeout_ms: 5000,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0][0];
    expect(call.metadata.hookStatus).toBe('success');
    expect(call.task.prompt).toContain('hook-output-success');
    expect(call.metadata.hookExitCode).toBe(0);
    expect(call.metadata.hookTimedOut).toBe(false);
  });

  it('hook timeout + inject dispatched with hookStatus=timeout', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook-timeout-test',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: 'sleep 10',
            timeout_ms: 50,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0][0];
    expect(call.metadata.hookStatus).toBe('timeout');
    expect(call.metadata.hookTimedOut).toBe(true);
    expect(call.task.prompt).toContain('timedOut=true');

    const timers = readClockTimers(TEST_STORE);
    expect(timers[0].status).toBe('completed');
  });

  it('hook exit 1 + inject dispatched with hookStatus=failed', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook-failed-test',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: 'sh -c "echo error-msg && exit 1"',
            timeout_ms: 5000,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0][0];
    expect(call.metadata.hookStatus).toBe('failed');
    expect(call.metadata.hookExitCode).toBe(1);
    expect(call.task.prompt).toContain('error-msg');
  });

  it('hook-only (no inject) success marks timer completed', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook-only-success',
          schedule_type: 'delay',
          delay_seconds: 1,
          hook: {
            command: 'echo standalone-hook',
            timeout_ms: 5000,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(0);

    const timers = readClockTimers(TEST_STORE);
    expect(timers[0].status).toBe('completed');
    expect(timers[0].run_count).toBe(1);
  });

  it('hook-only (no inject) failure marks timer with failed_attempts', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook-only-failure',
          schedule_type: 'delay',
          delay_seconds: 1,
          hook: {
            command: 'exit 1',
            timeout_ms: 5000,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(0);

    const timers = readClockTimers(TEST_STORE);
    expect(timers[0].status).toBe('active');
    expect(timers[0].failed_attempts).toBe(1);
  });

  it('include_output_in_prompt=false excludes stdout/stderr', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'no-output-in-prompt',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: 'echo should-not-appear',
            timeout_ms: 5000,
            include_output_in_prompt: false,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0][0];
    // command line is always visible, but stdout/stderr are excluded
    expect(call.task.prompt).toContain('command=echo should-not-appear');
    expect(call.task.prompt).not.toContain('stdout=');
    expect(call.task.prompt).not.toContain('stderr=');
    expect(call.metadata.hookStatus).toBe('success');
  });

  it('prompt_header custom replaces default header', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'custom-header-test',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: 'echo hook-done',
            timeout_ms: 5000,
            prompt_header: '[CUSTOM_HOOK_HEADER]',
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0][0];
    expect(call.task.prompt).toContain('[CUSTOM_HOOK_HEADER]');
    expect(call.task.prompt).not.toContain('[HOOK OUTPUT]');
  });

  it('cwd custom directory used for hook execution', async () => {
    const customDir = path.join(TEST_DIR, 'custom-cwd');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(path.join(customDir, 'test-file.txt'), 'test-content', 'utf-8');

    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'custom-cwd-test',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: 'cat test-file.txt',
            timeout_ms: 5000,
            cwd: customDir,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0][0];
    expect(call.task.prompt).toContain('test-content');
  });

  it('max_output_chars truncates long output', async () => {
    const longOutput = 'A'.repeat(500);
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'truncate-test',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: `echo "${longOutput}"`,
            timeout_ms: 5000,
            max_output_chars: 100,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0][0];
    const stdoutMatch = call.task.prompt.match(/stdout=(.+)/);
    expect(stdoutMatch).not.toBeNull();
    // truncateOutput: first maxChars + '[truncated]' suffix
    expect(stdoutMatch![1]).toContain('[truncated]');
    const actualContent = stdoutMatch![1].replace('[truncated]', '');
    expect(actualContent.length).toBe(100); // exactly max_chars of original content
  });

  it('shell custom shell (/bin/sh) used', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'custom-shell-test',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: 'echo shell-test',
            timeout_ms: 5000,
            shell: '/bin/sh',
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0][0];
    expect(call.task.prompt).toContain('shell-test');
    expect(call.metadata.hookStatus).toBe('success');
  });
});

describe('Sleep Tool E2E', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.FINGER_CLOCK_STORE_PATH = TEST_STORE;
  });

  afterEach(() => {
    delete process.env.FINGER_CLOCK_STORE_PATH;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('sync sleep blocks for duration', async () => {
    const start = Date.now();
    const result = await sleepTool.execute(
      { input: 'sleep 0.05' },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('sync');
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(200);
  });

  it('async sleep schedules clock timer', async () => {
    const result = await sleepTool.execute(
      { input: 'sleep --async 2m', inject: { agentId: 'test-agent', sessionId: 'test-session' } },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now(), agentId: 'caller', sessionId: 'caller-session' },
    );

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('async');
    expect(result.timer_id).toBeDefined();

    const timers = readClockTimers(TEST_STORE);
    expect(timers.length).toBe(1);
    expect(timers[0].inject.agentId).toBe('test-agent');
    expect(timers[0].inject.sessionId).toBe('test-session');
  });

  it('async sleep uses caller context when inject not provided', async () => {
    const result = await sleepTool.execute(
      { input: 'sleep -a 30s' },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now(), agentId: 'caller-agent', sessionId: 'caller-session' },
    );

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('async');

    const timers = readClockTimers(TEST_STORE);
    expect(timers[0].inject.agentId).toBe('caller-agent');
    expect(timers[0].inject.sessionId).toBe('caller-session');
  });

  it('async sleep rejects > 7d', async () => {
    await expect(
      sleepTool.execute(
        { input: 'sleep --async 8d', inject: { agentId: 'test-agent', sessionId: 'test-session' } },
        { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
      ),
    ).rejects.toThrow(/sleep duration too large|max 7d/i);
  });

  it('sync sleep rejects > 1h', async () => {
    await expect(
      sleepTool.execute(
        { input: 'sleep 2h' },
        { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
      ),
    ).rejects.toThrow(/sync sleep supports at most 1h/i);
  });

  it('async sleep rejects missing agentId/sessionId', async () => {
    await expect(
      sleepTool.execute(
        { input: 'sleep --async 5m' },
        { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
      ),
    ).rejects.toThrow(/async sleep requires agentId and sessionId/i);
  });

  it('duration parsing: 30s via seconds field', async () => {
    const result = await sleepTool.execute(
      { seconds: 0.03 },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );
    expect(result.ok).toBe(true);
    expect(result.data.duration_ms).toBe(30);
  });

  it('duration parsing: 2m', async () => {
    const result = await sleepTool.execute(
      { input: 'sleep --async 2m', inject: { agentId: 'test', sessionId: 'test' } },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );
    expect(result.mode).toBe('async');
    expect(result.data.duration_ms).toBe(120000);
  });

  it('duration parsing: 1h30m', async () => {
    const result = await sleepTool.execute(
      { input: 'sleep --async 1h30m', inject: { agentId: 'test', sessionId: 'test' } },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );
    expect(result.mode).toBe('async');
    expect(result.data.duration_ms).toBe(5400000);
  });

  it('progressDelivery passed to clock inject', async () => {
    const result = await sleepTool.execute(
      {
        input: 'sleep --async 1m',
        inject: {
          agentId: 'test-agent',
          sessionId: 'test-session',
          progressDelivery: { enabled: true, mode: 'stream' },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    const timers = readClockTimers(TEST_STORE);
    // progressDelivery is passed through as-is to clock create payload
    expect(timers[0].inject.progressDelivery).toBeDefined();
    expect(timers[0].inject.progressDelivery.enabled).toBe(true);
  });
});
