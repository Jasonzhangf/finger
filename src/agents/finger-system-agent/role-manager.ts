/**
 * System Agent Role Manager
 *
 * 管理 System Agent 的多角色提示词体系
 */

import { loadPrompt } from './prompt-loader.js';

export type SystemRole =
  | 'user-interaction'
  | 'agent-coordination'
  | 'task-dispatcher'
  | 'task-reporter'
  | 'mailbox-handler';

export interface RolePromptBundle {
  role: SystemRole;
  prompt: string;
}

export class RoleManager {
  private currentRole: SystemRole = 'user-interaction';
  private promptCache = new Map<SystemRole, string>();

  getCurrentRole(): SystemRole {
    return this.currentRole;
  }

  async switchRole(role: SystemRole): Promise<RolePromptBundle> {
    this.currentRole = role;
    const prompt = await this.loadRolePrompt(role);
    return { role, prompt };
  }

  async loadRolePrompt(role: SystemRole): Promise<string> {
    const cached = this.promptCache.get(role);
    if (cached) {
      return cached;
    }

    const prompt = await loadPrompt(`${role}.md`, 'roles');
    this.promptCache.set(role, prompt);
    return prompt;
  }

  clearCache(): void {
    this.promptCache.clear();
  }

  async reloadRolePrompt(role: SystemRole): Promise<string> {
    this.promptCache.delete(role);
    return this.loadRolePrompt(role);
  }
}
