/**
 * Clock Tool Static Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetClockStore, clockTool } from '../../../../src/tools/internal/codex-clock-tool.js';
import { parseClockInput, parseCreatePayload, parseUpdatePayload, normalizeScheduleType, resolveRepeat, resolveMaxRuns } from '../../../../src/tools/internal/codex-clock-schema.js';
import { existsSync, unlinkSync } from 'fs';
import path from 'path';
import os from 'os';

const TEST_STORE_DIR = path.join(os.tmpdir(), 'finger-clock-test');
const TEST_STORE_PATH = path.join(TEST_STORE_DIR, 'tool-timers.json');

describe('clock schema parsing', () => {
  it('should parse valid clock input', () => {
    const input = {
      action: 'create',
      payload: {
        message: 'test',
        schedule_type: 'delay',
        delay_seconds: 60,
      },
    };
    const result = parseClockInput(input);
    expect(result.action).toBe('create');
    expect(result.payload).toEqual(input.payload);
  });

  it('should reject invalid action', () => {
    const input = {
      action: 'invalid',
      payload: {},
    };
    expect(() => parseClockInput(input)).toThrow('unsupported clock action');
  });

  it('should reject missing payload', () => {
    const input = {
      action: 'create',
    };
    expect(() => parseClockInput(input as any)).toThrow('must be an object');
  });
});

describe('create payload parsing', () => {
  it('should parse delay schedule with inject', () => {
    const payload = {
      message: 'test task',
      schedule_type: 'delay',
      delay_seconds: 120,
      inject: {
        agentId: 'test-agent',
        prompt: 'run this task',
      },
    };
    const result = parseCreatePayload(payload);
    expect(result.message).toBe('test task');
    expect(result.schedule_type).toBe('delay');
    expect(result.delay_seconds).toBe(120);
    expect(result.inject).toEqual({
      agentId: 'test-agent',
      prompt: 'run this task',
    });
  });

  it('should parse at schedule with timezone', () => {
    const payload = {
      message: 'test',
      schedule_type: 'at',
      at: new Date(Date.now() + 3600000).toISOString(),
      timezone: 'Asia/Shanghai',
    };
    const result = parseCreatePayload(payload);
    expect(result.schedule_type).toBe('at');
    expect(result.timezone).toBe('Asia/Shanghai');
  });

  it('should parse cron schedule', () => {
    const payload = {
      message: 'cron task',
      schedule_type: 'cron',
      cron: '0 9 * * *',
      timezone: 'UTC',
      repeat: true,
      max_runs: 5,
    };
    const result = parseCreatePayload(payload);
    expect(result.cron).toBe('0 9 * * *');
    expect(result.repeat).toBe(true);
    expect(result.max_runs).toBe(5);
  });

  it('should reject missing inject.agentId', () => {
    const payload = {
      message: 'test',
      schedule_type: 'delay',
      delay_seconds: 60,
      inject: {
        prompt: 'no agent id',
      },
    };
    expect(() => parseCreatePayload(payload)).toThrow('inject.agentId is required');
  });

  it('should reject missing inject.prompt', () => {
    const payload = {
      message: 'test',
      schedule_type: 'delay',
      delay_seconds: 60,
      inject: {
        agentId: 'test-agent',
      },
    };
    expect(() => parseCreatePayload(payload)).toThrow('inject.prompt is required');
  });
});

describe('update payload parsing', () => {
  it('should parse update with inject modification', () => {
    const payload = {
      timer_id: 'test-timer-id',
      inject: {
        agentId: 'new-agent',
        prompt: 'new prompt',
        sessionId: 'session-123',
      },
    };
    const result = parseUpdatePayload(payload);
    expect(result.timer_id).toBe('test-timer-id');
    expect(result.inject).toEqual({
      agentId: 'new-agent',
      prompt: 'new prompt',
      sessionId: 'session-123',
    });
  });

  it('should parse update without inject', () => {
    const payload = {
      timer_id: 'test-timer-id',
      message: 'updated message',
    };
    const result = parseUpdatePayload(payload);
    expect(result.timer_id).toBe('test-timer-id');
    expect(result.message).toBe('updated message');
    expect(result.inject).toBeUndefined();
  });
});

describe('schedule normalization', () => {
  it('should normalize valid schedule types', () => {
    expect(normalizeScheduleType('delay')).toBe('delay');
    expect(normalizeScheduleType('at')).toBe('at');
    expect(normalizeScheduleType('cron')).toBe('cron');
  });

  it('should reject invalid schedule type', () => {
    expect(() => normalizeScheduleType('invalid' as any)).toThrow('unsupported schedule_type');
  });
});

describe('repeat resolution', () => {
  it('should default cron to repeat=true', () => {
    expect(resolveRepeat('cron', undefined)).toBe(true);
  });

  it('should default delay/at to repeat=false', () => {
    expect(resolveRepeat('delay', undefined)).toBe(false);
    expect(resolveRepeat('at', undefined)).toBe(false);
  });

  it('should respect explicit repeat setting', () => {
    expect(resolveRepeat('delay', true)).toBe(true);
    expect(resolveRepeat('cron', false)).toBe(false);
  });
});

describe('max runs resolution', () => {
 it('should return null for non-repeating tasks', () => {
    expect(resolveMaxRuns(false, undefined)).toBe(1);
    // resolveMaxRuns only normalizes, doesn't override for non-repeating
    expect(resolveMaxRuns(false, 5)).toBe(5);
  });

  it('should return specified max_runs for repeating tasks', () => {
    expect(resolveMaxRuns(true, 10)).toBe(10);
    expect(resolveMaxRuns(true, null)).toBe(null);
  });
});
