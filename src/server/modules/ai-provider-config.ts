/**
 * AI Provider Configuration Module
 * 
 * Validates and loads AI provider configuration from config.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';

import { logger } from '../../core/logger.js';

const log = logger.module('AIProviderConfig');

/**
 * Check AI provider configuration
 * Validates that config.json exists and contains valid provider configuration
 * 
 * @throws {Error} If configuration is invalid or missing
 */
export async function checkAIProviderConfig(): Promise<void> {
  const configPath = path.join(FINGER_PATHS.config.dir, 'config.json');

  try {
    if (!fs.existsSync(configPath)) {
      log.error('[Server] AI provider config not found:', configPath);
      log.error('[Server] Please create config.json with kernel providers configuration');
      log.error('[Server] Example config:');
      log.error(JSON.stringify({
        kernel: {
          providers: {
            tcm: {
              name: "tcm",
              base_url: "http://127.0.0.1:5555/v1",
              wire_api: "responses",
              env_key: "ROUTECODEX_HTTP_APIKEY",
              model: "gpt-5.4"
            }
          },
          provider: "tcm"
        }
      }, null, 2));
      throw new Error('AI provider config not found');
    }

    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);

    if (!config.kernel || !config.kernel.providers) {
      log.error('[Server] Invalid AI provider config: missing kernel.providers');
      throw new Error('Invalid AI provider config: missing kernel.providers');
    }

    const providers = Object.keys(config.kernel.providers);
    if (providers.length === 0) {
      log.error('[Server] No AI providers configured in config.json');
      throw new Error('No AI providers configured');
    }

    const defaultProvider = config.kernel.provider;
    if (!defaultProvider || !config.kernel.providers[defaultProvider]) {
      log.error('[Server] Default AI provider not configured or invalid:', defaultProvider);
      log.error('[Server] Available providers:', providers.join(', '));
      throw new Error(`Default AI provider not configured or invalid: ${defaultProvider}`);
    }

    log.log('[Server] AI provider config loaded successfully');
    log.log('[Server] Default provider:', defaultProvider);
    log.log('[Server] Available providers:', providers.join(', '));
  } catch (err) {
    log.error('[Server] Failed to load AI provider config:', err);
    throw err;
  }
}
