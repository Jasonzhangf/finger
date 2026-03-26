/**
 * Finger Init Command - 首次启动引导配置渠道
 *
 * Usage: finger init
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { createInterface } from 'readline';
import { logger } from '../core/logger.js';

const log = logger.module('init');

const FINGER_CONFIG_DIR = path.join(os.homedir(), '.finger');
const FINGER_CHANNELS_CONFIG = path.join(FINGER_CONFIG_DIR, 'config', 'channels.json');

const DEFAULT_CONFIG: any = {
  enabledInDaemon: true,
  pluginsPath: ['~/.openclaw/extensions'],
  channels: [],
};

const CHANNEL_CHOICES = [
  { name: 'QQBot', value: 'qqbot' },
  { name: 'Weixin (openclaw-weixin)', value: 'openclaw-weixin' },
  { name: 'Skip (configure later)', value: 'skip' },
];

function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

export async function runInit(): Promise<void> {
  console.log('\n  finger init\n');

  if (!fs.existsSync(FINGER_CONFIG_DIR)) {
    fs.mkdirSync(FINGER_CONFIG_DIR, { recursive: true });
    log.info(`Created config dir: ${FINGER_CONFIG_DIR}`);
  }

  // 已有配置文件则跳过
  if (fs.existsSync(FINGER_CHANNELS_CONFIG)) {
    const raw = JSON.parse(fs.readFileSync(FINGER_CHANNELS_CONFIG, 'utf-8'));
    const count = Array.isArray(raw.channels) ? raw.channels.length : 0;
    console.log(`  channels.json already exists (${count} channel configured)`);
    return;
  }

  console.log('  ! No channels.json found');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('');
  console.log('Select channel to configure:');
  CHANNEL_CHOICES.forEach((c, i) => console.log(`  ${i + 1}. ${c.name}`));
  console.log('');

  const idx = parseInt(await question(rl, 'Choice (1-3): '), 10) - 1;
  if (idx < 0 || idx >= CHANNEL_CHOICES.length) {
    console.log('  Skipped. Run: finger channel-setup --channel <id>');
    rl.close();
    return;
  }

  const channel = CHANNEL_CHOICES[idx].value;
  const channelConfig: any = { ...DEFAULT_CONFIG, channels: [] };

  if (channel === 'qqbot') {
    console.log('');
    console.log('  [QQBot]');
    console.log('  Visit https://q.qq.com to create a bot app');
    console.log('');

    const appId = await question(rl, 'AppID: ');
    const clientSecret = await question(rl, 'Client Secret: ');

    channelConfig.channels.push({
      id: 'qqbot',
      channelId: 'qqbot',
      type: 'openclaw-plugin',
      enabled: true,
      credentials: { accountId: 'default', appId, clientSecret },
      options: {
        permissions: { send: true, receive: true, control: true },
        pushSettings: { reasoning: true, statusUpdate: true, stepUpdates: true, progressUpdates: true },
      },
    });
  } else if (channel === 'openclaw-weixin') {
    console.log('');
    console.log('  [Weixin]');
    console.log('  1. openclaw plugins install "@tencent-weixin/openclaw-weixin"');
    console.log('  2. openclaw channels login --channel openclaw-weixin');

    channelConfig.channels.push({
      id: 'openclaw-weixin',
      channelId: 'openclaw-weixin',
      type: 'openclaw-plugin',
      enabled: true,
      credentials: { accountId: 'default' },
      options: {
        permissions: { send: true, receive: true, control: true },
        pushSettings: { reasoning: true, statusUpdate: true, stepUpdates: true, progressUpdates: true },
      },
    });
  }

  fs.writeFileSync(FINGER_CHANNELS_CONFIG, JSON.stringify(channelConfig, null, 2));
  console.log(`  Saved to ${FINGER_CHANNELS_CONFIG}`);

  const start = await question(rl, 'Start daemon now? (Y/n): ');
  rl.close();

  if (start.toLowerCase() === 'y') {
    console.log('');
    console.log('  Starting daemon...');
    try {
      execSync('finger daemon start', { stdio: 'inherit' });
    } catch {
      console.log('  Failed to start. Run: finger daemon start');
    }
  }

  console.log('');
  console.log('  Done! Run "finger chat" to start');
}

export function registerInitCommand(program: any): void {
  program
    .command('init')
    .description('Initialize Finger configuration (first-run wizard)')
    .action(async () => {
      await runInit();
    });
}
