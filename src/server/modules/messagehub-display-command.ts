import type { ChannelBridgeManager } from '../../bridges/manager.js';
import * as fs from 'fs';
import * as path from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';

type DisplaySettingKey = 'ctx' | 'toolcall' | 'progress' | 'heartbeat';
type ContextDisplayMode = 'on' | 'off' | 'simple' | 'verbose';
type ExtendedDisplaySettingKey =
  | DisplaySettingKey
  | 'reasoning'
  | 'body'
  | 'status'
  | 'step'
  | 'stepbatch'
  | 'mode'
  | 'show';

function normalizeDisplayTargetChannel(channelId: string): string {
  const normalized = (channelId || '').trim().toLowerCase();
  if (normalized === 'weixin') return 'openclaw-weixin';
  return normalized;
}

function parseDisplaySpec(specRaw: string): {
  ok: boolean;
  key?: ExtendedDisplaySettingKey;
  value?: string;
  error?: string;
} {
  const spec = specRaw.trim().toLowerCase();
  if (spec === 'show' || spec === 'list' || spec === 'status') {
    return {
      ok: true,
      key: 'show',
      value: '',
    };
  }
  const separatorIndex = spec.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= spec.length - 1) {
    return {
      ok: false,
      error: '格式错误。请使用例如 <##display:"ctx:simple"##> 或 <##display:"show"##>',
    };
  }
  const keyRaw = spec.slice(0, separatorIndex).trim();
  const valueRaw = spec.slice(separatorIndex + 1).trim();

  const key: ExtendedDisplaySettingKey | undefined = keyRaw === 'ctx'
    ? 'ctx'
    : keyRaw === 'toolcall'
      ? 'toolcall'
    : keyRaw === 'progress'
      ? 'progress'
    : keyRaw === 'heartbeat' || keyRaw === 'hearbeat'
      ? 'heartbeat'
    : keyRaw === 'reasoning'
      ? 'reasoning'
    : keyRaw === 'body'
      ? 'body'
    : keyRaw === 'status'
      ? 'status'
    : keyRaw === 'step'
      ? 'step'
    : keyRaw === 'stepbatch' || keyRaw === 'step_batch'
      ? 'stepbatch'
    : keyRaw === 'mode' || keyRaw === 'updatemode' || keyRaw === 'update_mode'
      ? 'mode'
          : undefined;
  if (!key) {
    return {
      ok: false,
      error: `不支持的 display key：${keyRaw}（支持 ctx/toolcall/progress/heartbeat/reasoning/body/status/step/stepbatch/mode/show）`,
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

function normalizeUpdateMode(raw: string): 'progress' | 'command' | 'both' | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'progress' || normalized === 'command' || normalized === 'both') return normalized;
  return null;
}

function normalizeStepBatch(raw: string): number | null {
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  if (normalized < 1 || normalized > 50) return null;
  return normalized;
}

function summarizeChannelDisplaySettings(channel: Record<string, unknown>): string {
  const options = ensureChannelOptions(channel);
  const pushSettings = ensurePushSettings(options);
  const displaySettings = ensureDisplaySettings(options);
  const contextModeRaw = typeof displaySettings.context === 'string' ? displaySettings.context : 'on';
  const contextMode = normalizeContextDisplayMode(contextModeRaw) ?? 'on';
  const updateModeRaw = typeof pushSettings.updateMode === 'string' ? pushSettings.updateMode : 'progress';
  const updateMode = normalizeUpdateMode(updateModeRaw) ?? 'progress';
  const reasoning = pushSettings.reasoning === true ? 'on' : 'off';
  const body = pushSettings.bodyUpdates === false ? 'off' : 'on';
  const status = pushSettings.statusUpdate === false ? 'off' : 'on';
  const toolCalls = pushSettings.toolCalls === false ? 'off' : 'on';
  const step = pushSettings.stepUpdates === false ? 'off' : 'on';
  const stepBatchRaw = typeof pushSettings.stepBatch === 'number' ? pushSettings.stepBatch : 5;
  const stepBatch = Number.isFinite(stepBatchRaw) && stepBatchRaw > 0 ? Math.floor(stepBatchRaw) : 5;
  const progress = pushSettings.progressUpdates === false ? 'off' : 'on';
  const heartbeat = displaySettings.heartbeat === false ? 'off' : 'on';
  return [
    `ctx=${contextMode}`,
    `mode=${updateMode}`,
    `reasoning=${reasoning}`,
    `body=${body}`,
    `status=${status}`,
    `toolcall=${toolCalls}`,
    `step=${step}`,
    `stepbatch=${stepBatch}`,
    `progress=${progress}`,
    `heartbeat=${heartbeat}`,
  ].join(' · ');
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
  if (!parsed.ok || !parsed.key) {
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

  if (parsed.key === 'show') {
    const effectiveChannelLabel = targetChannel === 'openclaw-weixin' ? 'weixin(openclaw-weixin)' : targetChannel;
    return `✓ 当前 display 设置\n渠道：${effectiveChannelLabel}\n当前：${summarizeChannelDisplaySettings(target)}`;
  }

  if (!parsed.value) {
    return '❌ display 命令缺少 value';
  }

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
  } else if (parsed.key === 'reasoning') {
    const toggle = normalizeOnOff(parsed.value);
    if (toggle === null) return '❌ reasoning 仅支持 on/off';
    pushSettings.reasoning = toggle;
  } else if (parsed.key === 'body') {
    const toggle = normalizeOnOff(parsed.value);
    if (toggle === null) return '❌ body 仅支持 on/off';
    pushSettings.bodyUpdates = toggle;
  } else if (parsed.key === 'status') {
    const toggle = normalizeOnOff(parsed.value);
    if (toggle === null) return '❌ status 仅支持 on/off';
    pushSettings.statusUpdate = toggle;
  } else if (parsed.key === 'step') {
    const toggle = normalizeOnOff(parsed.value);
    if (toggle === null) return '❌ step 仅支持 on/off';
    pushSettings.stepUpdates = toggle;
  } else if (parsed.key === 'stepbatch') {
    const stepBatch = normalizeStepBatch(parsed.value);
    if (stepBatch === null) return '❌ stepbatch 仅支持 1-50 的整数';
    pushSettings.stepBatch = stepBatch;
  } else if (parsed.key === 'mode') {
    const mode = normalizeUpdateMode(parsed.value);
    if (!mode) return '❌ mode 仅支持 progress/command/both';
    pushSettings.updateMode = mode;
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
