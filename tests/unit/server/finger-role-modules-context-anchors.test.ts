import { describe, expect, it } from 'vitest';
import { __fingerRoleModulesInternals } from '../../../src/server/modules/finger-role-modules';

const {
  extractRecentTaskMessages,
  extractRecentUserInputs,
  augmentHistoryWithContinuityAnchors,
} = __fingerRoleModulesInternals;

describe('finger-role-modules continuity anchors', () => {
  const sessionMessages = [
    { id: 'u1', role: 'user', content: '任务1：检查邮箱通知', timestamp: '2026-03-28T10:00:00.000Z' },
    { id: 'a1', role: 'assistant', content: '先看邮箱脚本。', timestamp: '2026-03-28T10:00:05.000Z' },
    { id: 's1', role: 'system', content: '调用工具: reasoning.stop', timestamp: '2026-03-28T10:00:10.000Z' },
    { id: 'u2', role: 'user', content: '任务2：继续修邮件去重', timestamp: '2026-03-28T10:01:00.000Z' },
    { id: 'a2', role: 'assistant', content: '我正在检查去重逻辑。', timestamp: '2026-03-28T10:01:10.000Z' },
    { id: 's2', role: 'system', content: '调用工具: reasoning.stop', timestamp: '2026-03-28T10:01:15.000Z' },
    { id: 'u3', role: 'user', content: '任务3：再看看新闻推送格式', timestamp: '2026-03-28T10:02:00.000Z' },
    { id: 'a3', role: 'assistant', content: '我会一起检查新闻模板。', timestamp: '2026-03-28T10:02:10.000Z' },
    { id: 's3', role: 'system', content: '调用工具: reasoning.stop', timestamp: '2026-03-28T10:02:15.000Z' },
    { id: 'u4', role: 'user', content: '继续，不要停', timestamp: '2026-03-28T10:03:00.000Z' },
  ];

  it('extracts the recent two completed task windows from session history', () => {
    const tasks = extractRecentTaskMessages(sessionMessages, 2);
    expect(tasks.map((item) => item.id)).toEqual(['u2', 'a2', 's2', 'u3', 'a3', 's3']);
  });

  it('extracts up to the recent ten user inputs from session history', () => {
    const users = extractRecentUserInputs(sessionMessages, 10);
    expect(users.map((item) => item.id)).toEqual(['u1', 'u2', 'u3', 'u4']);
  });

  it('preserves recent tasks and recent user inputs even when selected history is rebuilt and shorter', () => {
    const selected = [
      {
        id: 'u1',
        role: 'user' as const,
        content: '任务1：检查邮箱通知',
        timestamp: '2026-03-28T10:00:00.000Z',
        metadata: { contextBuilderHistorySource: 'context_builder_indexed' },
      },
      {
        id: 'a1',
        role: 'assistant' as const,
        content: '先看邮箱脚本。',
        timestamp: '2026-03-28T10:00:05.000Z',
        metadata: { contextBuilderHistorySource: 'context_builder_indexed' },
      },
    ];

    const augmented = augmentHistoryWithContinuityAnchors(selected, sessionMessages, 10, {
      contextBuilderHistorySource: 'context_builder_indexed',
      contextBuilderRebuilt: false,
    });

    expect(augmented.map((item) => item.id)).toEqual(['u1', 'a1', 'u2', 'a2', 's2', 'u3', 'a3', 's3', 'u4']);
    expect(augmented.find((item) => item.id === 'u3')?.metadata?.continuityAnchor).toBe(true);
    expect(augmented.find((item) => item.id === 'u3')?.metadata?.contextZone).toBe('working_set');
    expect(augmented.find((item) => item.id === 's3')?.metadata?.contextZone).toBe('working_set');
    expect(augmented.find((item) => item.id === 'u4')?.metadata?.continuityAnchorTypes).toEqual(
      expect.arrayContaining(['recent_user_input']),
    );
  });
});
