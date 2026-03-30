import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { SessionManager } from '../../src/orchestration/session-manager.js';
import { FINGER_PATHS } from '../../src/core/finger-paths.js';

describe('Session Manager Persistence', () => {
  const TEST_SESSION_ID = 'test-session-' + Date.now();
  const TEST_PROJECT_PATH = '/tmp/test-project';
  
  beforeAll(async () => {
    // 确保测试目录存在
    if (!existsSync(TEST_PROJECT_PATH)) {
      mkdirSync(TEST_PROJECT_PATH, { recursive: true });
    }
  });

  afterAll(() => {
    // 清理测试会话
    const testSessionsDir = join(FINGER_PATHS.sessions.dir, '_tmp_test-project');
    // 简单清理：删除整个测试项目目录
    // 注意：实际生产中需要更细粒度的清理
  });

  it('system session path is correct', () => {
    const systemSessionsDir = join(FINGER_PATHS.home, 'system', 'sessions');
    expect(existsSync(systemSessionsDir)).toBe(true);
  });

  it('session manager initializes without errors', () => {
    expect(() => new SessionManager()).not.toThrow();
  });

  it('can create and persist session', () => {
    const manager = new SessionManager();
    
    const session = manager.createSession(TEST_PROJECT_PATH, 'Test Session');

    expect(session).toBeDefined();
    expect(session.id).toBeDefined();
    expect(session.projectPath).toBe(TEST_PROJECT_PATH);
    
    // 验证文件是否被创建
    const sessionDir = manager.resolveSessionStorageDir(session.id);
    expect(sessionDir).not.toBeNull();
    
    const sessionFile = join(sessionDir!, 'main.json');
    expect(existsSync(sessionFile)).toBe(true);
    
    // 验证文件内容
    const content = readFileSync(sessionFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe(session.id);
    expect(parsed.projectPath).toBe(TEST_PROJECT_PATH);
  });

  it('can restore session from disk', () => {
    const manager = new SessionManager();
    
    // 创建会话
    const session = manager.createSession(TEST_PROJECT_PATH, 'Test Restore Session');

    // 创建新的 manager 实例来测试恢复
    const manager2 = new SessionManager();
    const restored = manager2.getSession(session.id);
    
    expect(restored).toBeDefined();
    expect(restored?.id).toBe(session.id);
    expect(restored?.projectPath).toBe(TEST_PROJECT_PATH);
  });

  it('persists session snapshot messages across restart', async () => {
    const manager = new SessionManager();
    const session = manager.createSession(TEST_PROJECT_PATH, 'Snapshot Persist Session');

    const appendResult = await manager.addMessage(session.id, 'user', 'hello snapshot');
    expect(appendResult).not.toBeNull();

    const manager2 = new SessionManager();
    const messages = manager2.getMessages(session.id, 10);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[messages.length - 1]?.content).toBe('hello snapshot');
  });
});
