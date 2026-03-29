import { describe, expect, it } from 'vitest';
import { __fingerRoleModulesInternals } from '../../../src/server/modules/finger-role-modules';

const { isEffectivelyEmptyHistoryForBootstrap } = __fingerRoleModulesInternals as {
  isEffectivelyEmptyHistoryForBootstrap: (messages: Array<{ role: string; content: string }>) => boolean;
};

describe('finger-role-modules bootstrap gating', () => {
  it('treats empty history as bootstrap-eligible', () => {
    expect(isEffectivelyEmptyHistoryForBootstrap([])).toBe(true);
  });

  it('treats single current user turn as effectively empty history', () => {
    expect(
      isEffectivelyEmptyHistoryForBootstrap([
        { role: 'user', content: '继续执行这个任务' },
      ]),
    ).toBe(true);
  });

  it('disables auto bootstrap when prior conversation exists', () => {
    expect(
      isEffectivelyEmptyHistoryForBootstrap([
        { role: 'user', content: '任务A' },
        { role: 'assistant', content: '收到，处理中' },
      ]),
    ).toBe(false);
  });
});
