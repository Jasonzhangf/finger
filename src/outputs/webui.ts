/**
 * WebUI Output Module - 将 MessageHub 消息转发到 WebSocket 广播
 *
 * WebUI 客户端通过 WebSocket (port 9998) 连接并监听事件。
 * 注册为 output 模块后，hub.sendToModule('webui', message) 会广播到所有 WebSocket 客户端。
 */

import type { OutputModule } from '../orchestration/module-registry.js';

export interface WebUIOutputDeps {
  broadcast: (message: Record<string, unknown>) => void;
}

export function createWebUIOutput(deps: WebUIOutputDeps): OutputModule {
  const { broadcast } = deps;

  return {
    id: 'webui',
    type: 'output',
    name: 'webui-output',
    version: '1.0.0',

    async handle(message: unknown, callback?: (result: unknown) => void): Promise<unknown> {
      const payload = (typeof message === 'object' && message !== null)
        ? message as Record<string, unknown>
        : { content: String(message) };

      broadcast({
        type: 'module_message',
        source: 'webui',
        payload,
        timestamp: new Date().toISOString(),
      });

      const result = { delivered: true, method: 'broadcast' };
      if (callback) callback(result);
      return result;
    },

    async healthCheck() {
      return { status: 'healthy', message: 'WebUI output ready for broadcast' };
    },
  };
}
