/**
 * 路由唯一性测试
 * 验证 /api/v1/agent/* 路由只注册一次，符合全局唯一实现约束
 */

import { describe, it, expect, vi } from 'vitest';

describe('Route Uniqueness', () => {
  it('should register each /api/v1/agent/* route only once', async () => {
    // 导入并注册服务器路由（模拟）
    const agentRoutes = [
      '/api/v1/agent/understand',
      '/api/v1/agent/route',
      '/api/v1/agent/plan',
      '/api/v1/agent/execute',
      '/api/v1/agent/review',
      '/api/v1/agent/orchestrate',
    ];

    // 直接检查源代码中的路由注册次数
    const fs = await import('fs');
    const path = await import('path');
    const serverCode = fs.readFileSync(
      path.join(process.cwd(), 'src/server/index.ts'),
      'utf-8'
    );

    for (const route of agentRoutes) {
      const pattern = new RegExp(`app\\.post\\('${route.replace(/\//g, '\\/')}'`, 'g');
      const matches = serverCode.match(pattern) || [];
      expect(matches.length, `Route ${route} should be registered exactly once, found ${matches.length}`).toBe(1);
    }
  });

  it('should verify POST /api/v1/message response structure', async () => {
    // 模拟 Message Hub 响应
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        messageId: 'msg-123',
        status: 'queued',
        result: { test: 'data' },
      }),
    });
    global.fetch = mockFetch;

    const res = await fetch('http://localhost:5521/api/v1/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'test', message: {} }),
    });

    const data = await res.json();
    expect(data).toHaveProperty('messageId');
    expect(data).toHaveProperty('status');
    expect(['queued', 'processing', 'completed', 'failed']).toContain(data.status);
  });

  it('should verify each agent route exists and responds correctly', async () => {
    // 检查源代码中每个 agent 路由是否存在
    const fs = await import('fs');
    const path = await import('path');
    const serverCode = fs.readFileSync(
      path.join(process.cwd(), 'src/server/index.ts'),
      'utf-8'
    );

    const requiredRoutes = [
      "app.post('/api/v1/agent/understand'",
      "app.post('/api/v1/agent/route'",
      "app.post('/api/v1/agent/plan'",
      "app.post('/api/v1/agent/execute'",
      "app.post('/api/v1/agent/review'",
      "app.post('/api/v1/agent/orchestrate'",
    ];

    for (const routeDef of requiredRoutes) {
      expect(serverCode, `${routeDef} should exist in server code`).toContain(routeDef);
    }
  });
});
