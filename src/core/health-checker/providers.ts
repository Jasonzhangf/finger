/**
 * AI Provider Health Checks
 */

import { logger } from '../logger.js';
import { loadUserSettings, getDefaultAIProvider } from '../user-settings.js';
import type { AIProviderCheckResult } from './types.js';

const log = logger.module('HealthChecker');

/**
 * 检查AI供应商连接状态
 */
export async function checkAIProviderConnection(providerId: string): Promise<AIProviderCheckResult> {
  try {
    const settings = loadUserSettings();
    const provider = settings.aiProviders.providers[providerId];

    if (!provider) {
      return {
        providerId,
        status: 'error',
        message: `Provider "${providerId}" not found`,
        timestamp: new Date().toISOString(),
      };
    }

    if (!provider.enabled) {
      return {
        providerId,
        status: 'disconnected',
        message: `Provider "${providerId}" is disabled`,
        timestamp: new Date().toISOString(),
      };
    }

    const startTime = Date.now();

    if (provider.wire_api === 'http') {
      const response = await fetch(`${provider.base_url}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env[provider.env_key] || ''}`,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } else {
      const response = await fetch(provider.base_url.replace('/v1', '/health'), {
        method: 'GET',
      });

      if (!response.ok && response.status !== 404) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    }

    const latency = Date.now() - startTime;

    return {
      providerId,
      status: 'connected',
      message: `Connected successfully (${latency}ms)`,
      latency,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      providerId,
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * 检查所有AI供应商的连接状态
 */
export async function checkAllAIProviderConnections(): Promise<AIProviderCheckResult[]> {
  const settings = loadUserSettings();
  const results: AIProviderCheckResult[] = [];

  for (const providerId of Object.keys(settings.aiProviders.providers)) {
    const result = await checkAIProviderConnection(providerId);
    results.push(result);
  }

  return results;
}

/**
 * 执行AI供应商连接检测
 */
export async function performAIProviderHealthCheck(): Promise<boolean> {
  log.info('Performing AI provider health check');

  const defaultProvider = getDefaultAIProvider();

  if (!defaultProvider) {
    log.warn('No default AI provider configured');
    console.warn('⚠️ [Health Check] No default AI provider configured');
    return false;
  }

  const result = await checkAIProviderConnection(defaultProvider.name);

  if (result.status === 'connected') {
    log.info('AI provider health check passed', { result });
    console.log(`✓ [Health Check] AI provider "${defaultProvider.name}" is connected (${result.latency}ms)`);
    return true;
  }

  log.error('AI provider health check failed', new Error(result.message));
  console.error(`❌ [Health Check] AI provider "${defaultProvider.name}" is ${result.status}: ${result.message}`);
  return false;
}
