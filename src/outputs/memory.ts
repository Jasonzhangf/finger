/**
 * Memory Output - 统一处理 CACHE.md / MEMORY.md 写入
 *
 * - target: 'cache' => 使用 extended memory tool 写入 CACHE.md
 * - target: 'memory' => 使用 memory tool 写入 MEMORY.md
 */

import type { OutputModule } from '../orchestration/module-registry.js';
import { executeExtendedMemory } from '../tools/internal/memory/memory-tool-extended.js';
import { memoryTool } from '../tools/internal/memory/memory-tool.js';
import { createToolExecutionContext } from '../tools/internal/types.js';

export const memoryOutput: OutputModule = {
  id: 'memory',
  type: 'output',
  name: 'memory-output',
  version: '1.0.0',
  handle: async (message: unknown, callback?: (result: unknown) => void) => {
    const payload = (typeof message === 'object' && message !== null)
      ? message as Record<string, unknown>
      : null;

    if (!payload) {
      const result = { ok: false, error: 'Invalid payload for memory output' };
      if (callback) callback(result);
      return result;
    }

    const target = typeof payload.target === 'string' ? payload.target : undefined;

    let result: unknown;
    if (target === 'cache') {
      result = await executeExtendedMemory(payload);
    } else {
      const projectPath = typeof payload.project_path === 'string'
        ? payload.project_path
        : process.cwd();
      const context = createToolExecutionContext({ cwd: projectPath });
      result = await memoryTool.execute(payload, context);
    }

    if (callback) callback(result);
    return result;
  },
};

export default memoryOutput;
