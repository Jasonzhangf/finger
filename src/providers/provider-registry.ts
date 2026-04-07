/**
 * Provider Registry
 * 
 * 全局单例，管理所有 provider 实例
 * 从 user-settings.json 加载配置，禁止硬编码
 */

import type { LLMProvider, LLMProviderConfig, LLMProviderType } from './provider-types.js';
import { detectProtocolType } from './provider-types.js';
import { createProvider } from './provider-factory.js';
import { logger } from '../core/logger.js';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const log = logger.module('ProviderRegistry');

/**
 * user-settings.json 中单个 provider 的配置格式
 */
export interface AIProviderConfigEntry {
  name: string;
  base_url: string;
  env_key: string;
  model: string;
  timeout_ms?: number;
  enabled?: boolean;
}

/**
 * user-settings.json 中 aiProviders 字段的格式
 */
export interface UserSettingsAIProviders {
  default?: string;
  providers: Record<string, AIProviderConfigEntry>;
}

/**
 * Provider Registry（全局单例）
 */
export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();
  private configs: Map<string, LLMProviderConfig> = new Map();
  private defaultProviderId: string | null = null;
  private static instance: ProviderRegistry | null = null;

  private constructor() {}

  static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  /**
   * 清空 registry（用于测试）
   */
  clear(): void {
    this.providers.clear();
    this.configs.clear();
    this.defaultProviderId = null;
    log.debug('Registry cleared');
  }

  /**
   * 注册 provider
   */
  register(provider: LLMProvider, config: LLMProviderConfig): void {
    this.providers.set(provider.id, provider);
    this.configs.set(provider.id, config);
    log.info('Provider registered', { id: provider.id, type: provider.type });
  }

  /**
   * 获取 provider
   */
  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * 获取 provider 配置
   */
  getConfig(id: string): LLMProviderConfig | undefined {
    return this.configs.get(id);
  }

  /**
   * 检查 provider 是否存在
   */
  has(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * 设置默认 provider
   */
  setDefault(id: string): void {
    if (!this.has(id)) {
      throw new Error(`Provider ${id} not registered`);
    }
    this.defaultProviderId = id;
    log.info('Default provider set', { id });
  }

  /**
   * 获取默认 provider ID
   */
  getDefaultId(): string | null {
    return this.defaultProviderId;
  }

  /**
   * 获取默认 provider
   */
  getDefault(): LLMProvider | undefined {
    if (!this.defaultProviderId) {
      return undefined;
    }
    return this.providers.get(this.defaultProviderId);
  }

  /**
   * 获取所有可用 provider ID
   */
  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * 从 user-settings.json 加载配置
   * 所有参数从配置读取，禁止硬编码
   */
  loadFromUserSettings(settings: UserSettingsAIProviders): void {
    const defaultProviderId = settings.default ?? null;
    const entries = settings.providers;

    let loadedCount = 0;
    for (const [id, entry] of Object.entries(entries)) {
      // 跳过 disabled provider
      if (entry.enabled === false) {
        log.debug('Provider disabled, skipping', { id });
        continue;
      }

      // 从环境变量读取 API key
      const apiKey = process.env[entry.env_key] ?? '';
      if (!apiKey) {
        log.warn('API key not found for provider', { id, env_key: entry.env_key });
        continue;
      }

      // 构建配置（从配置读取，禁止硬编码）
      const config: LLMProviderConfig = {
        id,
        type: detectProtocolType({
          baseURL: entry.base_url,
          defaultModel: entry.model,
        }),
        apiKey,
        baseURL: entry.base_url,
        defaultModel: entry.model,
        timeoutMs: entry.timeout_ms,
      };

      // 创建 provider
      const provider = createProvider(config);
      this.register(provider, config);
      loadedCount++;
    }

    // 设置默认 provider
    if (defaultProviderId && this.has(defaultProviderId)) {
      this.setDefault(defaultProviderId);
    } else if (loadedCount > 0) {
      // 如果 default 不存在，使用第一个加载的 provider
      const firstProviderId = this.getAvailableProviders()[0];
      this.setDefault(firstProviderId);
      log.warn('Default provider not found, using first loaded', {
        requested: defaultProviderId,
        actual: firstProviderId,
      });
    }

    log.info('Providers loaded from user settings', {
      count: loadedCount,
      default: this.defaultProviderId,
    });
  }

  /**
   * 从默认路径加载 user-settings.json
   */
  loadFromDefaultPath(): void {
    const userSettingsPath = join(homedir(), '.finger', 'config', 'user-settings.json');
    
    if (!existsSync(userSettingsPath)) {
      log.warn('User settings file not found', { path: userSettingsPath });
      return;
    }

    try {
      const content = readFileSync(userSettingsPath, 'utf-8');
      const settings = JSON.parse(content);
      
      if (settings.aiProviders) {
        this.loadFromUserSettings(settings.aiProviders);
      } else {
        log.warn('No aiProviders section in user settings');
      }
    } catch (error) {
      const err = error as Error;
      log.error('Failed to load user settings', err, { path: userSettingsPath });
    }
  }
}
