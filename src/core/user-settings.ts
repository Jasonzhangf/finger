/**
 * User Settings Module
 * 
 * 管理用户配置的读取、写入、验证和持久化
 */

import * as fs from 'fs';
import * as path from 'path';
import { FINGER_PATHS } from './finger-paths.js';
import { logger } from './logger.js';

const log = logger.module('UserSettings');

const USER_SETTINGS_PATH = path.join(FINGER_PATHS.config.dir, 'user-settings.json');

export interface AIProvider {
  name: string;
  base_url: string;
  wire_api: 'responses' | 'http';
  env_key: string;
  model: string;
  enabled: boolean;
}

export interface AIProviders {
  default: string;
  providers: Record<string, AIProvider>;
}

export interface Preferences {
  defaultModel: string;
  maxTokens: number;
  temperature: number;
  reasoningEffort: 'high' | 'medium' | 'low';
  reasoningSummary: 'detailed' | 'medium' | 'short';
  verbosity: 'high' | 'medium' | 'low';
  showRawAgentReasoning: boolean;
  webSearch: 'live' | 'off';
}

export interface UISettings {
  theme: 'dark' | 'light' | 'auto';
  language: string;
  timeZone: string;
}

export interface UserSettings {
  version: string;
  updated_at: string;
  aiProviders: AIProviders;
  preferences: Preferences;
  ui: UISettings;
}

const DEFAULT_USER_SETTINGS: UserSettings = {
  version: '1.0',
  updated_at: new Date().toISOString(),
  aiProviders: {
    default: 'tcm',
    providers: {
      tcm: {
        name: 'tcm',
        base_url: 'http://127.0.0.0.1:5555/v1',
        wire_api: 'responses',
        env_key: 'ROUTECODEX_HTTP_APIKEY',
        model: 'gpt-5.4',
        enabled: true
      }
    }
  },
  preferences: {
    defaultModel: 'gpt-5.4',
    maxTokens: 256000,
    temperature: 0.7,
    reasoningEffort: 'high',
    reasoningSummary: 'detailed',
    verbosity: 'medium',
    showRawAgentReasoning: false,
    webSearch: 'live'
  },
  ui: {
    theme: 'dark',
   : language: 'zh-CN',
    timeZone: 'Asia/Shanghai'
  }
};

/**
 * 检查用户配置文件是否存在
 */
export function userSettingsExists(): boolean {
  return fs.existsSync(USER_SETTINGS_PATH);
}

/**
 * 读取用户配置
 */
