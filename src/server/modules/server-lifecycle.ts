/**
 * Server Lifecycle
 *
 * Handles server startup, shutdown, and post-listen initialization.
 */

import { writeFileSync, unlinkSync, existsSync } from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { logger } from '../../core/logger.js';
import { loadInputsConfig, loadOutputsConfig } from '../../core/config-loader.js';
import { toOpenClawToolDefinition } from '../../orchestration/openclaw-adapter/index.js';
import { OpenClawGateBlock, type OpenClawGateEvent } from '../../blocks/openclaw-gate/index.js';
import { globalToolRegistry } from '../../runtime/tool-registry.js';
import { syncUserSettingsToKernelConfig } from '../../core/user-settings-sync.js';
import { checkAIProviderConfig } from './ai-provider-config.js';
import { loadChannelBridgeConfigs } from './channel-bridge-bootstrap.js';

const log = logger.module('ServerLifecycle');

export interface ChatCodexRunnerController {
  listSessionStates(): Array<{ sessionId: string; providerId: string }>;
  interruptSession(sessionId: string, providerId: string): void;
}

/**
 * Initialize OpenClaw gate, sync AI provider config, and load channel bridges.
 * Called after server is listening.
 */
export async function initOpenClawGate(): Promise<void> {
  const inputsCfg = loadInputsConfig();
  const outputsCfg = loadOutputsConfig();
  const openClawInputConfig = inputsCfg.inputs.find((item) => item.kind === 'openclaw' && item.enabled)?.config as { pluginDir?: string } | undefined;
  const openClawOutputConfig = outputsCfg.outputs.find((item) => item.kind === 'openclaw' && item.enabled)?.config as { pluginDir?: string } | undefined;
  const openClawPluginDir = openClawInputConfig?.pluginDir ?? openClawOutputConfig?.pluginDir;

  log.info('OpenClaw plugin dir: ' + openClawPluginDir);

  if (openClawPluginDir) {
    const openClawGate = new OpenClawGateBlock('openclaw-gate', { pluginDir: openClawPluginDir });
    try {
      await openClawGate.initialize();
      openClawGate.addEventListener((event: OpenClawGateEvent) => {
        switch (event.type) {
          case 'plugin_enabled':
          case 'plugin_installed':
            for (const tool of event.tools) {
              globalToolRegistry.register(toOpenClawToolDefinition(event.pluginId, tool, openClawGate));
            }
            break;
          case 'plugin_disabled':
          case 'plugin_uninstalled':
            for (const toolName of event.toolNames) {
              globalToolRegistry.unregister(toolName);
            }
            break;
        }
      });
      log.info('OpenClaw Gate initialized, plugins: ' + openClawGate.listPlugins().length);
    } catch (err) {
      log.error('Failed to initialize OpenClaw Gate', err instanceof Error ? err : undefined);
    }
  } else {
    log.info('OpenClaw Gate skipped: no plugin dir configured');
  }

  try {
    log.info('syncUserSettingsToKernelConfig...');
    await syncUserSettingsToKernelConfig();
    log.info('syncUserSettingsToKernelConfig completed');
  } catch (err) {
    log.error('syncUserSettingsToKernelConfig failed', err instanceof Error ? err : undefined);
  }

  try {
    log.info('checkAIProviderConfig...');
    await checkAIProviderConfig();
    log.info('checkAIProviderConfig completed');
  } catch (err) {
    log.error('checkAIProviderConfig failed', err instanceof Error ? err : undefined);
  }

  try {
    log.info('loadChannelBridgeConfigs...');
    await loadChannelBridgeConfigs();
    log.info('loadChannelBridgeConfigs completed');
  } catch (err) {
    log.error('loadChannelBridgeConfigs failed', err instanceof Error ? err : undefined);
  }
}

/**
 * Write PID file on server start
 */
export function writePidFile(): void {
  try {
    const pidPath = path.join(FINGER_PATHS.runtime.dir, 'server.pid');
    writeFileSync(pidPath, String(process.pid));
  } catch (err) {
    log.error('Failed to write PID file', err instanceof Error ? err : undefined);
  }
}

/**
 * Clean up PID file on exit
 */
export function cleanupPidFile(): void {
  try {
    const pidPath = path.join(FINGER_PATHS.runtime.dir, 'server.pid');
    if (existsSync(pidPath)) unlinkSync(pidPath);
  } catch {
    // ignore
  }
}
