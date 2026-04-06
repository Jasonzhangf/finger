/**
 * Clock Tool Integration Tests - Dynamic Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clockTool, resetClockStore } from '../../../../src/tools/internal/codex-clock-tool.js';
import { ClockTaskInjector } from '../../../../src/orchestration/clock-task-injector.js';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { isClockTimer, type ClockTimer } from '../../../../src/tools/internal/codex-clock-schema.js';

const TEST_STORE_DIR = path.join(os.tmpdir(), 'finger-clock-integration-test');
const TEST_STORE_PATH = path.join(TEST_STORE_DIR, 'tool-timers.json');

function readClockTimers(filePath: string): ClockTimer[] {
  const raw = readFileSync(filePath, 'utf-8').trim();
  if (!raw) return [];
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw) as { timers?: unknown[] };
    if (Array.isArray(parsed.timers)) {
      return parsed.timers.filter(isClockTimer);
    }
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isClockTimer);
}

function forceTimersDue(filePath: string): void {
  const timers = readClockTimers(filePath).map((timer) => ({
    ...timer,
    status: 'active' as const,
    next_fire_at: new Date(Date.now() - 1_000).toISOString(),
  }));
  const lines = timers.map((timer) => JSON.stringify(timer));
  writeFileSync(filePath, `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`, 'utf-8');
}

describe('clock tool dynamic tests', () => {
  beforeEach(() => {
    resetClockStore();
    if (existsSync(TEST_STORE_DIR)) {
      rmSync(TEST_STORE_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_STORE_DIR, { recursive: true });
    process.env.FINGER_CLOCK_STORE_PATH = TEST_STORE_PATH;
  });

  afterEach(() => {
    delete process.env.FINGER_CLOCK_STORE_PATH;
    if (existsSync(TEST_STORE_DIR)) {
      rmSync(TEST_STORE_DIR, { recursive: true, force: true });
    }
  });

  it('should create timer with inject payload', async () => {
    const result = await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'test injection',
          schedule_type: 'delay',
          delay_seconds: 5,
          inject: {
            agentId: 'test-agent',
            prompt: 'run test',
            progressDelivery: {
              mode: 'result_only',
            },
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() }
    );

    expect(result.ok).toBe(true);
    expect(result.action).toBe('create');
    expect(result.timer_id).toBeDefined();
    expect(result.data.next_fire_at).toBeDefined();

    // Verify store persistence
    const timers = readClockTimers(TEST_STORE_PATH);
    expect(timers).toHaveLength(1);
    expect(timers[0].inject).toEqual({
      agentId: 'test-agent',
      prompt: 'run test',
      progressDelivery: {
        mode: 'result_only',
      },
    });
  });

  it('should update timer inject payload', async () => {
    // Create initial timer
    const createResult = await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'original',
          schedule_type: 'delay',
          delay_seconds: 10,
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() }
    );

    const timerId = createResult.timer_id!;

    // Update with inject payload
    const updateResult = await clockTool.execute(
      {
        action: 'update',
        payload: {
          timer_id: timerId,
          inject: {
            agentId: 'updated-agent',
            prompt: 'updated prompt',
            sessionId: 'session-123',
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() }
    );

    expect(updateResult.ok).toBe(true);

    const timers = readClockTimers(TEST_STORE_PATH);
    expect(timers[0].inject).toEqual({
      agentId: 'updated-agent',
      prompt: 'updated prompt',
      sessionId: 'session-123',
    });
  });

  it('should list timers with inject', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'timer 1',
          schedule_type: 'delay',
          delay_seconds: 5,
          inject: { agentId: 'agent-1', prompt: 'task 1' },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() }
    );

    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'timer 2',
          schedule_type: 'delay',
          delay_seconds: 10,
          inject: { agentId: 'agent-2', prompt: 'task 2' },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() }
    );

    const listResult = await clockTool.execute(
      { action: 'list', payload: {} },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() }
    );

    expect(listResult.ok).toBe(true);
    expect(listResult.data.timers).toHaveLength(2);
    const agents = (listResult.data.timers as Array<{ inject?: { agentId?: string } }>)
      .map((timer) => timer.inject?.agentId)
      .filter((value): value is string => typeof value === 'string')
      .sort();
    expect(agents).toEqual(['agent-1', 'agent-2']);
  });

  it('should cancel timer', async () => {
    const createResult = await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'to cancel',
          schedule_type: 'delay',
          delay_seconds: 60,
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() }
    );

    const timerId = createResult.timer_id!;

    const cancelResult = await clockTool.execute(
      { action: 'cancel', payload: { timer_id: timerId } },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() }
    );

    expect(cancelResult.ok).toBe(true);
    expect(cancelResult.data.status).toBe('canceled');
  });
});

describe('ClockTaskInjector', () => {
  let injector: ClockTaskInjector;
  let dispatchMock: ReturnType<typeof vi.fn>;
  let ensureSessionMock: ReturnType<typeof vi.fn>;
  let logMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetClockStore();
    if (existsSync(TEST_STORE_DIR)) {
      rmSync(TEST_STORE_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_STORE_DIR, { recursive: true });
    process.env.FINGER_CLOCK_STORE_PATH = TEST_STORE_PATH;

    dispatchMock = vi.fn().mockResolvedValue({ success: true });
    ensureSessionMock = vi.fn();
    logMock = vi.fn();

    injector = new ClockTaskInjector(
      {
        dispatchTaskToAgent: dispatchMock,
        ensureSession: ensureSessionMock,
        log: logMock,
      },
      TEST_STORE_PATH
    );
  });

  afterEach(() => {
    injector.stop();
    delete process.env.FINGER_CLOCK_STORE_PATH;
    if (existsSync(TEST_STORE_DIR)) {
      rmSync(TEST_STORE_DIR, { recursive: true, force: true });
    }
  });

  it('should inject task when timer fires', async () => {
    // Create a timer that fires immediately (1 second delay)
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'immediate task',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: '/test/project',
            prompt: 'execute this task',
            channelId: 'test-channel',
            progressDelivery: {
              mode: 'result_only',
            },
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() }
    );

    forceTimersDue(TEST_STORE_PATH);

    // Trigger tick manually
    await (injector as any).tick();

    expect(ensureSessionMock).toHaveBeenCalledWith('test-session', '/test/project');
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    const dispatchCall = dispatchMock.mock.calls[0][0];
    expect(dispatchCall.targetAgentId).toBe('target-agent');
    expect(dispatchCall.task.prompt).toBe('execute this task');
    expect(dispatchCall.sessionId).toBe('test-session');
    expect(dispatchCall.metadata.source).toBe('clock');
    expect(dispatchCall.metadata.scheduledProgressDelivery).toEqual({ mode: 'result_only' });
  });

  it('should execute hook command before injection and attach hook result', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook+inject',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: 'echo hook-ok',
            timeout_ms: 5000,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE_PATH);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchMock.mock.calls[0][0];
    expect(dispatchCall.metadata.hookStatus).toBe('success');
    expect(dispatchCall.metadata.hookCommand).toBe('echo hook-ok');
    expect(dispatchCall.task.prompt).toContain('[CLOCK HOOK RESULT]');
    expect(dispatchCall.task.prompt).toContain('stdout=hook-ok');
  });

  it('should not inject task if inject payload is missing', async () => {
    // Create timer without inject payload
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'no inject',
          schedule_type: 'delay',
          delay_seconds: 1,
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() }
    );

    forceTimersDue(TEST_STORE_PATH);
    await (injector as any).tick();

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('should complete non-repeating timer after injection', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'one-shot',
          schedule_type: 'delay',
          delay_seconds: 1,
          repeat: false,
          inject: {
            agentId: 'agent',
            prompt: 'task',
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() }
    );

    forceTimersDue(TEST_STORE_PATH);
    await (injector as any).tick();

    const timers = readClockTimers(TEST_STORE_PATH);
    expect(timers[0].status).toBe('completed');
    expect(timers[0].run_count).toBe(1);
    expect(timers[0].last_injected_at).toBeDefined();
  });

  it('should repeat timer with max_runs', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'repeat-3-times',
          schedule_type: 'delay',
          delay_seconds: 1,
          repeat: true,
          max_runs: 3,
          inject: {
            agentId: 'agent',
            prompt: 'task',
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() }
    );

    // First run
    forceTimersDue(TEST_STORE_PATH);
    await (injector as any).tick();

    let timers = readClockTimers(TEST_STORE_PATH);
    expect(timers[0].run_count).toBe(1);
    expect(timers[0].status).toBe('active');

    // Second run
    forceTimersDue(TEST_STORE_PATH);
    await (injector as any).tick();

    timers = readClockTimers(TEST_STORE_PATH);
    expect(timers[0].run_count).toBe(2);
    expect(timers[0].status).toBe('active');

    // Third run - should complete
    forceTimersDue(TEST_STORE_PATH);
    await (injector as any).tick();

    timers = readClockTimers(TEST_STORE_PATH);
    expect(timers[0].run_count).toBe(3);
    expect(timers[0].status).toBe('completed');
  });

  it('list should not consume due timers before injector dispatch', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'due-soon',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: { agentId: 'agent', prompt: 'task' },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() }
    );

    forceTimersDue(TEST_STORE_PATH);

    const listResult = await clockTool.execute(
      { action: 'list', payload: { status: 'active' } },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() }
    );
    expect(listResult.ok).toBe(true);
    expect((listResult.data.timers as Array<{ timer_id: string }>).length).toBe(1);

    const timersBeforeTick = readClockTimers(TEST_STORE_PATH);
    expect(timersBeforeTick[0].status).toBe('active');
    expect(timersBeforeTick[0].run_count).toBe(0);

    await (injector as any).tick();
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    const timersAfterTick = readClockTimers(TEST_STORE_PATH);
    expect(timersAfterTick[0].status).toBe('completed');
    expect(timersAfterTick[0].run_count).toBe(1);
  });
});

describe('ClockTaskInjector hook edge cases', () => {
  let injector: ClockTaskInjector;
  let dispatchMock: ReturnType<typeof vi.fn>;
  let ensureSessionMock: ReturnType<typeof vi.fn>;
  let logMock: ReturnType<typeof vi.fn>;
  const TEST_STORE_DIR_HOOK = path.join(os.tmpdir(), 'finger-clock-hook-test');
  const TEST_STORE_PATH_HOOK = path.join(TEST_STORE_DIR_HOOK, 'tool-timers.json');

  beforeEach(() => {
    resetClockStore();
    if (existsSync(TEST_STORE_DIR_HOOK)) {
      rmSync(TEST_STORE_DIR_HOOK, { recursive: true, force: true });
    }
    mkdirSync(TEST_STORE_DIR_HOOK, { recursive: true });
    process.env.FINGER_CLOCK_STORE_PATH = TEST_STORE_PATH_HOOK;

    dispatchMock = vi.fn().mockResolvedValue({});
    ensureSessionMock = vi.fn();
    logMock = vi.fn();

    injector = new ClockTaskInjector(
      {
        dispatchTaskToAgent: dispatchMock,
        ensureSession: ensureSessionMock,
        log: logMock,
      },
      TEST_STORE_PATH_HOOK,
    );
  });

  afterEach(() => {
    delete process.env.FINGER_CLOCK_STORE_PATH;
    if (existsSync(TEST_STORE_DIR_HOOK)) {
      rmSync(TEST_STORE_DIR_HOOK, { recursive: true, force: true });
    }
    resetClockStore();
  });

  it('hook timeout sets timedOut=true and injects with hookStatus=timeout', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook timeout',
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

    forceTimersDue(TEST_STORE_PATH_HOOK);
    await (injector as any).tick();

    // Soft-fail: hook timeout still injects, agent receives hookStatus=timeout
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchMock.mock.calls[0][0];
    expect(dispatchCall.metadata.hookStatus).toBe('timeout');
    expect(dispatchCall.task.prompt).toContain('timedOut=true');

    const timers = readClockTimers(TEST_STORE_PATH_HOOK);
    expect(timers[0].status).toBe('completed');
    expect(timers[0].run_count).toBe(1);

    // Note: hook finished logs go to global logger, not deps.log
    // Verify dispatch carries the timeout metadata
    expect(dispatchCall.metadata.hookTimedOut).toBe(true);
  });

  it('hook exit_code != 0 sets hookStatus=failed and attaches stderr', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook fail',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: 'echo hook-error && exit 1',
            timeout_ms: 5000,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE_PATH_HOOK);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchMock.mock.calls[0][0];
    expect(dispatchCall.metadata.hookStatus).toBe('failed');
    expect(dispatchCall.task.prompt).toContain('exit_code=1');
    expect(dispatchCall.task.prompt).toContain('stdout=hook-error');
  });

  it('include_output_in_prompt=false hides stdout/stderr', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook no output',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: 'echo visible-output',
            timeout_ms: 5000,
            include_output_in_prompt: false,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE_PATH_HOOK);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchMock.mock.calls[0][0];
    expect(dispatchCall.task.prompt).toContain('[CLOCK HOOK RESULT]');
    expect(dispatchCall.task.prompt).toContain('status=success');
    expect(dispatchCall.task.prompt).not.toContain('stdout=');
    expect(dispatchCall.task.prompt).not.toContain('stderr=');
  });

  it('prompt_header custom header replaces default', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook custom header',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: 'echo ok',
            timeout_ms: 5000,
            prompt_header: '[CUSTOM HEADER]',
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE_PATH_HOOK);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchMock.mock.calls[0][0];
    expect(dispatchCall.task.prompt).toContain('[CUSTOM HEADER]');
    expect(dispatchCall.task.prompt).not.toContain('[CLOCK HOOK RESULT]');
  });

  it('cwd custom directory used for hook execution', async () => {
    const customDir = os.tmpdir();
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook custom cwd',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: 'pwd',
            timeout_ms: 5000,
            cwd: customDir,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE_PATH_HOOK);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchMock.mock.calls[0][0];
    expect(dispatchCall.task.prompt).toContain(`cwd=${customDir}`);
    expect(dispatchCall.task.prompt).toContain(customDir);
  });

  it('max_output_chars truncates long output', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook truncate',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: 'echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
            timeout_ms: 5000,
            max_output_chars: 50,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE_PATH_HOOK);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchMock.mock.calls[0][0];
    expect(dispatchCall.task.prompt).toContain('stdout=');
    expect(dispatchCall.task.prompt).toContain('[truncated]');
  });

  it('hook-only (no inject) success marks timer completed', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook only success',
          schedule_type: 'delay',
          delay_seconds: 1,
          hook: {
            command: 'echo standalone-hook-ok',
            timeout_ms: 5000,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE_PATH_HOOK);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(0);
    const timers = readClockTimers(TEST_STORE_PATH_HOOK);
    expect(timers[0].status).toBe('completed');
    expect(timers[0].run_count).toBe(1);
  });

  it('hook-only (no inject) failure marks timer with failed_attempts', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook only fail',
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

    forceTimersDue(TEST_STORE_PATH_HOOK);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(0);
    const timers = readClockTimers(TEST_STORE_PATH_HOOK);
    expect(timers[0].status).toBe('active');
    expect((timers[0] as any).failed_attempts).toBe(1);
  });

  it('shell custom shell used for hook execution', async () => {
    await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: 'hook custom shell',
          schedule_type: 'delay',
          delay_seconds: 1,
          inject: {
            agentId: 'target-agent',
            sessionId: 'test-session',
            projectPath: process.cwd(),
            prompt: 'resume work',
          },
          hook: {
            command: 'echo shell-ok',
            shell: '/bin/sh',
            timeout_ms: 5000,
          },
        },
      },
      { cwd: process.cwd(), invocationId: 'test', timestamp: Date.now() },
    );

    forceTimersDue(TEST_STORE_PATH_HOOK);
    await (injector as any).tick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchMock.mock.calls[0][0];
    expect(dispatchCall.metadata.hookStatus).toBe('success');
    expect(dispatchCall.task.prompt).toContain('stdout=shell-ok');
  });
});
