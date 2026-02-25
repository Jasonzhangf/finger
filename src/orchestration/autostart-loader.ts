/**
 * AutostartLoader - 自动加载 Agent 模块
 * 
 * 从项目 dist 目录加载预定义的 Agent，而不是从 autostart 目录
 * 这样可以正确解析模块依赖
 */

import { pathToFileURL } from 'url';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { logger } from '../core/logger.js';
import type { ModuleRegistry } from './module-registry.js';

const log = logger.module('AutostartLoader');

// 预定义的自动启动 Agent 列表
const AUTOSTART_AGENTS = [
  'router-chat-agent',    // Router + Chat Agent
  'echo-service-agent',   // Echo 测试服务
  // 添加更多需要自动启动的 agent
];

// 获取项目根目录
function getProjectRoot(): string {
  // ESM 模式下获取当前文件目录
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // 从 dist/orchestration 向上两级到项目根
  return join(currentDir, '..', '..');
}

/**
 * 加载并注册自动启动的 Agent
 */
export async function loadAutostartAgents(registry: ModuleRegistry): Promise<void> {
  const projectRoot = getProjectRoot();
  log.info('Loading autostart agents', { projectRoot, agents: AUTOSTART_AGENTS });

  let loaded = 0;
  let failed = 0;

  for (const agentName of AUTOSTART_AGENTS) {
    try {
      // 尝试多个可能的路径
      const possiblePaths = [
        join(projectRoot, 'dist', 'agents', agentName, `${agentName}.js`),
        join(projectRoot, 'dist', 'agents', agentName.replace('-agent', ''), `${agentName}.js`),
        join(projectRoot, 'dist', 'agents', agentName, 'index.js'),
      ];

      let modulePath: string | null = null;
      for (const p of possiblePaths) {
        if (existsSync(p)) {
          modulePath = p;
          break;
        }
      }

      if (!modulePath) {
        log.warn(`Agent module not found: ${agentName}`, { tried: possiblePaths });
        continue;
      }

      log.info(`Loading agent from: ${modulePath}`);
      
      const moduleExports = await import(pathToFileURL(modulePath).href);
      const moduleDef = moduleExports.routerChatAgent || moduleExports.default || moduleExports;

      if (moduleDef && moduleDef.id && moduleDef.type) {
        await registry.register(moduleDef);
        log.info(`Registered autostart agent: ${agentName}`);
        loaded++;
      } else {
        log.warn(`Invalid module export for ${agentName}`);
        failed++;
      }

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error(`Failed to load agent ${agentName}`, error);
      failed++;
    }
  }

  log.info('Autostart loading complete', { loaded, failed });
}

export default loadAutostartAgents;
