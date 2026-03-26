import { describe, expect, it } from 'vitest';
import { skillsListTool, skillsStatusTool } from '../../../../src/tools/internal/skills-tool.js';

describe('skills internal tools', () => {
  it('skills.status returns watcher/cache metadata', async () => {
    const result = await skillsStatusTool.execute({ refresh: true }, {
      invocationId: 'tool-1',
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skillsDir: expect.any(String),
      watcherActive: expect.any(Boolean),
      cacheSize: expect.any(Number),
      cachedSkillNames: expect.any(Array),
    }));
  });

  it('skills.list returns installed skills array', async () => {
    const result = await skillsListTool.execute({ refresh: true }, {
      invocationId: 'tool-2',
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      count: expect.any(Number),
      skills: expect.any(Array),
    }));
  });
});
