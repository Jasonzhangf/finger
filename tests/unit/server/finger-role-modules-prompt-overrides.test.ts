/**
 * @file Unit tests for prompt-field convergence in finger-role-modules.
 *
 * Key invariant:
 * - System field stays as generic Codex coding prompt.
 * - Finger system-specific rules go via developer prompt path.
 * - No `codingPromptPath` override should be generated from runtime config.
 */

import { describe, it, expect } from 'vitest';
import { __fingerRoleModulesInternals } from '../../../src/server/modules/finger-role-modules';

const { resolveRolePromptOverridesFromConfig } = __fingerRoleModulesInternals;

type RuntimePromptConfig = {
  prompts?: {
    system?: string;
    developer?: string;
  };
};

type FingerRoleSpec = {
  roleProfile: string;
};

type ChatCodexDeveloperRole = string;

describe('resolveRolePromptOverridesFromConfig', () => {
  const systemRole: FingerRoleSpec = { roleProfile: 'system' };
  const projectRole: FingerRoleSpec = { roleProfile: 'project' };
  const developerRole: ChatCodexDeveloperRole = 'orchestrator';
  const testAgentId = 'test-agent';

  describe('system role (roleProfile === "system")', () => {
    it('should use runtime prompts.system as developerPromptPath (not codingPromptPath)', () => {
      const config: RuntimePromptConfig = {
        prompts: {
          system: 'prompts/prompt.md',
          developer: 'prompts/dev/orchestrator.md',
        },
      };

      const result = resolveRolePromptOverridesFromConfig(config, systemRole, developerRole, testAgentId);

      // Key assertion: system prompt goes to developer path, NOT coding prompt path
      expect(result.developerPromptPath).toMatch(/runtime\/agents\/test-agent\/prompts\/prompt\.md$/);
      expect(result.developerPromptPaths).toEqual({
        orchestrator: expect.stringMatching(/runtime\/agents\/test-agent\/prompts\/prompt\.md$/),
      });
      // Should NOT have codingPromptPath
      expect((result as Record<string, unknown>).codingPromptPath).toBeUndefined();
    });

    it('should fallback to developer path if system path is empty', () => {
      const config: RuntimePromptConfig = {
        prompts: {
          system: '',
          developer: 'prompts/dev/orchestrator.md',
        },
      };

      const result = resolveRolePromptOverridesFromConfig(config, systemRole, developerRole, testAgentId);

      expect(result.developerPromptPath).toMatch(/runtime\/agents\/test-agent\/prompts\/dev\/orchestrator\.md$/);
    });

    it('should return empty object if both paths are empty', () => {
      const config: RuntimePromptConfig = {
        prompts: {
          system: '',
          developer: '',
        },
      };

      const result = resolveRolePromptOverridesFromConfig(config, systemRole, developerRole, testAgentId);

      expect(result).toEqual({});
    });
  });

  describe('non-system role (roleProfile !== "system")', () => {
    it('should use runtime prompts.developer as developerPromptPath', () => {
      const config: RuntimePromptConfig = {
        prompts: {
          system: 'prompts/prompt.md',
          developer: 'prompts/dev/project-agent.md',
        },
      };

      const result = resolveRolePromptOverridesFromConfig(config, projectRole, developerRole, testAgentId);

      // Non-system role uses developer path directly
      expect(result.developerPromptPath).toMatch(/runtime\/agents\/test-agent\/prompts\/dev\/project-agent\.md$/);
      expect(result.developerPromptPaths).toEqual({
        orchestrator: expect.stringMatching(/runtime\/agents\/test-agent\/prompts\/dev\/project-agent\.md$/),
      });
      // Should NOT have codingPromptPath
      expect((result as Record<string, unknown>).codingPromptPath).toBeUndefined();
    });

    it('should return empty object if developer path is empty', () => {
      const config: RuntimePromptConfig = {
        prompts: {
          system: 'prompts/prompt.md',
          developer: '',
        },
      };

      const result = resolveRolePromptOverridesFromConfig(config, projectRole, developerRole, testAgentId);

      expect(result).toEqual({});
    });
  });

  describe('edge cases', () => {
    it('should handle undefined config', () => {
      const result = resolveRolePromptOverridesFromConfig(undefined, systemRole, developerRole, testAgentId);
      expect(result).toEqual({});
    });

    it('should handle config without prompts', () => {
      const config: RuntimePromptConfig = {};
      const result = resolveRolePromptOverridesFromConfig(config, systemRole, developerRole, testAgentId);
      expect(result).toEqual({});
    });

    it('should handle whitespace-only paths', () => {
      const config: RuntimePromptConfig = {
        prompts: {
          system: '   ',
          developer: '\t\n',
        },
      };

      const result = resolveRolePromptOverridesFromConfig(config, systemRole, developerRole, testAgentId);
      expect(result).toEqual({});
    });
  });
});
