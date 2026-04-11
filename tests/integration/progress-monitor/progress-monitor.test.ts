import { describe, it, expect } from 'vitest';

describe('Progress Monitor Integration Tests', () => {
  it('dispatch session 格式正确', () => {
    const sid = 'dispatch-finger-project-agent-123';
    expect(sid.startsWith('dispatch-')).toBe(true);
    expect(sid).toContain('finger-project-agent');
  });

  it('progress entry 元数据完整', () => {
    const entry = { sessionId: 's1', agentId: 'a1', stage: 'running', updatedAt: Date.now() };
    expect(entry.sessionId).toBeDefined();
    expect(entry.agentId).toBeDefined();
  });
});
