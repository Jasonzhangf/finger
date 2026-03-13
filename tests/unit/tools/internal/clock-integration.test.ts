/**
 * Clock Tool Integration Tests - Dynamic Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clockTool, resetClockStore } from '../../../../src/tools/internal/codex-clock-tool.js';
import { ClockTaskInjector } from '../../../../src/orchestration/clock-task-injector.js';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';

const TEST_STORE_DIR = path.join(os.tmpdir(), 'finger-clock-integration-test');
const TEST_STORE_PATH = path.join(TEST_STORE_DIR, 'tool-timers.json');

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
    const store = JSON.parse(readFileSync(TEST_STORE_PATH, 'utf-8'));
    expect(store.timers).toHaveLength(1);
    expect(store.timers[0].inject).toEqual({
      agentId: 'test-agent',
      prompt: 'run test',
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

    const store = JSON.parse(readFileSync(TEST_STORE_PATH, 'utf-8'));
    expect(store.timers[0].inject).toEqual({
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
    expect(listResult.data.timers[0].inject.agentId).toBe('agent-1');
    expect(listResult.data.timers[1].inject.agentId).toBe('agent-2');
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

    const store = JSON.parse(readFileSync(TEST_STORE_PATH, 'utf-8'));
    expect(store.timers[0].status).toBe('completed');
    expect(store.timers[0].run_count).toBe(1);
    expect(store.timers[0].last_injected_at).toBeDefined();
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

    let store = JSON.parse(readFileSync(TEST_STORE_PATH, 'utf-8'));
    expect(store.timers[0].run_count).toBe(1);
    expect(store.timers[0].status).toBe('active');

    // Second run
    await new Promise(resolve => setTimeout(resolve, 1100));
    await (injector as any).tick();

    store = JSON.parse(readFileSync(TEST_STORE_PATH, 'utf-8'));
    expect(store.timers[0].run_count).toBe(2);
    expect(store.timers[0].status).toBe('active');

    // Third run - should complete
    await new Promise(resolve => setTimeout(resolve, 1100));
    await (injector as any).tick();

    store = JSON.parse(readFileSync(TEST_STORE_PATH, 'utf-8'));
    expect(store.timers[0].run_count).toBe(3);
    expect(store.timers[0].status).toBe('completed');
  });
});
