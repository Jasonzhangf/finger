/**
 * AI Provider Configuration Module
 *
 * Validates and loads AI provider configuration from user-settings.json
 */

import { checkAIProviderConfigValidity, loadAIProviders } from '../../core/user-settings.js';
import { logger } from '../../core/logger.js';

const log = logger.module('AIProviderConfig');

/**
 * Check AI provider configuration
 * Validates that user-settings.json contains valid provider configuration
 *
 * @throws {Error} If configuration is invalid or missing
 */
export async function checkAIProviderConfig(): Promise<void> {
  try {
    const valid = checkAIProviderConfigValidity();
    if (!valid) {
      throw new Error('Invalid AI provider config in user-settings.json');
    }
    const providersConfig = loadAIProviders();
    const providers = Object.keys(providersConfig.providers || {});
    const defaultProvider = providersConfig.default;

    log.info('[Server] AI provider config loaded successfully');
    log.info('[Server] Default provider', { defaultProvider });
    log.info('[Server] Available providers', { providers: providers.join(', ') });
  } catch (err) {
    log.error('[Server] Failed to load AI provider config', err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}
