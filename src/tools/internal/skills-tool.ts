import type { InternalTool, ToolExecutionContext } from './types.js';
import { getGlobalSkillsManager } from '../../skills/skill-manager.js';

type SkillsToolInput = {
  refresh?: boolean;
};

function getSkillsManager() {
  return getGlobalSkillsManager();
}

export const skillsListTool: InternalTool = {
  name: 'skills.list',
  executionModel: 'state',
  description: 'List currently installed Finger skills from ~/.finger/skills. Use this to verify whether a newly installed skill is visible to the next turn.',
  inputSchema: {
    type: 'object',
    properties: {
      refresh: {
        type: 'boolean',
        description: 'Force refresh from disk before listing skills.',
      },
    },
  },
  async execute(input: unknown, _context: ToolExecutionContext) {
    const skillsManager = getSkillsManager();
    const refresh = Boolean((input as SkillsToolInput | undefined)?.refresh);
    const skills = refresh
      ? await skillsManager.listSkills()
      : skillsManager.listSkillsSync();

    return {
      success: true,
      count: skills.length,
      skills: skills
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: skill.path,
          exists: skill.exists,
        })),
    };
  },
};

export const skillsStatusTool: InternalTool = {
  name: 'skills.status',
  executionModel: 'state',
  description: 'Show current skills loader status, watcher state, cache status, and optionally force a disk refresh. Use this when a newly installed skill does not appear immediately.',
  inputSchema: {
    type: 'object',
    properties: {
      refresh: {
        type: 'boolean',
        description: 'Force refresh from disk before returning status.',
      },
    },
  },
  async execute(input: unknown, _context: ToolExecutionContext) {
    const skillsManager = getSkillsManager();
    const refresh = Boolean((input as SkillsToolInput | undefined)?.refresh);
    if (refresh) {
      await skillsManager.listSkills();
    } else {
      skillsManager.listSkillsSync();
    }
    const status = skillsManager.getStatus();
    return {
      success: true,
      ...status,
    };
  },
};
