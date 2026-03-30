import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setupReviewRuntimeForDispatch } from '../../../../src/agents/finger-system-agent/review-runtime.js';
import { upsertReviewRoute } from '../../../../src/agents/finger-system-agent/review-route-registry.js';

vi.mock('../../../../src/agents/finger-system-agent/review-route-registry.js', () => ({
  upsertReviewRoute: vi.fn(),
}));

describe('review-runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers review contract without pre-dispatching reviewer task', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true });
    await setupReviewRuntimeForDispatch({
      agentRuntimeBlock: { execute },
    } as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionId: 'session-1',
      task: {
        prompt: 'Build QQ image delivery pipeline',
      },
      assignment: {
        taskId: 'task-123',
        taskName: 'qq-image-delivery',
        reviewRequired: true,
        acceptanceCriteria: 'Image attachments must route by attachment metadata.',
      },
      metadata: {
        projectId: 'project-1',
        dispatchParentSessionId: 'session-root',
      },
    } as any);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('deploy', expect.objectContaining({
      targetAgentId: 'finger-reviewer',
      sessionId: 'session-1',
    }));
    expect(upsertReviewRoute).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-123',
      taskName: 'qq-image-delivery',
      reviewRequired: true,
      acceptanceCriteria: 'Image attachments must route by attachment metadata.',
      reviewAgentId: 'finger-reviewer',
    }));
  });

  it('skips when review is not required', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true });
    await setupReviewRuntimeForDispatch({
      agentRuntimeBlock: { execute },
    } as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionId: 'session-1',
      task: { prompt: 'task' },
      assignment: { taskId: 'task-123', reviewRequired: false },
    } as any);

    expect(execute).not.toHaveBeenCalled();
    expect(upsertReviewRoute).not.toHaveBeenCalled();
  });
});