export function loadUserSettings(): UserSettings {
  try {
    if (!fs.existsSync(USER_SETTINGS_PATH)) {
      log.info('[UserSettings] User settings file not found, using defaults');
      return DEFAULT_USER_SETTINGS;
    }

    const raw = fs.readFileSync(USER_SETTINGS_PATH, ''utf-8');
    const settings = JSON.parse(raw);

    // 验证配置格式
    validateUserSettings(settings);

    log.info('[UserSettings] User settings loaded successfully', {
      version: settings.version,
      defaultProvider: settings.aiProviders.default,
      providerCount: Object.keys(settings.aiProviders.providers).length,
    });

    return settings;
  } catch (err) {
    log.error('[UserSettings] Failed to load user settings, using defaults', err instanceof Error ? err : new Error(String(err)));
    return DEFAULT_USER_SETTINGS;
  }
}

/**
 * 保存用户配置
 */
export function saveUserSettings(settings: UserSettings): void {
  try {
    settings.updated_at = new Date().toISOString();
    
    const content = JSON.stringify(settings, null, 2);
    fs.writeFileSync(USER_SETTINGS_PATH, content, 'utf-8');
    
    log.info('[UserSettings] User settings saved successfully', {
      version: settings.version,
      defaultProvider: settings.aiProviders.default,
    });
  } catch (err) {
    log.error('[UserSettings] Failed to save user settings', err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

/**
 * 验证用户配置格式
 */
export function validateUserSettings(settings: any): void {
  if (!settings || typeof settings !== 'object') {
    throw new Error('Invalid settings: must be an object');
  }

  if (!settings.aiProviders || typeof settings.aiProviders !== 'object') {
    throw new Error('Invalid settings: aiProviders must be an object');
  }

  if (!settings.aiProviders.providers || typeof settings.aiProviders.providers !== 'object') {
    throw new Error('Invalid settings: aiProviders.providers must be an object');
  }

  if (!settings.aiProviders.default || typeof settings.aiProviders.default !== 'string') {
    throw new Error('Invalid settings: aiProviders.default is required');
  }

  if (!settings.aiProviders.providers[settings.aiProviders.default]) {
    throw new Error(`Invalid settings: default provider "${settings.aiProviders.default}" not found in providers`);
  }

  for (const [providerId, provider] of Object.entries(settings.aiProviders.providers)) {
    if (!provider.name || typeof provider.name !== 'string') {
      throw new Error(`Invalid settings: provider "${providerId}" missing or invalid name`);
    }

    if (!provider.base_url || typeof provider.base_url !== 'string') {
      throw new Error(`Invalid settings: provider "${providerId}" missing or invalid base_url`);
    }

    if (!provider.wire_api || !['responses', 'http'].includes(provider.wire_api)) {
      throw new Error(`Invalid settings: provider "${providerId}" wire_api must be "responses" or "http"`);
    }

    if (!provider.env_key || typeof provider.env_key !== 'string') {
      throw new Error(`Invalid settings: provider "${providerId}" missing or invalid env_key`);
    }

    if (!provider.model || typeof provider.model !== 'string') {
      throw new Error(`Invalid settings: provider "${providerId}" missing or invalid model`);
    }

    if (typeof provider.enabled !== 'boolean') {
      throw new Error(`Invalid settings: provider "${providerId}" enabled must be boolean`);
    }
  }

  if (!settings.preferences || typeof settings.preferences !== 'object') {
    throw new Error('Invalid settings: preferences must be an object');
  }

  if (!settings.ui || typeof settings.ui !== 'object') {
    throw new Error('Invalid settings: ui must be an object');
  }
}

/**
 * 获取当前默认的AI供应商配置
 */
export function getDefaultAIProvider(): AIProvider | null {
  const settings = loadUserSettings();
  const defaultId = settings.aiProviders.default;
  const provider = settings.aiProviders.providers[defaultId];
  
  if (!provider || !provider.enabled) {
    return null;
  }
  
  return provider;
}

/**
 * 获取所有启用的AI供应商
 */
export function getEnabledAIProviders(): AIProvider[] {
  const settings = loadUserSettings();
  return Object.entries(settings.aiProviders.providers)
    .filter(([, provider]) => provider.enabled)
    .map(([, provider]) => provider);
}

/**
 * 更新默认AI供应商
 */
export function setDefaultAIProvider(providerId: string): void {
  const settings = loadUserSettings();
  
  if (!settings.aiProviders.providers[providerId]) {
    throw new Error(`Provider "${providerId}" not found in providers`);
  }
  
  settings.aiProviders.default = providerId;
  saveUserSettings(settings);
  
  log.info('[UserSettings] Default AI provider updated', { providerId });
}

/**
 * 更新AI供应商配置
 */
export function updateAIProvider(providerId: string, updates: Partial<AIProvider>): void {
  const settings = loadUserSettings();
  
  if (!settings.aiProviders.providers[providerId]) {
    throw new Error(`Provider "${providerId}" not found in providers`);
  }
  
  Object.assign(settings.aiProviders.providers[providerId], updates);
  settings.updated_at = new Date().toISOString();
  
  saveUserSettings(settings);
  
  log.info('[UserSettings] AI provider updated', { providerId, updates });
}

/**
 * 更新用户偏好设置
 */
export function updatePreferences(updates: Partial<Preferences>): void {
  const settings = loadUserSettings();
  
  Object.assign(settings.preferences, updates);
  settings.updated_at = new Date().toISOString();
  
  saveUserSettings(settings);
  
  log.info('[UserSettings] Preferences updated', { updates });
}

/**
 * 更新UI设置
 */
export function updateUISettings(updates: Partial<UISettings>): void {
  const settings = loadUserSettings();
  
  Object.assign(settings.ui, updates);
  settings.updated_at = new Date().toISOString();
  
  saveUserSettings(settings);
  
  log.info('[UserSettings] UI settings updated', { updates });
}

/**
 * 重置用户配置为默认值
 */
export function resetUserSettings(): void {
  fs.unlinkSync(USER_SETTINGS_PATH);
  log.info('[UserSettings] User settings reset to defaults');
}

/**
 * 获取用户配置文件路径
 */
export function getUserSettingsPath(): string {
  return USER_SETTINGS_PATH;
}

/**
 * 获取示例配置文件路径
 */
export function getUserSettingsExamplePath(): string {
  return path.join(FINGER_PATHS.repo.root, 'docs', 'reference', 'templates', 'user-settings.example.json');
}
