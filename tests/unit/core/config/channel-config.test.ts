import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'fs';
import {
  loadFingerConfig,
  getChannelAuth,
  getChannelPermissionMode,
  getChannelPermissionWhitelist,
  getChannelPermissionBlacklist,
  getChannelHighRiskCommands,
  getChannelRejectConfig,
  resolveDefaultProject,
  resolveHomePath,
  type FingerConfig,
} from '../../../../src/core/config/channel-config.js';

// Mock FINGER_PATHS
vi.mock('../../../../src/core/finger-paths.js', () => ({
  FINGER_PATHS: {
    home: '/home/testuser',
    config: {
      dir: '/home/testuser/.finger/config',
      file: {
        main: '/home/testuser/.finger/config/config.json',
      },
    },
    logs: {
      dir: '/home/testuser/.finger/logs',
    },
  },
}));

describe('ChannelConfig', () => {
  const mockConfigContent = JSON.stringify({
    kernel: { providers: {} },
    channelAuth: {
      enabled: true,
      defaultPolicy: 'mailbox',
      channels: [
        { id: 'webui', type: 'direct', priority: 10 },
        { id: 'qqbot', type: 'direct', priority: 20 },
        { id: 'feishu', type: 'mailbox', priority: 30 },
      ],
    },
    systemAuth: {
      enabled: true,
      password: 'sha256:abc123def456',
    },
    defaults: {
      projectPath: '~/myproject',
      useLastProject: false,
    },
  }, null, 2);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadFingerConfig', () => {
    it('loads default config when file does not exist', async () => {
      (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const config = await loadFingerConfig();
      expect(config.channelAuth?.enabled).toBe(true);
      expect(config.channelAuth?.defaultPolicy).toBe('direct');
      expect(config.channelAuth?.channels).toHaveLength(5);
      expect(config.systemAuth?.enabled).toBe(true);
      expect(config.systemAuth?.password).toBe(null);
    });

    it('loads and merges config from file', async () => {
      (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockConfigContent);
      const config = await loadFingerConfig();
      expect(config.channelAuth?.defaultPolicy).toBe('mailbox');
      expect(config.channelAuth?.channels).toHaveLength(3);
      expect(config.systemAuth?.password).toBe('sha256:abc123def456');
      expect(config.defaults?.projectPath).toBe('~/myproject');
    });

    it('returns default config on parse error', async () => {
      (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('Invalid JSON');
      });
      const config = await loadFingerConfig();
      expect(config.channelAuth?.enabled).toBe(true);
      expect(config.channelAuth?.defaultPolicy).toBe('direct');
    });
  });

  describe('getChannelAuth', () => {
    it('returns direct policy for direct channel', async () => {
      const config: FingerConfig = {
        channelAuth: {
          enabled: true,
          defaultPolicy: 'mailbox',
          channels: [
            { id: 'webui', type: 'direct', priority: 10 },
          ],
        },
      };
      expect(getChannelAuth(config, 'webui')).toBe('direct');
    });

    it('returns mailbox policy for mailbox channel', async () => {
      const config: FingerConfig = {
        channelAuth: {
          enabled: true,
          defaultPolicy: 'direct',
          channels: [
            { id: 'feishu', type: 'mailbox', priority: 30 },
          ],
        },
      };
      expect(getChannelAuth(config, 'feishu')).toBe('mailbox');
    });

    it('returns defaultPolicy when channel not found', async () => {
      const config: FingerConfig = {
        channelAuth: {
          enabled: true,
          defaultPolicy: 'direct',
          channels: [],
        },
      };
      expect(getChannelAuth(config, 'unknown')).toBe('direct');
    });

    it('returns defaultPolicy when channelAuth disabled', async () => {
      const config: FingerConfig = {
        channelAuth: {
          enabled: false,
          defaultPolicy: 'mailbox',
          channels: [
            { id: 'webui', type: 'direct', priority: 10 },
          ],
        },
      };
      expect(getChannelAuth(config, 'webui')).toBe('mailbox');
    });
  });

  describe('permission config getters', () => {
    it('returns default permission mode when channelAuth disabled', () => {
      const config: FingerConfig = {
        channelAuth: {
          enabled: false,
          defaultPolicy: 'direct',
          channels: [],
        },
      };
      expect(getChannelPermissionMode(config, 'webui')).toBe('default');
      expect(getChannelPermissionWhitelist(config, 'webui')).toEqual([]);
      expect(getChannelPermissionBlacklist(config, 'webui')).toEqual([]);
      expect(getChannelHighRiskCommands(config, 'webui')).toEqual([]);
      expect(getChannelRejectConfig(config, 'webui')).toEqual({
        sandboxEscalation: false,
        policyRules: false,
        skillApproval: false,
        permissionRequest: false,
        mcpElicitation: false,
      });
    });

    it('reads permission config fields from channel config', () => {
      const config: FingerConfig = {
        channelAuth: {
          enabled: true,
          defaultPolicy: 'direct',
          channels: [
            {
              id: 'webui',
              type: 'direct',
              priority: 10,
              permissionMode: 'minimal',
              permissionWhitelist: ['shell.exec'],
              permissionBlacklist: ['file.delete'],
              highRiskCommands: ['rm -rf'],
              rejectConfig: { sandboxEscalation: true, policyRules: true },
            },
          ],
        },
      };
      expect(getChannelPermissionMode(config, 'webui')).toBe('minimal');
      expect(getChannelPermissionWhitelist(config, 'webui')).toEqual(['shell.exec']);
      expect(getChannelPermissionBlacklist(config, 'webui')).toEqual(['file.delete']);
      expect(getChannelHighRiskCommands(config, 'webui')).toEqual(['rm -rf']);
      expect(getChannelRejectConfig(config, 'webui')).toEqual({
        sandboxEscalation: true,
        policyRules: true,
        skillApproval: false,
        permissionRequest: false,
        mcpElicitation: false,
      });
    });
  });

  describe('resolveHomePath', () => {
    it('resolves ~ to home directory', () => {
      expect(resolveHomePath('~/test/path')).toBe(`${path.join(os.homedir(), 'test/path')}`);
    });

    it('handles paths without ~', () => {
      expect(resolveHomePath('/absolute/path')).toBe('/absolute/path');
    });
  });

  describe('resolveDefaultProject', () => {
    it('uses configured project path when available', () => {
      const config: FingerConfig = {
        defaults: {
          projectPath: '~/configured',
          useLastProject: true,
        },
      };
      expect(resolveDefaultProject(config, null)).toBe(`${path.join(os.homedir(), 'configured')}`);
    });

    it('uses last accessed project when configured', async () => {
      const config: FingerConfig = {
        defaults: {
          useLastProject: true,
        },
      };
      expect(resolveDefaultProject(config, '/last/project')).toBe('/last/project');
    });

    it('falls back to ~/.finger when no config or last project', () => {
      const config: FingerConfig = {
        defaults: {
          useLastProject: false,
        },
      };
      expect(resolveDefaultProject(config, null)).toBe(`${path.join(os.homedir(), '.finger')}`);
    });
  });
});
