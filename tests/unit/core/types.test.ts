/**
 * Core types tests
 */
import { describe, it, expect } from 'vitest';
import {
  ERROR_CODES,
  DEFAULT_CONFIG,
  type Task,
  type TaskStatus,
  type Agent,
  type Project,
  type Event,
  type FingerError,
} from '../../../src/core/types.js';

describe('Core Types - ERROR_CODES', () => {
  it('should have all error codes defined', () => {
    expect(ERROR_CODES.BLOCK_NOT_FOUND).toBe('BLOCK_NOT_FOUND');
    expect(ERROR_CODES.AGENT_TIMEOUT).toBe('AGENT_TIMEOUT');
    expect(ERROR_CODES.TASK_BLOCKED).toBe('TASK_BLOCKED');
    expect(ERROR_CODES.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(ERROR_CODES.BD_SYNC_ERROR).toBe('BD_SYNC_ERROR');
    expect(ERROR_CODES.NOT_INITIALIZED).toBe('NOT_INITIALIZED');
    expect(ERROR_CODES.UNKNOWN_COMMAND).toBe('UNKNOWN_COMMAND');
  });
});

describe('Core Types - DEFAULT_CONFIG', () => {
  it('should have correct default configuration', () => {
    expect(DEFAULT_CONFIG.serverHost).toBe('localhost');
    expect(DEFAULT_CONFIG.serverPort).toBe(8080);
    expect(DEFAULT_CONFIG.dbPath).toBe('./data/finger.db');
  });
  it('should have correct retry configuration', () => {
    expect(DEFAULT_CONFIG.retryConfig.maxRetries).toBe(10);
    expect(DEFAULT_CONFIG.retryConfig.retryDelayMs).toBe(1000);
    expect(DEFAULT_CONFIG.retryConfig.retryBackoff).toBe('exponential');
    expect(DEFAULT_CONFIG.retryConfig.retryableErrors).toContain('TIMEOUT');
    expect(DEFAULT_CONFIG.retryConfig.retryableErrors).toContain('NETWORK_ERROR');
    expect(DEFAULT_CONFIG.retryConfig.retryableErrors).toContain('RATE_LIMIT');
  });
  it('should have correct timeout configuration', () => {
    expect(DEFAULT_CONFIG.timeoutConfig.task).toBe(30 * 60 * 1000);
    expect(DEFAULT_CONFIG.timeoutConfig.heartbeat).toBe(60 * 1000);
    expect(DEFAULT_CONFIG.timeoutConfig.agent).toBe(5 * 60 * 1000);
    expect(DEFAULT_CONFIG.timeoutConfig.review).toBe(24 * 60 * 60 * 1000);
  });
});

describe('Core Types - Task', () => {
  it('should create valid task', () => {
    const task: Task = {
      id: 'task-1',
      title: 'Test Task',
      description: 'Description',
      priority: 1,
      status: 'open',
      isMainPath: true,
      dependencies: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      retryCount: 0,
      artifacts: [],
    };
    expect(task.id).toBe('task-1');
    expect(task.status).toBe('open');
    expect(task.isMainPath).toBe(true);
  });
  it('should have all task statuses', () => {
    const statuses: TaskStatus[] = ['open', 'in_progress', 'blocked', 'failed', 'review', 'escalated', 'closed'];
    expect(statuses).toHaveLength(7);
  });
});

describe('Core Types - Agent', () => {
  it('should create valid agent', () => {
    const agent: Agent = {
      id: 'agent-1',
      name: 'Test Agent',
      role: 'executor',
      sdk: 'iflow',
      status: 'idle',
      capabilities: ['file_ops'],
    };
    expect(agent.role).toBe('executor');
    expect(agent.sdk).toBe('iflow');
    expect(agent.status).toBe('idle');
  });
  it('should support all agent roles', () => {
    const roles: Agent['role'][] = ['orchestrator', 'executor', 'reviewer', 'specialist'];
    expect(roles).toHaveLength(4);
  });
  it('should support all agent statuses', () => {
    const statuses: Agent['status'][] = ['idle', 'busy', 'error', 'offline'];
    expect(statuses).toHaveLength(4);
  });
  it('should support all sdks', () => {
    const sdks: Agent['sdk'][] = ['iflow', 'codex', 'claude'];
    expect(sdks).toHaveLength(3);
  });
  it('should support specialist type', () => {
    const specialist: Agent = {
      id: 'spec-1',
      name: 'Architect',
      role: 'specialist',
      specialistType: 'architect',
      sdk: 'iflow',
      status: 'busy',
      capabilities: ['design'],
      currentTask: 'task-1',
    };
    expect(specialist.specialistType).toBe('architect');
    expect(specialist.currentTask).toBe('task-1');
  });
});

describe('Core Types - Project', () => {
  it('should create valid project', () => {
    const project: Project = {
      id: 'proj-1',
      name: 'Test Project',
      description: 'Project description',
      tasks: new Map(),
      createdAt: new Date(),
      updatedAt: new Date(),
      bdSynced: false,
    };
    expect(project.bdSynced).toBe(false);
    expect(project.tasks).toBeInstanceOf(Map);
  });
  it('should support master task', () => {
    const project: Project = {
      id: 'proj-2',
      name: 'Project with Master',
      description: 'Desc',
      tasks: new Map(),
      masterTask: 'master-task-id',
      createdAt: new Date(),
      updatedAt: new Date(),
      bdSynced: true,
    };
    expect(project.masterTask).toBe('master-task-id');
    expect(project.bdSynced).toBe(true);
  });
});

describe('Core Types - Event', () => {
  it('should create valid event', () => {
    const event: Event<{ data: string }> = {
      id: 'evt-1',
      type: 'test_event',
      payload: { data: 'test' },
      timestamp: new Date(),
      source: 'test',
    };
    expect(event.type).toBe('test_event');
    expect(event.payload.data).toBe('test');
  });
  it('should support different payload types', () => {
    const stringEvent: Event<string> = {
      id: 'evt-2',
      type: 'string_event',
      payload: 'string data',
      timestamp: new Date(),
      source: 'source',
    };
    expect(stringEvent.payload).toBe('string data');
    const numberEvent: Event<number> = {
      id: 'evt-3',
      type: 'number_event',
      payload: 42,
      timestamp: new Date(),
      source: 'source',
    };
    expect(numberEvent.payload).toBe(42);
  });
});

describe('Core Types - FingerError', () => {
  it('should create error with required fields', () => {
    const error: FingerError = {
      name: 'TestError',
      message: 'Test error message',
      code: 'TEST_ERROR',
      severity: 'error',
      retryable: true,
    };
    expect(error.code).toBe('TEST_ERROR');
    expect(error.severity).toBe('error');
    expect(error.retryable).toBe(true);
  });
  it('should support different severities', () => {
    const warning: FingerError = {
      name: 'WarnError',
      message: 'Warning',
      code: 'WARN',
      severity: 'warning',
      retryable: false,
    };
    expect(warning.severity).toBe('warning');
    const critical: FingerError = {
      name: 'CritError',
      message: 'Critical',
      code: 'CRIT',
      severity: 'critical',
      retryable: false,
    };
    expect(critical.severity).toBe('critical');
  });
  it('should support context', () => {
    const error: FingerError = {
      name: 'CtxError',
      message: 'With context',
      code: 'CTX',
      severity: 'error',
      retryable: true,
      context: { key: 'value', count: 5 },
    };
    expect(error.context).toEqual({ key: 'value', count: 5 });
  });
});
