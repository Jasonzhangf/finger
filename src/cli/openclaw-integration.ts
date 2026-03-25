import { Command } from 'commander';
import os from 'os';
import path from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';

const clog = createConsoleLikeLogger('OpenClawIntegrationCLI');

const OPENCLAW_EXT_DIR = path.join(os.homedir(), '.openclaw', 'extensions');
const FINGER_CHANNELS_CONFIG = path.join(os.homedir(), '.finger', 'config', 'channels.json');

interface OpenClawPluginManifest {
  id?: string;
  name?: string;
  channels?: string[];
  capabilities?: Record<string, unknown>;
  configSchema?: Record<string, unknown>;
}

interface ChannelsConfig {
  enabledInDaemon?: boolean;
  channels?: Array<Record<string, unknown>>;
  pluginsPath?: string[];
}

function loadChannelsConfig(): ChannelsConfig {
  if (!existsSync(FINGER_CHANNELS_CONFIG)) {
    return { enabledInDaemon: true, channels: [], pluginsPath: ['~/.openclaw/extensions'] };
  }
  try {
    return JSON.parse(readFileSync(FINGER_CHANNELS_CONFIG, 'utf-8')) as ChannelsConfig;
  } catch {
    return { enabledInDaemon: true, channels: [], pluginsPath: ['~/.openclaw/extensions'] };
  }
}

function saveChannelsConfig(config: ChannelsConfig): void {
  const configDir = path.dirname(FINGER_CHANNELS_CONFIG);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  writeFileSync(FINGER_CHANNELS_CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function discoverOpenClawPlugins(): Array<{ pluginPath: string; manifestPath: string; manifest: OpenClawPluginManifest }> {
  if (!existsSync(OPENCLAW_EXT_DIR)) {
    return [];
  }

  const plugins: Array<{ pluginPath: string; manifestPath: string; manifest: OpenClawPluginManifest }> = [];
  for (const name of readdirSync(OPENCLAW_EXT_DIR)) {
    const pluginPath = path.join(OPENCLAW_EXT_DIR, name);
    const manifestPath = path.join(pluginPath, 'openclaw.plugin.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as OpenClawPluginManifest;
      plugins.push({ pluginPath, manifestPath, manifest });
    } catch {
      // ignore malformed manifest
    }
  }
  return plugins;
}

function normalizePluginsPath(config: ChannelsConfig): void {
  if (!Array.isArray(config.pluginsPath)) config.pluginsPath = [];
  if (!config.pluginsPath.includes('~/.openclaw/extensions')) {
    config.pluginsPath.push('~/.openclaw/extensions');
  }
}

function buildDefaultPushSettings(channelId: string): Record<string, unknown> {
  // webui wants richer details; text channels default to concise mode
  if (channelId === 'webui') {
    return {
      updateMode: 'progress',
      reasoning: true,
      bodyUpdates: true,
      statusUpdate: true,
      toolCalls: true,
      stepUpdates: true,
      stepBatch: 5,
      progressUpdates: true,
    };
  }
  return {
    updateMode: 'progress',
    reasoning: true,
    bodyUpdates: true,
    statusUpdate: true,
    toolCalls: false,
    stepUpdates: true,
    stepBatch: 5,
    progressUpdates: true,
  };
}

function upsertOpenClawPluginChannel(
  config: ChannelsConfig,
  channelId: string,
  credentials: Record<string, unknown>,
): void {
  config.enabledInDaemon = true;
  normalizePluginsPath(config);

  if (!Array.isArray(config.channels)) config.channels = [];

  const existing = config.channels.find((c) => c.id === channelId || c.channelId === channelId);
  const existingOptions = (existing?.options as Record<string, unknown> | undefined) ?? {};
  const existingPermissions = (existingOptions.permissions as Record<string, unknown> | undefined) ?? {};
  const existingPush = (existingOptions.pushSettings as Record<string, unknown> | undefined) ?? {};

  const entry: Record<string, unknown> = {
    id: channelId,
    channelId,
    type: 'openclaw-plugin',
    enabled: true,
    credentials,
    options: {
      permissions: {
        send: existingPermissions.send ?? true,
        receive: existingPermissions.receive ?? true,
        control: existingPermissions.control ?? true,
      },
      pushSettings: {
        ...buildDefaultPushSettings(channelId),
        ...existingPush,
      },
    },
  };

  const idx = config.channels.findIndex((c) => c.id === channelId || c.channelId === channelId);
  if (idx >= 0) {
    config.channels[idx] = entry;
  } else {
    config.channels.push(entry);
  }
}

export function registerOpenClawIntegrationCommand(program: Command): void {
  const openclaw = program
    .command('openclaw')
    .description('OpenClaw plugin integration helpers for Finger');

  openclaw
    .command('discover')
    .description('Discover standard OpenClaw plugins from ~/.openclaw/extensions')
    .action(() => {
      const plugins = discoverOpenClawPlugins();
      if (plugins.length === 0) {
        clog.log('No OpenClaw plugins found under ~/.openclaw/extensions');
        return;
      }
      clog.log(`Discovered ${plugins.length} OpenClaw plugin(s):`);
      for (const p of plugins) {
        const id = p.manifest.id || path.basename(p.pluginPath);
        const channels = Array.isArray(p.manifest.channels) ? p.manifest.channels.join(', ') : 'none';
        clog.log(`- ${id}`);
        clog.log(`  path: ${p.pluginPath}`);
        clog.log(`  channels: ${channels}`);
      }
    });

  openclaw
    .command('channel-setup')
    .description('Write/update channel config in ~/.finger/config/channels.json for an installed OpenClaw plugin channel')
    .requiredOption('--channel <id>', 'Channel ID, e.g. qqbot or openclaw-weixin')
    .option('--appid <id>', 'QQ-like channel appid (optional, channel-specific)')
    .option('--token <token>', 'QQ-like channel token (optional, channel-specific)')
    .option('--account-id <id>', 'Optional account id for plugin channels')
    .action((opts: { channel: string; appid?: string; token?: string; accountId?: string }) => {
      const config = loadChannelsConfig();

      const credentials: Record<string, unknown> = {};
      if (opts.appid) credentials.appId = opts.appid;
      if (opts.token) credentials.clientSecret = opts.token;
      if (opts.accountId) credentials.accountId = opts.accountId;

      upsertOpenClawPluginChannel(config, opts.channel, credentials);
      saveChannelsConfig(config);

      clog.log(`Updated ${FINGER_CHANNELS_CONFIG} for channel: ${opts.channel}`);
      clog.log('Binding policy is now channel type + config file (channels.json).');
      clog.log('Next step: run "npm run daemon:restart" to reload channel config.');
    });
}
