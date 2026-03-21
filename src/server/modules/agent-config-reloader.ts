import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import { logger } from '../../core/logger.js';
import {
  loadAgentJsonConfigs,
  applyAgentJsonConfigs,
  type LoadedAgentConfig,
} from '../../runtime/agent-json-config.js';

export interface AgentConfigReloaderDeps {
  runtime: RuntimeFacade;
  initialConfigDir: string;
}

export interface AgentConfigReloader {
  getLoadedAgentConfigDir: () => string;
  getLoadedAgentConfigs: () => LoadedAgentConfig[];
  reloadAgentJsonConfigs: (configDir?: string) => void;
}

export function createAgentConfigReloader(deps: AgentConfigReloaderDeps): AgentConfigReloader {
  const { runtime, initialConfigDir } = deps;
  let loadedAgentConfigDir = initialConfigDir;
  let loadedAgentConfigs: LoadedAgentConfig[] = [];

  const reloadAgentJsonConfigs = (configDir?: string): void => {
    const dir = configDir ?? loadedAgentConfigDir;
    const result = loadAgentJsonConfigs(dir);
    loadedAgentConfigDir = result.dir;
    loadedAgentConfigs = result.loaded;
    applyAgentJsonConfigs(runtime, result.loaded.map((item) => item.config));

    logger.module('agent-config-reloader').info('Agent JSON configs loaded', { count: result.loaded.length, dir: result.dir });
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        logger.module('agent-config-reloader').error('Agent config load error', undefined, { filePath: err.filePath, error: err.error });
      }
    }
  };

  return {
    getLoadedAgentConfigDir: () => loadedAgentConfigDir,
    getLoadedAgentConfigs: () => loadedAgentConfigs,
    reloadAgentJsonConfigs,
  };
}
