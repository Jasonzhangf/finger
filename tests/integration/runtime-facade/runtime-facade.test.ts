import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Runtime Facade Integration Tests', () => {
  let testHome: string;
  beforeEach(() => { testHome = path.join(os.tmpdir(), `rt-${Date.now()}`); fs.mkdirSync(testHome, { recursive: true }); process.env.FINGER_HOME = testHome; });
  afterEach(() => { delete process.env.FINGER_HOME; if (fs.existsSync(testHome)) fs.rmSync(testHome, { recursive: true, force: true }); });

  it('工具注册执行', async () => {
    const { InternalToolRegistry } = await import('../../../src/tools/internal/registry.js');
    const r = new InternalToolRegistry();
    r.register({ name: 'test_tool', description: 'test', executionModel: 'request_response', inputSchema: {}, execute: async () => ({ ok: true }) });
    expect(r.has('test_tool')).toBe(true);
    expect(await r.execute('test_tool', {})).toEqual({ ok: true });
  });

  it('不存在工具抛错', async () => {
    const { InternalToolRegistry } = await import('../../../src/tools/internal/registry.js');
    const r = new InternalToolRegistry();
    await expect(r.execute('none', {})).rejects.toThrow();
  });
});
