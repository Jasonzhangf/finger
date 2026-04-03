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

  it('updates full push display fields and supports show command', async () => {
    const { configDir, channelsPath } = createTempConfig();

    await handleDisplayCommand('qqbot', 'mode:both', undefined, { configDir });
    await handleDisplayCommand('qqbot', 'reasoning:on', undefined, { configDir });
    await handleDisplayCommand('qqbot', 'body:off', undefined, { configDir });
    await handleDisplayCommand('qqbot', 'status:off', undefined, { configDir });
    await handleDisplayCommand('qqbot', 'step:off', undefined, { configDir });
    await handleDisplayCommand('qqbot', 'stepbatch:9', undefined, { configDir });
    const show = await handleDisplayCommand('qqbot', 'show', undefined, { configDir });

    const next = JSON.parse(fs.readFileSync(channelsPath, 'utf-8')) as any;
    expect(next.channels[0].options.pushSettings.updateMode).toBe('both');
    expect(next.channels[0].options.pushSettings.reasoning).toBe(true);
    expect(next.channels[0].options.pushSettings.bodyUpdates).toBe(false);
    expect(next.channels[0].options.pushSettings.statusUpdate).toBe(false);
    expect(next.channels[0].options.pushSettings.stepUpdates).toBe(false);
    expect(next.channels[0].options.pushSettings.stepBatch).toBe(9);

    expect(show).toContain('当前 display 设置');
    expect(show).toContain('mode=both');
    expect(show).toContain('reasoning=on');
    expect(show).toContain('body=off');
    expect(show).toContain('status=off');
    expect(show).toContain('step=off');
    expect(show).toContain('stepbatch=9');
  });

  it('rejects invalid stepbatch value', async () => {
    const { configDir } = createTempConfig();
    const result = await handleDisplayCommand('qqbot', 'stepbatch:0', undefined, { configDir });
    expect(result).toContain('stepbatch 仅支持 1-50 的整数');
  });

  it('rejects unsupported channels', async () => {
    const { configDir } = createTempConfig();
    const result = await handleDisplayCommand('webui', 'ctx:on', undefined, { configDir });
    expect(result).toContain('仅支持 qqbot/weixin');
  });
});
