import type { ChannelBridgeManager } from '../../bridges/manager.js';
import * as fs from 'fs';
import * as path from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';

type DisplaySettingKey = 'ctx' | 'toolcall' | 'progress' | 'heartbeat';
type ContextDisplayMode = 'on' | 'off' | 'simple' | 'verbose';

function normalizeDisplayTargetChannel(channelId: string): string {
  const normalized = (channelId || '').trim().toLowerCase();
  if (normalized === 'weixin') return 'openclaw-weixin';
  return normalized;
}

function parseDisplaySpec(specRaw: string): {
  ok: boolean;
  key?: DisplaySettingKey;
  value?: string;
  error?: string;
} {
  const spec = specRaw.trim().toLowerCase();
  const separatorIndex = spec.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= spec.length - 1) {
    return {
      ok: false,
      error: '格式错误。请使用例如 <##display:"ctx:simple"##>',
    };
  }
  const keyRaw = spec.slice(0, separatorIndex).trim();
  const valueRaw = spec.slice(separatorIndex + 1).trim();

  const key: DisplaySettingKey | undefined = keyRaw === 'ctx'
    ? 'ctx'
    : keyRaw === 'toolcall'
      ? 'toolcall'
      : keyRaw === 'progress'
        ? 'progress'
        : keyRaw === 'heartbeat' || keyRaw === 'hearbeat'
          ? 'heartbeat'
          : undefined;
  if (!key) {
    return {
      ok: false,
      error: `不支持的 display key：${keyRaw}（支持 ctx/toolcall/progress/heartbeat）`,
    };
  }
  return {
    ok: true,
    key,
    value: valueRaw,
  };
}

function ensureChannelsConfigStructure(raw: unknown): { channels: Array<Record<string, unknown>>; root: Record<string, unknown> } {
  const root = (typeof raw === 'object' && raw !== null) ? raw as Record<string, unknown> : {};
  const channels = Array.isArray(root.channels) ? root.channels as Array<Record<string, unknown>> : [];
  return { channels, root };
}

function ensureChannelOptions(channel: Record<string, unknown>): Record<string, unknown> {
  const options = (typeof channel.options === 'object' && channel.options !== null)
    ? channel.options as Record<string, unknown>
    : {};
  channel.options = options;
  return options;
}

function ensurePushSettings(options: Record<string, unknown>): Record<string, unknown> {
  const pushSettings = (typeof options.pushSettings === 'object' && options.pushSettings !== null)
    ? options.pushSettings as Record<string, unknown>
    : {};
  options.pushSettings = pushSettings;
  return pushSettings;
}

function ensureDisplaySettings(options: Record<string, unknown>): Record<string, unknown> {
  const displaySettings = (typeof options.displaySettings === 'object' && options.displaySettings !== null)
    ? options.displaySettings as Record<string, unknown>
    : {};
  options.displaySettings = displaySettings;
  return displaySettings;
}

function normalizeContextDisplayMode(raw: string): ContextDisplayMode | null {
  const mode = raw.trim().toLowerCase();
  if (mode === 'on' || mode === 'off' || mode === 'simple' || mode === 'verbose') {
    return mode;
  }
  return null;
}

function normalizeOnOff(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'on') return true;
  if (normalized === 'off') return false;
  return null;
}

function summarizeChannelDisplaySettings(channel: Record<string, unknown>): string {
  const options = ensureChannelOptions(channel);
  const pushSettings = ensurePushSettings(options);
  const displaySettings = ensureDisplaySettings(options);
  const contextModeRaw = typeof displaySettings.context === 'string' ? displaySettings.context : 'on';
  const contextMode = normalizeContextDisplayMode(contextModeRaw) ?? 'on';
  const toolCalls = pushSettings.toolCalls === false ? 'off' : 'on';
  const progress = pushSettings.progressUpdates === false ? 'off' : 'on';
  const heartbeat = displaySettings.heartbeat === false ? 'off' : 'on';
  return `ctx=${contextMode} · toolcall=${toolCalls} · progress=${progress} · heartbeat=${heartbeat}`;
}

export async function handleDisplayCommand(
  channelId: string,
  specRaw: string,
  channelBridgeManager?: ChannelBridgeManager,
  options?: { configDir?: string },
): Promise<string> {
  const targetChannel = normalizeDisplayTargetChannel(channelId);
  if (targetChannel !== 'qqbot' && targetChannel !== 'openclaw-weixin') {
    return `❌ 仅支持 qqbot/weixin 渠道。当前渠道：${channelId || '(unknown)'}`;
  }

  const parsed = parseDisplaySpec(specRaw);
  if (!parsed.ok || !parsed.key || !parsed.value) {
    return `❌ ${parsed.error ?? 'display 命令解析失败'}`;
  }

  const configDir = options?.configDir ?? FINGER_PATHS.config.dir;
  const channelsConfigPath = path.join(configDir, 'channels.json');
  if (!fs.existsSync(channelsConfigPath)) {
    return `❌ 渠道配置不存在：${channelsConfigPath}`;
  }

  let rawConfig: Record<string, unknown>;
  try {
    rawConfig = JSON.parse(fs.readFileSync(channelsConfigPath, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    return `❌ 读取配置失败：${error instanceof Error ? error.message : String(error)}`;
  }

  const { root, channels } = ensureChannelsConfigStructure(rawConfig);
  const target = channels.find((item) => {
    const id = typeof item.id === 'string' ? item.id.trim().toLowerCase() : '';
    const itemChannelId = typeof item.channelId === 'string' ? item.channelId.trim().toLowerCase() : '';
    return id === targetChannel || itemChannelId === targetChannel;
  });
  if (!target) {
    return `❌ 未找到渠道配置：${targetChannel}`;
  }

  const channelOptions = ensureChannelOptions(target);
  const pushSettings = ensurePushSettings(channelOptions);
  const displaySettings = ensureDisplaySettings(channelOptions);

  if (parsed.key === 'ctx') {
    const contextMode = normalizeContextDisplayMode(parsed.value);
    if (!contextMode) {
      return '❌ ctx 仅支持 on/off/simple/verbose';
    }
    displaySettings.context = contextMode;
  } else if (parsed.key === 'toolcall') {
    const toggle = normalizeOnOff(parsed.value);
    if (toggle === null) return '❌ toolcall 仅支持 on/off';
    pushSettings.toolCalls = toggle;
  } else if (parsed.key === 'progress') {
    const toggle = normalizeOnOff(parsed.value);
    if (toggle === null) return '❌ progress 仅支持 on/off';
    pushSettings.progressUpdates = toggle;
  } else if (parsed.key === 'heartbeat') {
    const toggle = normalizeOnOff(parsed.value);
    if (toggle === null) return '❌ heartbeat 仅支持 on/off';
    displaySettings.heartbeat = toggle;
  }

  root.channels = channels;
  try {
    fs.mkdirSync(path.dirname(channelsConfigPath), { recursive: true });
    fs.writeFileSync(channelsConfigPath, JSON.stringify(root, null, 2), 'utf-8');
    if (channelBridgeManager) {
      channelBridgeManager.upsertConfigs(channels as any[]);
    }
  } catch (error) {
    return `❌ 写入配置失败：${error instanceof Error ? error.message : String(error)}`;
  }

  const effectiveChannelLabel = targetChannel === 'openclaw-weixin' ? 'weixin(openclaw-weixin)' : targetChannel;
  return `✓ display 设置已更新（即时生效）\n渠道：${effectiveChannelLabel}\n当前：${summarizeChannelDisplaySettings(target)}`;
}
