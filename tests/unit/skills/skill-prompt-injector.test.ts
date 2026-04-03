import { beforeEach, describe, expect, it, vi } from 'vitest';

const { manager } = vi.hoisted(() => ({
  manager: {
    listSkills: vi.fn(),
    listSkillsSync: vi.fn(),
    listSkillsScopedSync: vi.fn(),
  },
}));

vi.mock('../../../src/skills/skill-manager.js', () => ({
  getGlobalSkillsManager: () => manager,
}));

vi.mock('../../../src/core/logger.js', () => ({
  logger: {
    module: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock('../../../src/core/logger/console-like.js', () => ({
  createConsoleLikeLogger: () => ({
    error: vi.fn(),
  }),
}));

import { formatSkillsAsPromptSync } from '../../../src/skills/skill-prompt-injector.js';

describe('skill-prompt-injector', () => {
  beforeEach(() => {
    manager.listSkills.mockReset();
    manager.listSkillsSync.mockReset();
    manager.listSkillsScopedSync.mockReset();
  });

  it('includes ledger-retrieval guidance in skills prompt', () => {
    manager.listSkillsScopedSync.mockReturnValue([
      {
        name: 'email-skills',
        description: 'Read and send email.',
        path: '/Users/fanzhang/.finger/skills/email-skills',
      },
    ]);

    const prompt = formatSkillsAsPromptSync();

    expect(prompt).toContain('Skills are workflows, not the canonical history store.');
    expect(prompt).toContain('retrieve them via `context_ledger.memory` instead of guessing');
    expect(prompt).toContain('absence from prompt does not prove the event never happened');
  });
});
