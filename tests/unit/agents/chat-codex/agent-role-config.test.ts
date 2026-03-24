import { describe, it, expect } from 'vitest';
import { BASE_AGENT_ROLE_CONFIG, resolveBaseAgentRole } from '../../../../src/agents/chat-codex/agent-role-config.js';

describe('agent-role-config', () => {
  it('converges legacy execution/orchestration aliases to project', () => {
    expect(resolveBaseAgentRole('orchestrator')).toBe('project');
    expect(resolveBaseAgentRole('executor')).toBe('project');
    expect(resolveBaseAgentRole('coder')).toBe('project');
    expect(resolveBaseAgentRole('searcher')).toBe('project');
    expect(resolveBaseAgentRole('general')).toBe('project');
  });

  it('keeps only system/project/reviewer base roles and exposes mailbox tools', () => {
    expect(Object.keys(BASE_AGENT_ROLE_CONFIG).sort()).toEqual(['project', 'reviewer', 'system']);
    expect(BASE_AGENT_ROLE_CONFIG.project.allowedTools).toEqual(expect.arrayContaining([
      'mailbox.status',
      'mailbox.list',
      'mailbox.read',
      'mailbox.read_all',
      'mailbox.ack',
      'mailbox.remove',
      'mailbox.remove_all',
    ]));
    expect(BASE_AGENT_ROLE_CONFIG.reviewer.allowedTools).toEqual(expect.arrayContaining([
      'user.ask',
      'mailbox.status',
      'mailbox.list',
      'mailbox.read',
      'mailbox.read_all',
      'mailbox.ack',
      'mailbox.remove',
      'mailbox.remove_all',
    ]));
    expect(BASE_AGENT_ROLE_CONFIG.project.allowedTools).toContain('report-task-completion');
  });
});
