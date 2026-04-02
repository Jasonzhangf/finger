import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleDisplayCommand } from '../../../src/server/modules/messagehub-command-handler.js';

describe('messagehub display command', () => {
  function createTempConfig() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-display-cmd-'));
    const configDir = path.join(dir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const channelsPath = path.join(configDir, 'channels.json');
    fs.writeFileSync(channelsPath, JSON.stringify({
      channels: [
        {
          id: 'qqbot',
          channelId: 'qqbot',
          enabled: true,
          options: {
            pushSettings: {
              statusUpdate: true,
              toolCalls: false,
              progressUpdates: true,
            },
          },
        },
        {
          id: 'openclaw-weixin',
          channelId: 'openclaw-weixin',
          enabled: true,
          options: {
            pushSettings: {
              statusUpdate: true,
              toolCalls: false,
              progressUpdates: true,
            },
          },
        },
      ],
    }, null, 2));
    return { dir, configDir, channelsPath };
  }

  it('updates ctx display mode and hot-upserts channel config', async () => {
    const { configDir, channelsPath } = createTempConfig();
    const channelBridgeManager = {
      upsertConfigs: vi.fn(),
    } as any;

    const result = await handleDisplayCommand('qqbot', 'ctx:verbose', channelBridgeManager, { configDir });
    expect(result).toContain('即时生效');
    expect(result).toContain('ctx=verbose');

    const next = JSON.parse(fs.readFileSync(channelsPath, 'utf-8')) as any;
    expect(next.channels[0].options.displaySettings.context).toBe('verbose');
    expect(channelBridgeManager.upsertConfigs).toHaveBeenCalledTimes(1);
  });

  it('supports weixin alias + hearbeat typo and toggles heartbeat off', async () => {
    const { configDir, channelsPath } = createTempConfig();

    const result = await handleDisplayCommand('weixin', 'hearbeat:off', undefined, { configDir });
    expect(result).toContain('heartbeat=off');

    const next = JSON.parse(fs.readFileSync(channelsPath, 'utf-8')) as any;
    expect(next.channels[1].options.displaySettings.heartbeat).toBe(false);
  });

  it('updates toolcall/progress toggles in pushSettings', async () => {
    const { configDir, channelsPath } = createTempConfig();

    await handleDisplayCommand('qqbot', 'toolcall:on', undefined, { configDir });
    await handleDisplayCommand('qqbot', 'progress:off', undefined, { configDir });

    const next = JSON.parse(fs.readFileSync(channelsPath, 'utf-8')) as any;
    expect(next.channels[0].options.pushSettings.toolCalls).toBe(true);
    expect(next.channels[0].options.pushSettings.progressUpdates).toBe(false);
  });

  it('rejects unsupported channels', async () => {
    const { configDir } = createTempConfig();
    const result = await handleDisplayCommand('webui', 'ctx:on', undefined, { configDir });
    expect(result).toContain('仅支持 qqbot/weixin');
  });
});
