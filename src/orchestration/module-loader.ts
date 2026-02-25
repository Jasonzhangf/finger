/**
 * ModuleLoader - 支持从外部目录加载模块
 * 
 * 解决 autostart 模块的路径解析问题
 */

import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import { logger } from '../core/logger.js';

const log = logger.module('ModuleLoader');

/**
 * 从项目目录加载模块（解决 autostart 模块依赖路径问题）
 */
export async function loadModuleFromProject(
  modulePath: string,
  projectRoot: string
): Promise<unknown> {
  // 使用 createRequire 从项目根目录解析模块
  const require = createRequire(pathToFileURL(projectRoot + '/package.json').href);
  
  try {
    // 如果是项目内部模块，使用绝对路径
    if (modulePath.startsWith('src/') || modulePath.startsWith('./src/')) {
      const resolved = require.resolve(modulePath.replace(/^\.?\//, ''));
      const moduleUrl = pathToFileURL(resolved).href;
      return await import(moduleUrl);
    }
    
    // 如果是外部路径，尝试解析
    const moduleUrl = pathToFileURL(modulePath).href;
    return await import(moduleUrl);
  } catch (err) {
    log.error(`Failed to load module: ${modulePath}`, err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

/**
 * 注册 autostart 目录中的 Agent
 * 直接从项目 dist 目录加载，而不是复制后的文件
 */
export async function registerAutostartAgents(
  autostartDir: string,
  projectRoot: string,
  registerFn: (moduleDef: unknown) => Promise<void>
): Promise<void> {
  const { existsSync, readdirSync } = await import('fs');
  const { join } = await import('path');
  
  if (!existsSync(autostartDir)) {
    log.info('Autostart directory not found');
    return;
  }
  
  const files = readdirSync(autostartDir).filter(f => f.endsWith('.js'));
  
  for (const file of files) {
    try {
      const agentName = file.replace('.js', '');
      // 从项目 dist 目录加载，而不是 autostart 目录
      const projectPath = join(projectRoot, 'dist', 'agents', agentName, file);
      
      if (!existsSync(projectPath)) {
        // 尝试其他路径
        const altPath = join(projectRoot, 'dist', 'agents', file);
        if (existsSync(altPath)) {
          const moduleExports = await import(pathToFileURL(altPath).href);
          await registerFn(moduleExports.default || moduleExports);
          log.info(`Registered autostart agent: ${agentName}`);
        } else {
          log.warn(`Agent not found in dist: ${agentName}`);
        }
        continue;
      }
      
      const moduleExports = await import(pathToFileURL(projectPath).href);
      await registerFn(moduleExports.default || moduleExports);
      log.info(`Registered autostart agent: ${agentName}`);
      
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error(`Failed to register autostart agent: ${file}`, error);
    }
  }
}
