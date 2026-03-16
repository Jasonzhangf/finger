/**
 * System Agent Tools Integration Tests
 * 
 * 测试 System Registry Tool 和 Report Task Completion Tool 的集成功能
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../../src/runtime/tool-registry.js';
import { registerSystemRegistryTool } from '../../src/tools/internal/system-registry-tool.js';
import { registerReportTaskCompletionTool } from '../../src/tools/internal/report-task-completion-tool.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SYSTEM_DIR = path.join(os.homedir(), '.finger', 'system');
const REGISTRY_PATH = path.join(SYSTEM_DIR, 'registry.json');

// Mock agent runtime deps
const createMockDeps = () => ({
  agentRuntimeBlock: {
    execute: vi.fn().mockResolvedValue({ ok: true }),
  },
  sessionManager: {
    getCurrentSession: vi.fn().mockReturnValue({ id: 'test-session' }),
  },
  runtimeInstructionBus: {
    send: vi.fn().mockResolvedValue(undefined),
  },
});

describe('System Registry Tool Integration', () => {
  let registry: ToolRegistry;
  let getDeps: () => ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    const deps = createMockDeps();
    getDeps = () => deps;
    registerSystemRegistryTool(registry, getDeps);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers system-registry-tool with correct schema', () => {
    expect(registry.isAvailable('system-registry-tool')).toBe(true);
  });

  it('executes register action', async () => {
    const result = await registry.execute('system-registry-tool', {
      action: 'register',
      projectId: 'test-project',
      projectPath: '/tmp/test-project',
      projectName: 'Test Project',
      agentId: 'test-agent',
    });

    expect((result as any).ok).toBe(true);
  });

  it('executes list action', async () => {
    // First register an agent
    await registry.execute('system-registry-tool', {
      action: 'register',
      projectId: 'test-project-1',
      projectPath: '/tmp/test-project-1',
      projectName: 'Test Project 1',
      agentId: 'test-agent-1',
    });

    const result = await registry.execute('system-registry-tool', {
      action: 'list',
    });

    expect((result as any).ok).toBe(true);
    expect(Array.isArray((result as any).agents)).toBe(true);
  });

  it('executes get_status action', async () => {
    // Register an agent first
    await registry.execute('system-registry-tool', {
      action: 'register',
      projectId: 'test-project-2',
      projectPath: '/tmp/test-project-2',
      projectName: 'Test Project 2',
      agentId: 'test-agent-2',
    });

    const result = await registry.execute('system-registry-tool', {
      action: 'get_status',
      agentId: 'test-agent-2',
    });

    expect((result as any).ok).toBe(true);
    expect((result as any).agent).toBeDefined();
  });

  it('executes unregister action', async () => {
    // Register an agent first
    await registry.execute('system-registry-tool', {
      action: 'register',
      projectId: 'test-project-3',
      projectPath: '/tmp/test-project-3',
      projectName: 'Test Project 3',
      agentId: 'test-agent-3',
    });

    const result = await registry.execute('system-registry-tool', {
      action: 'unregister',
      agentId: 'test-agent-3',
    });

    expect((result as any).ok).toBe(true);
  });

  it('executes heartbeat action', async () => {
    // Register an agent first
    await registry.execute('system-registry-tool', {
      action: 'register',
      projectId: 'test-project-4',
      projectPath: '/tmp/test-project-4',
      projectName: 'Test Project 4',
      agentId: 'test-agent-4',
    });

    const result = await registry.execute('system-registry-tool', {
      action: 'heartbeat',
      agentId: 'test-agent-4',
    });

    expect((result as any).ok).toBe(true);
  });
});

describe('Report Task Completion Tool Integration', () => {
  let registry: ToolRegistry;
  let getDeps: () => ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    const deps = createMockDeps();
    getDeps = () => deps;
    registerReportTaskCompletionTool(registry, getDeps);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers report-task-completion tool with correct schema', () => {
    expect(registry.isAvailable('report-task-completion')).toBe(true);
  });

  it('executes report action with success result', async () => {
    const result = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-123',
      taskSummary: 'Completed feature X',
      sessionId: 'session-456',
      result: 'success',
      projectId: 'project-789',
    });

    expect((result as any).ok).toBe(true);
    expect((result as any).action).toBe('report');
  });

  it('executes report action with failure result', async () => {
    const result = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-456',
      taskSummary: 'Failed to complete feature Y',
      sessionId: 'session-789',
      result: 'failure',
      projectId: 'project-123',
    });

    expect((result as any).ok).toBe(true);
    expect((result as any).action).toBe('report');
  });

  it('rejects invalid action', async () => {
    const result = await registry.execute('report-task-completion', {
      action: 'invalid',
      taskId: 'task-123',
    });

    expect((result as any).ok).toBe(false);
    expect((result as any).error).toContain('Unsupported action');
  });
});
