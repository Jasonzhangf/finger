import { logger } from '../../core/logger.js';
import * as fs from 'fs';
import * as path from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { loadUserSettings, saveUserSettings, type AIProvider } from '../../core/user-settings.js';

function loadProviderConfig(): { providers: Record<string, AIProvider>; current: string | null } {
  try {
    const settings = loadUserSettings();
    return {
      providers: settings.aiProviders.providers || {},
      current: settings.aiProviders.default || null,
    };
  } catch (err) {
    logger.module('messagehub-command-handler').warn('Failed to load provider config from user settings; fallback to empty providers', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { providers: {}, current: null };
  }
}

function saveProviderConfig(providerId: string): boolean {
  try {
    const settings = loadUserSettings();
    if (!settings.aiProviders.providers?.[providerId]) {
      return false;
    }
    settings.aiProviders.default = providerId;
    settings.updated_at = new Date().toISOString();
    saveUserSettings(settings);
    return true;
  } catch (err) {
    logger.module('messagehub-command-handler').error('Failed to save provider config', err instanceof Error ? err : undefined);
    return false;
  }
}

export async function handleSystemProgressMode(modeRaw: string): Promise<string> {
  const mode = modeRaw.trim().toLowerCase();
  if (mode !== 'dev' && mode !== 'release') {
    return '❌ 无效模式。请使用：<##@system:progress:mode@dev##> 或 <##@system:progress:mode@release##>';
  }

  const configPath = path.join(FINGER_PATHS.config.dir, 'progress-monitor.json');
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      existing = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
    }
    const next = {
      ...existing,
      contextBreakdownMode: mode,
    };
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf-8');
    return mode === 'dev'
      ? '✓ 已切换进度上下文模式为 DEV（详细分解）'
      : '✓ 已切换进度上下文模式为 RELEASE（精简视图）';
  } catch (error) {
    return `❌ 设置失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function handleProviderList(): Promise<string> {
  const { providers, current } = loadProviderConfig();
  const lines = ['可用 AI Provider：\n'];

  Object.entries(providers).forEach(([id, cfg]: [string, any]) => {
    const isCurrent = id === current;
    const marker = isCurrent ? ' [当前]' : '';
    const baseUrl = cfg?.base_url || 'unknown';
    const model = cfg?.model || 'unknown';
    lines.push(`  - ${id}${marker}: ${model} @ ${baseUrl}`);
  });

  lines.push('\n使用 <##@system:provider:switch@id##> 切换 provider');
  return lines.join('\n');
}

export async function handleProviderSwitch(providerId: string): Promise<string> {
  const { providers } = loadProviderConfig();

  if (!providers[providerId]) {
    return `❌ Provider 不存在：${providerId}\n\n使用 <##@system:provider:list##> 查看可用 providers`;
  }

  const success = saveProviderConfig(providerId);
  if (!success) {
    return '❌ 切换失败：无法保存配置';
  }

  const cfg = providers[providerId];
  return `✓ 已切换到 provider：${providerId}\n  Model: ${cfg?.model || 'unknown'}\n  URL: ${cfg?.base_url || 'unknown'}\n\n重启 agent 后生效`;
}
