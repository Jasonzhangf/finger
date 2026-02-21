import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getResourcePoolSummary,
  buildAgentContext,
  contextToSystemPrompt,
  generateDynamicSystemPrompt,
  type AgentContext,
} from '../../../src/orchestration/agent-context.js';

// Mock resourcePool
vi.mock('../../../src/orchestration/resource-pool.js', () => ({
  resourcePool: {
    getStatusReport: () => ({
      totalResources: 5,
      available: 3,
      busy: 1,
      error: 1,
    }),
    getCapabilityCatalog: () => [
      {
        capability: 'web_search',
        resourceCount: 2,
        availableCount: 2,
        resources: [
          { id: 'r1', name: 'executor-1', level: 1, status: 'available' },
          { id: 'r2', name: 'executor-2', level: 1, status: 'available' },
        ],
      },
      {
        capability: 'file_ops',
        resourceCount: 2,
        availableCount: 1,
        resources: [
          { id: 'r3', name: 'executor-3', level: 1, status: 'available' },
          { id: 'r4', name: 'executor-4', level: 1, status: 'busy' },
        ],
      },
      {
        capability: 'planning',
        resourceCount: 1,
        availableCount: 0,
        resources: [
          { id: 'r5', name: 'orchestrator', level: 1, status: 'error' },
        ],
      },
    ],
  },
}));

describe('agent-context', () => {
  describe('getResourcePoolSummary', () => {
    it('returns resource pool status', () => {
      const summary = getResourcePoolSummary();
      expect(summary.totalResources).toBe(5);
      expect(summary.available).toBe(3);
      expect(summary.busy).toBe(1);
      expect(summary.error).toBe(1);
      expect(summary.capabilityCatalog).toHaveLength(3);
    });
  });

  describe('buildAgentContext', () => {
    it('builds context without options', () => {
      const context = buildAgentContext();
      expect(context.timestamp).toBeDefined();
      expect(context.resourcePool.totalResources).toBe(5);
      expect(context.availableCapabilities).toContain('web_search');
      expect(context.availableCapabilities).toContain('file_ops');
      expect(context.availableCapabilities).not.toContain('planning');
      expect(context.task).toBeUndefined();
      expect(context.orchestratorNote).toBeUndefined();
    });

    it('builds context with task options', () => {
      const context = buildAgentContext({
        taskId: 'task-1',
        taskDescription: 'Test task',
        requiredCapabilities: ['web_search'],
        bdTaskId: 'bd-123',
      });
      expect(context.task).toBeDefined();
      expect(context.task?.id).toBe('task-1');
      expect(context.task?.description).toBe('Test task');
      expect(context.task?.requiredCapabilities).toEqual(['web_search']);
      expect(context.task?.bdTaskId).toBe('bd-123');
    });

    it('builds context with orchestrator note', () => {
      const context = buildAgentContext({
        orchestratorNote: 'Please focus on accuracy',
      });
      expect(context.orchestratorNote).toBe('Please focus on accuracy');
    });

    it('builds capabilityToResources mapping', () => {
      const context = buildAgentContext();
      expect(context.capabilityToResources['web_search']).toEqual(['r1', 'r2']);
      expect(context.capabilityToResources['file_ops']).toEqual(['r3']);
      expect(context.capabilityToResources['planning']).toEqual([]);
    });
  });

  describe('contextToSystemPrompt', () => {
    it('formats context without task', () => {
      const context: AgentContext = {
        timestamp: '2024-01-01T00:00:00.000Z',
        resourcePool: {
          totalResources: 5,
          available: 3,
          busy: 1,
          error: 1,
          capabilityCatalog: [],
        },
        availableCapabilities: ['web_search'],
        capabilityToResources: { web_search: ['r1'] },
      };
      const prompt = contextToSystemPrompt(context);
      expect(prompt).toContain('## 当前资源池状态');
      expect(prompt).toContain('总资源数：5');
      expect(prompt).toContain('可用：3');
    });

    it('formats context with task', () => {
      const context: AgentContext = {
        timestamp: '2024-01-01T00:00:00.000Z',
        resourcePool: {
          totalResources: 5,
          available: 3,
          busy: 1,
          error: 1,
          capabilityCatalog: [],
        },
        availableCapabilities: [],
        capabilityToResources: {},
        task: {
          id: 'task-1',
          description: 'Do something',
          requiredCapabilities: ['web_search'],
        },
      };
      const prompt = contextToSystemPrompt(context);
      expect(prompt).toContain('## 当前任务');
      expect(prompt).toContain('task-1');
      expect(prompt).toContain('Do something');
      expect(prompt).toContain('web_search');
    });

    it('formats context with orchestrator note', () => {
      const context: AgentContext = {
        timestamp: '2024-01-01T00:00:00.000Z',
        resourcePool: {
          totalResources: 5,
          available: 3,
          busy: 1,
          error: 1,
          capabilityCatalog: [],
        },
        availableCapabilities: [],
        capabilityToResources: {},
        orchestratorNote: 'Be careful',
      };
      const prompt = contextToSystemPrompt(context);
      expect(prompt).toContain('## 编排者指令');
      expect(prompt).toContain('Be careful');
    });
  });

  describe('generateDynamicSystemPrompt', () => {
    it('returns base prompt when no context', () => {
      const base = 'You are an assistant.';
      const result = generateDynamicSystemPrompt(base);
      expect(result).toBe(base);
    });

    it('appends context to base prompt', () => {
      const base = 'You are an assistant.';
      const context: AgentContext = {
        timestamp: '2024-01-01T00:00:00.000Z',
        resourcePool: {
          totalResources: 5,
          available: 3,
          busy: 1,
          error: 1,
          capabilityCatalog: [],
        },
        availableCapabilities: [],
        capabilityToResources: {},
      };
      const result = generateDynamicSystemPrompt(base, context);
      expect(result).toContain('You are an assistant.');
      expect(result).toContain('## 当前资源池状态');
    });
  });
});
