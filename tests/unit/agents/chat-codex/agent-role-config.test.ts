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

  it('keeps only system/project base roles and exposes mailbox tools', () => {
    expect(Object.keys(BASE_AGENT_ROLE_CONFIG).sort()).toEqual(['project', 'system']);
    expect(BASE_AGENT_ROLE_CONFIG.project.allowedTools).toEqual(expect.arrayContaining([
      'skills.list',
      'skills.status',
      'user.ask',
      'mailbox.status',
      'mailbox.list',
      'mailbox.read',
      'mailbox.read_all',
      'mailbox.ack',
      'mailbox.remove',
      'mailbox.remove_all',
    ]));
    expect(BASE_AGENT_ROLE_CONFIG.system.allowedTools).toEqual(expect.arrayContaining([
      'skills.list',
      'skills.status',
      'project.task.status',
      'project.task.update',
      'agent.continue',
      'agent.query',
      'agent.progress.ask',
    ]));
    expect(BASE_AGENT_ROLE_CONFIG.project.allowedTools).toContain('report-task-completion');
    expect(BASE_AGENT_ROLE_CONFIG.system.allowedTools).toContain('exec_command');
    expect(BASE_AGENT_ROLE_CONFIG.system.allowedTools).not.toContain('shell.exec');
  });
});
