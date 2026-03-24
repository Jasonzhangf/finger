/**
 * User Settings Module
 * 
 * 管理用户配置的读取、写入、验证和持久化
 */

import * as fs from 'fs';
import * as path from 'path';
import { FINGER_PATHS, ensureDir } from './finger-paths.js';
import { logger } from './logger.js';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';

const clog = createConsoleLikeLogger('UserSettings');

const log = logger.module('UserSettings');

const USER_SETTINGS_PATH = path.join(FINGER_PATHS.config.dir, 'user-settings.json');


const USER_SETTINGS_BACKUP_PATH = path.join(FINGER_PATHS.config.dir, 'user-settings.backup.json');
const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// 验证规则
const VALID_WIRE_APIS = ['responses', 'http'];
const VALID_THEMES = ['dark', 'light', 'auto'];
const VALID_VERBOSITY = ['high', 'medium', 'low'];
const VALID_REASONING_EFFORT = ['high', 'medium', 'low'];
const VALID_REASONING_SUMMARY = ['detailed', 'medium', 'short'];
const VALID_WEB_SEARCH = ['live', 'off'];

/**
 * 验证URL格式
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * 备份损坏的配置文件
 */
function backupCorruptedSettings(): void {
  try {
    if (fs.existsSync(USER_SETTINGS_PATH)) {
      fs.copyFileSync(USER_SETTINGS_PATH, USER_SETTINGS_BACKUP_PATH);
      log.info('[UserSettings] Corrupted settings backed up to', { path: USER_SETTINGS_BACKUP_PATH });
      clog.error(`⚠️ Corrupted settings backed up to: ${USER_SETTINGS_BACKUP_PATH}`);
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('[UserSettings] Failed to backup corrupted settings', error);
  }
}

/**
 * 清理过期的备份文件
 */
function cleanOldBackups(): void {
  try {
    if (fs.existsSync(USER_SETTINGS_BACKUP_PATH)) {
      const stats = fs.statSync(USER_SETTINGS_BACKUP_PATH);
      const age = Date.now() - stats.mtimeMs;
      if (age > BACKUP_MAX_AGE_MS) {
        fs.unlinkSync(USER_SETTINGS_BACKUP_PATH);
        log.info('[UserSettings] Old backup cleaned up');
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('[UserSettings] Failed to clean old backup', error);
  }
}

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
  thinkingEnabled: boolean;
  reasoningEffort: 'high' | 'medium' | 'low';
  reasoningSummary: 'detailed' | 'medium' | 'short';
  verbosity: 'high' | 'medium' | 'low';
  webSearch: 'live' | 'off';
}

export interface UISettings {
  theme: 'dark' | 'light' | 'auto';
  language: string;
  timeZone: string;
}

export interface LedgerSettings {
  /** Context window size in tokens (default: 256K = 262144) */
  contextWindow: number;
  /**
   * Compression trigger threshold in tokens.
   * Default: 85% of contextWindow = 222822.
   * When session.totalTokens exceeds this, compression is triggered.
   */
  compressTokenThreshold: number;
}

export interface ContextBuilderSettings {
  enabled: boolean;
  budgetRatio: number;
  halfLifeMs: number;
  overThresholdRelevance: number;
  enableModelRanking: boolean;
  rankingModel: string;
  includeMemoryMd: boolean;
}

export interface UserSettings {
  version: string;
  updated_at: string;
  aiProviders: AIProviders;
  preferences: Preferences;
  ui: UISettings;
  ledger: LedgerSettings;
  contextBuilder: ContextBuilderSettings;
}

const DEFAULT_USER_SETTINGS: UserSettings = {
  version: '1.0',
  updated_at: new Date().toISOString(),
  aiProviders: {
    default: 'tcm',
    providers: {
      tcm: {
        name: 'tcm',
        base_url: 'http://127.0.0.1:5555/v1',
        wire_api: 'http',
        env_key: 'ROUTECODEX_HTTP_APIKEY',
        model: 'tabglm.glm-5-turbo',
        enabled: true
      }
    }
  },
  preferences: {
    defaultModel: 'tabglm.glm-5-turbo',
    maxTokens: 256000,
    temperature: 0.7,
    thinkingEnabled: true,
    reasoningEffort: 'high',
    reasoningSummary: 'detailed',
    verbosity: 'medium',
    webSearch: 'live'
  },
  ui: {
    theme: 'dark',
    language: 'zh-CN',
    timeZone: 'Asia/Shanghai'
  },
  ledger: {
    contextWindow: 262144,
    compressTokenThreshold: 222822,
  },
  contextBuilder: {
    enabled: false,
    budgetRatio: 0.85,
    halfLifeMs: 86400000,
    overThresholdRelevance: 0.5,
    enableModelRanking: false,
    rankingModel: 'qwen3.5-plus',
    includeMemoryMd: true,
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
      saveUserSettings(DEFAULT_USER_SETTINGS);
      return DEFAULT_USER_SETTINGS;
    }

    const raw = fs.readFileSync(USER_SETTINGS_PATH, 'utf-8');
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
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('[UserSettings] Failed to load user settings, using defaults', err instanceof Error ? err : new Error(String(err)));
    backupCorruptedSettings();
    return DEFAULT_USER_SETTINGS;
  }
}

/**
 * 保存用户配置
 */
export function saveUserSettings(settings: UserSettings): void {
  try {
    settings.updated_at = new Date().toISOString();
    ensureDir(FINGER_PATHS.config.dir);
    const content = JSON.stringify(settings, null, 2);
    fs.writeFileSync(USER_SETTINGS_PATH, content, 'utf-8');
    
    log.info('[UserSettings] User settings saved successfully', {
      version: settings.version,
      defaultProvider: settings.aiProviders.default,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
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

  for (const [providerId, provider] of Object.entries(settings.aiProviders.providers) as [string, AIProvider][]) {
    if (!provider.name || typeof provider.name !== 'string') {
      throw new Error(`Invalid settings: provider "${providerId}" missing or invalid name`);
    }

    if (!provider.base_url || typeof provider.base_url !== 'string') {
      throw new Error(`Invalid settings: provider "${providerId}" missing or invalid base_url`);
    if (!isValidUrl(provider.base_url)) {
      throw new Error(`Invalid settings: provider "${providerId}" base_url must be a valid URL`);
    }
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

  // Validate preferences
  if (settings.preferences.defaultModel && typeof settings.preferences.defaultModel !== 'string') {
    throw new Error('Invalid settings: preferences.defaultModel must be a string');
  }
  if (settings.preferences.maxTokens !== undefined && (typeof settings.preferences.maxTokens !== 'number' || settings.preferences.maxTokens <= 0)) {
    throw new Error('Invalid settings: preferences.maxTokens must be a positive number');
  }
  if (settings.preferences.temperature !== undefined && (typeof settings.preferences.temperature !== 'number' || settings.preferences.temperature < 0 || settings.preferences.temperature > 2)) {
    throw new Error('Invalid settings: preferences.temperature must be between 0 and 2');
  }
  if (settings.preferences.thinkingEnabled !== undefined && typeof settings.preferences.thinkingEnabled !== 'boolean') {
    throw new Error('Invalid settings: preferences.thinkingEnabled must be a boolean');
  }
  if (settings.preferences.reasoningEffort && !VALID_REASONING_EFFORT.includes(settings.preferences.reasoningEffort)) {
    throw new Error(`Invalid settings: preferences.reasoningEffort must be one of: ${VALID_REASONING_EFFORT.join(', ')}`);
  }
  if (settings.preferences.reasoningSummary && !VALID_REASONING_SUMMARY.includes(settings.preferences.reasoningSummary)) {
    throw new Error(`Invalid settings: preferences.reasoningSummary must be one of: ${VALID_REASONING_SUMMARY.join(', ')}`);
  }
  if (settings.preferences.verbosity && !VALID_VERBOSITY.includes(settings.preferences.verbosity)) {
    throw new Error(`Invalid settings: preferences.verbosity must be one of: ${VALID_VERBOSITY.join(', ')}`);
  }
  if (settings.preferences.webSearch && !VALID_WEB_SEARCH.includes(settings.preferences.webSearch)) {
    throw new Error(`Invalid settings: preferences.webSearch must be one of: ${VALID_WEB_SEARCH.join(', ')}`);
  }
  }

  if (!settings.ui || typeof settings.ui !== 'object') {
    throw new Error('Invalid settings: ui must be an object');

  // Validate ui
  if (settings.ui.theme && !VALID_THEMES.includes(settings.ui.theme)) {
    throw new Error(`Invalid settings: ui.theme must be one of: ${VALID_THEMES.join(', ')}`);
  }
  if (settings.ui.language && typeof settings.ui.language !== 'string') {
    throw new Error('Invalid settings: ui.language must be a string');
  }
  if (settings.ui.timeZone && typeof settings.ui.timeZone !== 'string') {
    throw new Error('Invalid settings: ui.timeZone must be a string');
  }
  }

  // Validate ledger settings (with defaults for missing fields)
  if (!settings.ledger || typeof settings.ledger !== 'object') {
    settings.ledger = { contextWindow: 262144, compressTokenThreshold: 222822 };
  }
  if (settings.ledger.contextWindow !== undefined && (typeof settings.ledger.contextWindow !== 'number' || settings.ledger.contextWindow <= 0)) {
    throw new Error('Invalid settings: ledger.contextWindow must be a positive number');
  }
  if (settings.ledger.compressTokenThreshold !== undefined && (typeof settings.ledger.compressTokenThreshold !== 'number' || settings.ledger.compressTokenThreshold <= 0)) {
    throw new Error('Invalid settings: ledger.compressTokenThreshold must be a positive number');
  }
  // Apply defaults for missing fields
  if (settings.ledger.contextWindow === undefined) {
    settings.ledger.contextWindow = 262144;
  }
  if (settings.ledger.compressTokenThreshold === undefined) {
    settings.ledger.compressTokenThreshold = Math.floor(settings.ledger.contextWindow * 0.85);
  }

  // Validate contextBuilder settings (with defaults for missing fields)
  if (!settings.contextBuilder || typeof settings.contextBuilder !== 'object') {
    settings.contextBuilder = {
      enabled: false,
      budgetRatio: 0.85,
      halfLifeMs: 86400000,
      overThresholdRelevance: 0.5,
      enableModelRanking: false,
      rankingModel: 'qwen3.5-plus',
      includeMemoryMd: true,
    };
  }
  if (typeof settings.contextBuilder.enabled !== 'boolean') {
    settings.contextBuilder.enabled = false;
  }
  if (typeof settings.contextBuilder.budgetRatio !== 'number' || settings.contextBuilder.budgetRatio <= 0 || settings.contextBuilder.budgetRatio > 1) {
    settings.contextBuilder.budgetRatio = 0.85;
  }
  if (typeof settings.contextBuilder.halfLifeMs !== 'number' || settings.contextBuilder.halfLifeMs <= 0) {
    settings.contextBuilder.halfLifeMs = 86400000;
  }
  if (typeof settings.contextBuilder.overThresholdRelevance !== 'number' || settings.contextBuilder.overThresholdRelevance < 0 || settings.contextBuilder.overThresholdRelevance > 1) {
    settings.contextBuilder.overThresholdRelevance = 0.5;
  }
  if (typeof settings.contextBuilder.enableModelRanking !== 'boolean') {
    settings.contextBuilder.enableModelRanking = false;
  }
  if (typeof settings.contextBuilder.rankingModel !== 'string' || settings.contextBuilder.rankingModel.trim().length === 0) {
    settings.contextBuilder.rankingModel = 'qwen3.5-plus';
  }
  if (typeof settings.contextBuilder.includeMemoryMd !== 'boolean') {
    settings.contextBuilder.includeMemoryMd = true;
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
  if (fs.existsSync(USER_SETTINGS_PATH)) {
    fs.unlinkSync(USER_SETTINGS_PATH);
  }
  log.info('[UserSettings] User settings reset to defaults');
}

/**
 * 获取用户配置文件路径
 */
export function getUserSettingsPath(): string {
  return USER_SETTINGS_PATH;
}

/**
 * 加载 Ledger 配置
 *
 * @returns {LedgerSettings} Ledger 配置
 */
export function loadLedgerSettings(): LedgerSettings {
  const settings = loadUserSettings();
  return settings.ledger;
}

export function loadContextBuilderSettings(): ContextBuilderSettings {
  const settings = loadUserSettings();
  if (!settings.contextBuilder) {
    return { enabled: false, budgetRatio: 0.85, halfLifeMs: 86400000, overThresholdRelevance: 0.5, enableModelRanking: false, rankingModel: 'qwen3.5-plus', includeMemoryMd: true };
  }
  return settings.contextBuilder;
}

/**
 * 获取 context window 大小 (tokens)
 */
export function getContextWindow(): number {
  const ledger = loadLedgerSettings();
  return ledger.contextWindow;
}

/**
 * 获取压缩触发阈值 (tokens)
 * 默认为 contextWindow 的 85%
 */
export function getCompressTokenThreshold(): number {
  const ledger = loadLedgerSettings();
  return ledger.compressTokenThreshold;
}

/**
 * 获取示例配置文件路径
 */

/**
 * 加载 AI provider 配置（用户配置唯一真源）
 * 
 * @returns {AIProviders} AI provider 配置
 */
export function loadAIProviders(): AIProviders {
  const settings = loadUserSettings();
  return settings.aiProviders;
}

/**
 * 获取默认 AI provider ID
 *
 * @returns {string} 默认 provider ID
 */
export function getDefaultAIProviderId(): string {
  const settings = loadUserSettings();
  return settings.aiProviders.default;
}

/**
 * 获取指定 provider 的配置
 * 
 * @param providerId Provider ID
 * @returns {AIProvider | undefined} Provider 配置
 */
export function getAIProvider(providerId: string): AIProvider | undefined {
  const settings = loadUserSettings();
  return settings.aiProviders.providers[providerId];
}

/**
 * 检查 AI provider 配置
 * 
 * @returns {boolean} 是否有效
 */
export function checkAIProviderConfigValidity(): boolean {
  const settings = loadUserSettings();
  try {
    const providers = Object.keys(settings.aiProviders.providers);
    if (providers.length === 0) {
      log.error('[UserSettings] No AI providers configured in user-settings.json');
      return false;
    }
    const defaultProvider = settings.aiProviders.default;
   if (!defaultProvider || !settings.aiProviders.providers[defaultProvider]) {
      log.error('[UserSettings] Default AI provider not configured or invalid', undefined, { defaultProvider, availableProviders: providers.join(', ') });
      return false;
    }
    // 验证每个 provider 的配置
    for (const [providerId, provider] of Object.entries(settings.aiProviders.providers)) {
      if (!isValidUrl(provider.base_url)) {
        log.error('[UserSettings] Invalid base_url for provider', undefined, { providerId, base_url: provider.base_url });
        return false;
      }
      if (!VALID_WIRE_APIS.includes(provider.wire_api)) {
        log.error('[UserSettings] Invalid wire_api for provider', undefined, { providerId, wire_api: provider.wire_api });
        return false;
      }
     if (!provider.env_key) {
       log.error('[UserSettings] Missing env_key for provider', undefined, { providerId });
       return false;
     }
   }
    log.info('[UserSettings] AI provider config is valid', {
      defaultProvider,
      providerCount: providers.length
    });
    return true;
 } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('[UserSettings] Failed to validate AI provider config', error, {});
    return false;
  }
}
