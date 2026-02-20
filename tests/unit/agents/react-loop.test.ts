import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReActLoop, type LoopConfig } from '../../../src/agents/runtime/react-loop.js';
import type { Agent } from '../../../src/agents/agent.js';
import { SnapshotLogger } from '../../../src/agents/shared/snapshot-logger.js';

vi.mock('../../../src/agents/shared/snapshot-logger.js', () => ({
  SnapshotLogger: vi.fn().mockImplementation(() => ({
    log: vi.fn(),
    getHistory: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../../../src/agents/shared/session-logger.js', () => ({
  SessionLogger: vi.fn().mockImplementation(() => ({
    log: vi.fn(),
    getHistory: vi.fn().mockReturnValue([]),
    getSessionId: vi.fn().mockReturnValue('test-session'),
    complete: vi.fn(),
    addIteration: vi.fn(),
  })),
}));

describe('ReActLoop', () => {
  let mockAgent: Agent;
  let mockSnapshotLogger: SnapshotLogger;
  let mockActionRegistry: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
  };
  let mockConfig: LoopConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockSnapshotLogger = {
      log: vi.fn(),
      getHistory: vi.fn().mockReturnValue([]),
    } as unknown as SnapshotLogger;

    mockActionRegistry = {
      list: vi.fn().mockReturnValue([
        { name: 'COMPLETE', description: 'Complete task', paramsSchema: {} },
        { name: 'FAIL', description: 'Fail task', paramsSchema: {} },
      ]),
      get: vi.fn().mockReturnValue(true),
      execute: vi.fn().mockResolvedValue({
        success: true,
        observation: 'Test observation',
      }),
    };

    mockAgent = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: JSON.stringify({
          thought: 'Test thought',
          action: 'COMPLETE',
          params: {},
        }),
      }),
    } as unknown as Agent;

    mockConfig = {
      planner: {
        agent: mockAgent,
        actionRegistry: mockActionRegistry,
      },
      stopConditions: {
        completeActions: ['COMPLETE'],
        failActions: ['FAIL'],
        maxRounds: 10,
      },
      formatFix: {
        maxRetries: 2,
        schema: { type: 'object', required: [], properties: {} },
      },
      snapshotLogger: mockSnapshotLogger,
    };
  });

  describe('constructor', () => {
    it('should create ReActLoop instance', () => {
      const loop = new ReActLoop(mockConfig, 'Test task');
      expect(loop).toBeDefined();
    });
  });

  describe('run', () => {
    it('should return execution result with complete action', async () => {
      const loop = new ReActLoop(mockConfig, 'Test task');
      const result = await loop.run();

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('iterations');
      expect(result).toHaveProperty('totalRounds');
      expect(result).toHaveProperty('duration');
      expect(result.success).toBe(true);
    });
  });
});
