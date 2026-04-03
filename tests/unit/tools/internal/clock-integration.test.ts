/**
 * Clock Tool Integration Tests - Dynamic Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clockTool, resetClockStore } from '../../../../src/tools/internal/codex-clock-tool.js';
import { ClockTaskInjector } from '../../../../src/orchestration/clock-task-injector.js';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
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

    // Wait for timer to be due
    await new Promise(resolve => setTimeout(resolve, 1100));

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

    await new Promise(resolve => setTimeout(resolve, 1100));
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

    await new Promise(resolve => setTimeout(resolve, 1100));
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
    await new Promise(resolve => setTimeout(resolve, 1100));
    await (injector as any).tick();

    let timers = readClockTimers(TEST_STORE_PATH);
    expect(timers[0].run_count).toBe(1);
    expect(timers[0].status).toBe('active');

    // Second run
    await new Promise(resolve => setTimeout(resolve, 1100));
    await (injector as any).tick();

    timers = readClockTimers(TEST_STORE_PATH);
    expect(timers[0].run_count).toBe(2);
    expect(timers[0].status).toBe('active');

    // Third run - should complete
    await new Promise(resolve => setTimeout(resolve, 1100));
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

    await new Promise(resolve => setTimeout(resolve, 1100));

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
