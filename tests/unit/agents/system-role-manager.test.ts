import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agents/finger-system-agent/prompt-loader.js', () => ({
  loadPrompt: async (name: string, role?: string) => {
    const key = role ? `${role}/${name}` : name;
    const prompts: Record<string, string> = {
      'roles/user-interaction.md': 'User Interaction Prompt',
      'roles/agent-coordination.md': 'Agent Coordination Prompt',
    };
    return prompts[key] ?? `Missing ${key}`;
  },
}));

import { RoleManager } from '../../../src/agents/finger-system-agent/role-manager.js';

describe('RoleManager', () => {
  it('switches role and loads prompt', async () => {
    const manager = new RoleManager();

    const { role, prompt } = await manager.switchRole('user-interaction');

    expect(role).toBe('user-interaction');
    expect(prompt).toBe('User Interaction Prompt');
    expect(manager.getCurrentRole()).toBe('user-interaction');
  });

  it('caches prompts by role', async () => {
    const manager = new RoleManager();

    const first = await manager.loadRolePrompt('agent-coordination');
    const second = await manager.loadRolePrompt('agent-coordination');

    expect(first).toBe('Agent Coordination Prompt');
    expect(second).toBe(first);
  });
});
