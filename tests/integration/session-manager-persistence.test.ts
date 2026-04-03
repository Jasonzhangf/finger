import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, existsSync, readFileSync, mkdirSync, realpathSync, readdirSync, writeFileSync } from 'fs';
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
    expect(normalizePathForAssert(session.projectPath)).toBe(normalizePathForAssert(TEST_PROJECT_PATH));
    
    // 验证文件是否被创建
    const sessionDir = manager.resolveSessionStorageDir(session.id);
    expect(sessionDir).not.toBeNull();
    
    const sessionFile = join(sessionDir!, 'main.json');
    expect(existsSync(sessionFile)).toBe(true);
    
    // 验证文件内容
    const content = readFileSync(sessionFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe(session.id);
    expect(normalizePathForAssert(parsed.projectPath)).toBe(normalizePathForAssert(TEST_PROJECT_PATH));
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
    expect(normalizePathForAssert(restored?.projectPath ?? '')).toBe(normalizePathForAssert(TEST_PROJECT_PATH));
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

  it('writes session json atomically (no lingering .tmp file)', () => {
    const manager = new SessionManager();
    const session = manager.createSession(TEST_PROJECT_PATH, 'Atomic Persist Session');
    manager.updateContext(session.id, {
      smoke: 'atomic-write',
    });
    const sessionDir = manager.resolveSessionStorageDir(session.id);
    expect(sessionDir).not.toBeNull();
    const files = readdirSync(sessionDir!);
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(files.some((name) => name === 'main.json')).toBe(true);
  });

  it('quarantines corrupted session json and continues loading', () => {
    const manager = new SessionManager();
    const session = manager.createSession(TEST_PROJECT_PATH, 'Corrupt Session');
    const sessionDir = manager.resolveSessionStorageDir(session.id);
    expect(sessionDir).not.toBeNull();
    const sessionFile = join(sessionDir!, 'main.json');
    writeFileSync(sessionFile, '{\"id\":\"broken\"', 'utf-8');

    const managerAfterCorrupt = new SessionManager();
    const files = readdirSync(sessionDir!);
    expect(files.some((name) => name.includes('.corrupt-'))).toBe(true);
    // manager should stay functional and create new sessions after quarantine
    const newSession = managerAfterCorrupt.createSession(TEST_PROJECT_PATH, 'Post Corrupt Session');
    expect(newSession.id).toBeDefined();
  });

  it('does not recursively re-quarantine already quarantined files', () => {
    const manager = new SessionManager();
    const session = manager.createSession(TEST_PROJECT_PATH, 'Repeat Corrupt Session');
    const sessionDir = manager.resolveSessionStorageDir(session.id);
    expect(sessionDir).not.toBeNull();
    const sessionFile = join(sessionDir!, 'main.json');
    writeFileSync(sessionFile, '{\"id\":\"broken\"', 'utf-8');

    // First restart: quarantine main.json
    new SessionManager();
    const firstPassFiles = readdirSync(sessionDir!);
    const firstCorrupt = firstPassFiles.filter((name) => name.includes('.corrupt-'));
    expect(firstCorrupt.length).toBeGreaterThan(0);

    // Second restart: should ignore quarantined files, not keep renaming/growing.
    new SessionManager();
    const secondPassFiles = readdirSync(sessionDir!);
    const secondCorrupt = secondPassFiles.filter((name) => name.includes('.corrupt-'));
    expect(secondCorrupt.length).toBe(firstCorrupt.length);
    expect(secondCorrupt.every((name) => name.match(/\.corrupt-/g)?.length === 1)).toBe(true);
  });
});
  const normalizePathForAssert = (input: string): string => {
    try {
      return realpathSync(input);
    } catch {
      return input;
    }
  };
