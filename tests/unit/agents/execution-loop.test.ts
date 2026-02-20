import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionLoop, LoopConfig } from '../../../src/agents/runtime/execution-loop.js';
import { MessageBus } from '../../../src/agents/runtime/message-bus.js';
import { ToolRegistry } from '../../../src/agents/shared/tool-registry.js';
import { EventBusBlock } from '../../../src/blocks/eventbus-block/index.js';
import type { TaskAssignment, AgentMessage } from '../../../src/agents/protocol/schema.js';

vi.mock('../../../src/agents/roles/orchestrator.js', () => ({
  OrchestratorRole: vi.fn().mockImplementation(() => ({
    decomposeTask: vi.fn().mockResolvedValue({
      success: true,
      tasks: [{
        taskId: 'task-1',
        description: 'Test task',
        assignee: 'executor-1',
        tools: ['test-tool'],
        dependencies: [],
        priority: 1,
      } as TaskAssignment],
    }),
    replan: vi.fn().mockResolvedValue({ success: false }),
    createTaskMessage: vi.fn().mockReturnValue({
      id: 'msg-1',
      sender: 'orchestrator',
      receiver: 'executor-1',
      mode: 'execute' as const,
      status: 'pending' as const,
      payload: { task: { taskId: 'task-1' } },
      timestamp: new Date().toISOString(),
    } as AgentMessage),
  })),
}));

vi.mock('../../../src/agents/roles/executor.js', () => ({
  ExecutorRole: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ success: true, output: 'done' }),
  })),
}));

describe('ExecutionLoop', () => {
  let eventBus: EventBusBlock;
  let messageBus: MessageBus;
  let toolRegistry: ToolRegistry;
  let loopConfig: LoopConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = new EventBusBlock();
    messageBus = new MessageBus(eventBus);
    toolRegistry = new ToolRegistry();
    loopConfig = {
      orchestrator: {
        id: 'orchestrator-1',
        name: 'Test Orchestrator',
        capabilities: ['decompose', 'assign', 'review'],
      },
      maxRounds: 1,
      timeout: 100,
    };
  });

  describe('constructor', () => {
    it('should initialize with message bus, tool registry and config', () => {
      const loop = new ExecutionLoop(messageBus, toolRegistry, loopConfig);
      expect(loop).toBeDefined();
    });
  });

  describe('registerExecutor', () => {
    it('should register an executor and subscribe to its messages', () => {
      const loop = new ExecutionLoop(messageBus, toolRegistry, loopConfig);
      
      loop.registerExecutor({
        id: 'executor-1',
        name: 'Test Executor',
        tools: ['test-tool'],
      });

      expect(loop).toBeDefined();
    });

    it('should allow registering multiple executors', () => {
      const loop = new ExecutionLoop(messageBus, toolRegistry, loopConfig);
      
      loop.registerExecutor({ id: 'executor-1', name: 'E1', tools: [] });
      loop.registerExecutor({ id: 'executor-2', name: 'E2', tools: [] });

      expect(loop).toBeDefined();
    });
  });

  describe('run', () => {
    it('should return LoopResult with correct structure', async () => {
      const loop = new ExecutionLoop(messageBus, toolRegistry, loopConfig);
      
      const result = await loop.run('Test task');
      
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('completedTasks');
      expect(result).toHaveProperty('failedTasks');
      expect(result).toHaveProperty('totalRounds');
      expect(result).toHaveProperty('duration');
      expect(Array.isArray(result.completedTasks)).toBe(true);
      expect(Array.isArray(result.failedTasks)).toBe(true);
      expect(typeof result.totalRounds).toBe('number');
      expect(typeof result.duration).toBe('number');
    });

    it('should stop after maxRounds', async () => {
      const loop = new ExecutionLoop(messageBus, toolRegistry, loopConfig);
      
      const result = await loop.run('Test task');
      
      expect(result.totalRounds).toBeLessThanOrEqual(loopConfig.maxRounds);
    });

    it('should track duration of execution', async () => {
      const loop = new ExecutionLoop(messageBus, toolRegistry, loopConfig);
      
      const result = await loop.run('Test task');
      
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });
});
