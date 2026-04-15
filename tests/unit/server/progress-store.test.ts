import { beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/orchestration/session-types.js';
import { progressStore, SESSION_PROGRESS_CONTEXT_KEY } from '../../../src/server/modules/progress/index.js';

describe('progress-store last-known-good semantics', () => {
  beforeEach(() => {
    progressStore.setSessionManager(undefined);
    progressStore.clear('session-progress-store-merge');
    progressStore.clear('session-progress-store-hydrate');
  });

  it('merges incoming kernel metadata onto last-known-good instead of overwriting missing fields', () => {
    progressStore.update({
      type: 'progress_update',
      source: 'kernel_response',
      sessionId: 'session-progress-store-merge',
      agentId: 'finger-system-agent',
      timestamp: new Date('2026-04-15T08:00:00.000Z'),
      kernelMetadata: {
        round: 1,
        seq: 1,
        input_tokens: 3200,
        output_tokens: 180,
        total_tokens: 3380,
        estimated_tokens_in_context_window: 118000,
        context_window: 262144,
        context_usage_percent: 45,
      },
    });

    progressStore.update({
      type: 'progress_update',
      source: 'kernel_response',
      sessionId: 'session-progress-store-merge',
      agentId: 'finger-system-agent',
      timestamp: new Date('2026-04-15T08:00:02.000Z'),
      kernelMetadata: {
        round: 2,
        seq: 2,
        context_window: 262144,
      },
    });

    expect(progressStore.getKernelMetadata('session-progress-store-merge', 'finger-system-agent')).toMatchObject({
      round: 2,
      seq: 2,
      input_tokens: 3200,
      output_tokens: 180,
      total_tokens: 3380,
      estimated_tokens_in_context_window: 118000,
      context_window: 262144,
      context_usage_percent: 45,
    });
  });

  it('hydrates last-known-good snapshot from session context when memory store is empty', () => {
    const session: Session = {
      id: 'session-progress-store-hydrate',
      name: 'hydrate-test',
      projectPath: '/tmp/finger-project',
      createdAt: '2026-04-15T08:00:00.000Z',
      updatedAt: '2026-04-15T08:00:00.000Z',
      lastAccessedAt: '2026-04-15T08:00:00.000Z',
      messages: [],
      activeWorkflows: [],
      context: {
        [SESSION_PROGRESS_CONTEXT_KEY]: {
          version: 1,
          byAgent: {
            'finger-system-agent': {
              latestKernelMetadata: {
                round: 7,
                seq: 19,
                input_tokens: 6400,
                total_tokens: 6600,
                estimated_tokens_in_context_window: 154000,
                context_window: 262144,
                context_usage_percent: 58,
              },
              lastKernelResponseAt: '2026-04-15T08:05:00.000Z',
              lastProgressUpdateAt: '2026-04-15T08:05:01.000Z',
            },
          },
        },
      },
      ledgerPath: 'sessions/session-progress-store-hydrate',
      latestCompactIndex: -1,
      originalStartIndex: 0,
      originalEndIndex: -1,
      totalTokens: 0,
    };

    progressStore.setSessionManager({
      getSession(sessionId: string) {
        return sessionId === session.id ? session : null;
      },
      updateContext() {
        return true;
      },
    });

    const snapshot = progressStore.get('session-progress-store-hydrate', 'finger-system-agent');
    expect(snapshot?.latestKernelMetadata).toMatchObject({
      round: 7,
      seq: 19,
      input_tokens: 6400,
      total_tokens: 6600,
      estimated_tokens_in_context_window: 154000,
      context_window: 262144,
      context_usage_percent: 58,
    });
    expect(snapshot?.lastKernelResponseAt?.toISOString()).toBe('2026-04-15T08:05:00.000Z');
  });
});
