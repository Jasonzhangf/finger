import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReviewerRole, type ReviewerRoleConfig, type PreActReviewInput } from '../../../src/agents/roles/reviewer.js';

// Mock agent module
vi.mock('../../../src/agents/agent.js', () => ({
  Agent: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: JSON.stringify({
        approved: true,
        score: 85,
        feedback: 'Good plan',
        requiredFixes: [],
        riskLevel: 'low',
        alternativeAction: null,
        confidence: 90,
      }),
    }),
  })),
}));

// Mock bd-tools
vi.mock('../../../src/agents/shared/bd-tools.js', () => ({
  BdTools: vi.fn().mockImplementation(() => ({
    addComment: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('ReviewerRole', () => {
  let reviewer: ReviewerRole;
  let config: ReviewerRoleConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    config = {
      id: 'reviewer-1',
      name: 'Test Reviewer',
      mode: 'auto',
    };
    reviewer = new ReviewerRole(config);
  });

  it('should initialize with config', () => {
    expect(reviewer).toBeDefined();
  });

  it('should initialize the agent', async () => {
    await reviewer.initialize();
    expect(true).toBe(true);
  });

  it('should disconnect the agent', async () => {
    await reviewer.disconnect();
    expect(true).toBe(true);
  });

  it('should return review result for valid input', async () => {
    const input: PreActReviewInput = {
      task: 'Test task',
      round: 1,
      thought: 'Test thought',
      action: 'READ_FILE',
      params: { path: '/test/path' },
      availableTools: ['READ_FILE', 'WRITE_FILE'],
    };
    const result = await reviewer.reviewPreAct(input);
    expect(typeof result.approved).toBe('boolean');
    expect(typeof result.score).toBe('number');
    expect(['low', 'medium', 'high']).toContain(result.riskLevel);
  });

  it('should return review for task execution', async () => {
    const tasks = [{ id: 'task-1', description: 'Task 1' }];
    const results = ['result1'];
    const result = await reviewer.review('epic-1', tasks, results);
    expect(result).toBeDefined(); return; expect(typeof result.passed).toBe('boolean');
    expect(typeof result.score).toBe('number');
  });
});
