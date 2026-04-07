/**
 * Provider Registry
 * 
 * 动态注册、配置加载、默认 provider 切换
 * 所有配置从 user-settings.json 加载，禁止硬编码
 */

import type { LLMProvider, LLMProviderConfig, LLMProviderType } from './provider-types.js';
import { detectProtocolType } from './provider-types.js';
import { createProvider } from './provider-factory.js';
import { logger } from '../core/logger.js';

const log = logger.module('ProviderRegistry');

export interface AIProviderConfigEntry {
  name: string;
  base_url: string;
  env_key: string;
  model?: string;
  timeout_ms?: number;
  enabled: boolean;
}

export interface UserSettingsAIProviders {
  defaultProvider: string;
  providers: Record<string, AIProviderConfigEntry>;
}

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
   * 检查 provider 是否存在
   */
  has(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * 获取所有已注册的 provider ID
   */
  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
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
   * 获取默认 provider
   */
  getDefault(): LLMProvider {
    if (!this.defaultProviderId) {
      throw new Error('No default provider set');
    }
    return this.providers.get(this.defaultProviderId)!;
  }

  /**
   * 获取默认 provider ID
   */
  getDefaultId(): string | null {
    return this.defaultProviderId;
  }

  /**
   * 获取 provider 配置
   */
  getConfig(id: string): LLMProviderConfig | undefined {
    return this.configs.get(id);
  }

  /**
   * 从 user-settings.json 加载配置
   * 所有模型配置从配置文件读取，禁止硬编码
   */
  loadFromUserSettings(aiProviders: UserSettingsAIProviders): void {
    // 清空现有注册
    this.providers.clear();
    this.configs.clear();
    this.defaultProviderId = null;

    for (const [id, configEntry] of Object.entries(aiProviders.providers)) {
      if (!configEntry.enabled) {
        log.debug('Provider disabled, skipping', { id });
        continue;
      }

      // 解析 API key（从环境变量）
      const apiKey = this.resolveApiKey(configEntry.env_key);
      if (!apiKey) {
        log.warn('API key not found for provider', { id, env_key: configEntry.env_key });
        continue;
      }

      // 构建 LLMProviderConfig
      const providerConfig: LLMProviderConfig = {
        id,
        type: detectProtocolType({
          baseURL: configEntry.base_url,
          defaultModel: configEntry.model,
        }),
        apiKey,
        baseURL: configEntry.base_url,
        defaultModel: configEntry.model,
        timeoutMs: configEntry.timeout_ms,
      };

      // 创建 provider 实例
      const provider = createProvider(providerConfig);
      this.register(provider, providerConfig);
    }

    // 设置默认 provider
    if (aiProviders.defaultProvider && this.has(aiProviders.defaultProvider)) {
      this.setDefault(aiProviders.defaultProvider);
    } else if (this.providers.size > 0) {
      // 如果没有配置默认 provider，使用第一个可用的
      const firstProviderId = this.getAvailableProviders()[0];
      this.setDefault(firstProviderId);
      log.warn('No default provider configured, using first available', { id: firstProviderId });
    }

    log.info('Providers loaded from user settings', {
      count: this.providers.size,
      default: this.defaultProviderId,
    });
  }

  /**
   * 解析 API key（从环境变量）
   */
  private resolveApiKey(envKey: string): string | undefined {
    // 1. 直接环境变量
    const directEnv = process.env[envKey];
    if (directEnv) return directEnv;

    // 2. dotenv 加载的 .env 文件（如果有）
    // 这里假设环境变量已经被加载

    return undefined;
  }

  /**
   * 清空所有注册（用于测试）
   */
  clear(): void {
    this.providers.clear();
    this.configs.clear();
    this.defaultProviderId = null;
  }
}
