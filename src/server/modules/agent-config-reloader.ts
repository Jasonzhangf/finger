import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
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

    console.log(`[Server] Agent JSON configs loaded: ${result.loaded.length} from ${result.dir}`);
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.error(`[Server] Agent config load error ${err.filePath}: ${err.error}`);
      }
    }
  };

  return {
    getLoadedAgentConfigDir: () => loadedAgentConfigDir,
    getLoadedAgentConfigs: () => loadedAgentConfigs,
    reloadAgentJsonConfigs,
  };
}
