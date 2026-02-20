import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReActLoop, type ReActState, type LoopConfig } from '../../../src/agents/runtime/react-loop.js';
import type { Agent } from '../../../src/agents/agent.js';

describe('ReActLoop', () => {
  let mockAgent: Agent;
  let mockConfig: LoopConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgent = {
      think: vi.fn().mockResolvedValue({
        thought: 'Test thought',
        action: 'TEST_ACTION',
        params: { test: true },
      }),
      execute: vi.fn().mockResolvedValue({
        success: true,
        observation: 'Test observation',
      }),
    } as unknown as Agent;

    mockConfig = {
      planner: {
        agent: mockAgent,
        actionRegistry: {} as ActionRegistry,
      },
      stopConditions: {
        completeActions: ['COMPLETE'],
        failActions: ['FAIL'],
        maxRounds: 10,
      },
    };
  });

  describe('constructor', () => {
    it('should create ReActLoop instance', () => {
      const loop = new ReActLoop(mockConfig);
      expect(loop).toBeDefined();
    });
  });

  describe('run', () => {
    it('should return execution result', async () => {
      const loop = new ReActLoop(mockConfig);
      const result = await loop.run('Test task');

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('rounds');
      expect(result).toHaveProperty('iterations');
    });
  });
});
