import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCommands } from '../../../../src/blocks/command-hub/parser.js';
import { CommandExecutor } from '../../../../src/blocks/command-hub/executor.js';
import { CommandType } from '../../../../src/blocks/command-hub/types.js';
import { DisplayHandler } from '../../../../src/blocks/command-hub/handlers/display-handler.js';

describe('CommandHub display command parsing/execution', () => {
  let tempDir: string;
  let configPath: string;
  let channelsPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-command-display-'));
    configPath = path.join(tempDir, 'config.json');
    channelsPath = path.join(tempDir, 'channels.json');
    fs.writeFileSync(configPath, JSON.stringify({ version: '1.0' }, null, 2), 'utf-8');
    fs.writeFileSync(channelsPath, JSON.stringify({
      channels: [
        {
          id: 'qqbot',
          options: {
            pushSettings: {},
            displaySettings: {
              context: 'on',
              heartbeat: true,
            },
          },
        },
      ],
    }, null, 2), 'utf-8');
  });

  it('parses display commands and strips all command tags from effective content', () => {
    const input = [
      '- <##display:"progress:on"##>',
      '- <##display:"ctx:simple"##>',
      '- <##display:"toolcall:on"##>',
    ].join('\n');
    const parsed = parseCommands(input);
    expect(parsed.commands).toHaveLength(3);
    expect(parsed.commands.map((item) => item.type)).toEqual([
      CommandType.DISPLAY,
      CommandType.DISPLAY,
      CommandType.DISPLAY,
    ]);
    expect(parsed.commands.map((item) => item.params.spec)).toEqual([
      'progress:on',
      'ctx:simple',
      'toolcall:on',
    ]);
    expect(parsed.effectiveContent).not.toContain('<##');
  });

  it('executes display command through command hub handler', async () => {
    const executor = new CommandExecutor();
    executor.registerHandler(CommandType.DISPLAY, new DisplayHandler());

    const parsed = parseCommands('<##display:"ctx:simple"##>');
    const cmd = parsed.commands[0];
    const upsertConfigs = vi.fn();
    const result = await executor.execute(cmd, {
      channelId: 'qqbot',
      configPath,
      channelBridgeManager: { upsertConfigs } as any,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('display 设置已更新');
    expect(upsertConfigs).toHaveBeenCalledTimes(1);

    const saved = JSON.parse(fs.readFileSync(channelsPath, 'utf-8'));
    expect(saved.channels[0].options.displaySettings.context).toBe('simple');
  });
});

