import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, existsSync, readFileSync, mkdirSync, realpathSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SessionManager } from '../../src/orchestration/session-manager.js';
import { FINGER_PATHS } from '../../src/core/finger-paths.js';
import { resolveBaseDir } from '../../src/runtime/context-ledger-memory-helpers.js';

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
    expect(systemSessionsDir).toContain(join('system', 'sessions'));
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

  it('keeps project-root sessions out of system session storage even when owned by finger-system-agent', () => {
    const manager = new SessionManager();
    const projectPath = `/tmp/project-root-owned-by-system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(projectPath, { recursive: true });

    const session = manager.createSession(projectPath, 'Project Root Session', { allowReuse: false });
    const sessionDir = manager.resolveSessionStorageDir(session.id);

    expect(sessionDir).not.toBeNull();
    expect(sessionDir?.startsWith(join(FINGER_PATHS.home, 'system', 'sessions'))).toBe(false);
    expect(sessionDir?.startsWith(FINGER_PATHS.sessions.dir)).toBe(true);

    const persisted = JSON.parse(readFileSync(join(sessionDir!, 'main.json'), 'utf-8'));
    expect(normalizePathForAssert(persisted.projectPath)).toBe(normalizePathForAssert(projectPath));
    expect(persisted.context.ownerAgentId).toBe('finger-system-agent');
    expect(persisted.context.memoryOwnerWorkerId).toBe('finger-system-agent');
  });

  it('migrates legacy project sessions out of system storage during startup load', () => {
    const projectPath = `/tmp/legacy-project-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(projectPath, { recursive: true });
    const sessionId = `session-legacy-migrate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const legacySystemDir = join(FINGER_PATHS.home, 'system', 'sessions', sessionId);
    mkdirSync(legacySystemDir, { recursive: true });
    const legacyFile = join(legacySystemDir, 'main.json');
    writeFileSync(legacyFile, JSON.stringify({
      id: sessionId,
      name: 'Legacy Misclassified Session',
      projectPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      messages: [],
      activeWorkflows: [],
      context: {
        ownerAgentId: 'finger-system-agent',
        memoryOwnerWorkerId: 'finger-system-agent',
      },
      latestCompactIndex: -1,
      originalStartIndex: 0,
      originalEndIndex: 0,
      totalTokens: 0,
      pointers: {
        contextHistory: { startLine: 0, endLine: -1, estimatedTokens: 0 },
        currentHistory: { startLine: 0, endLine: -1, estimatedTokens: 0 },
      },
    }, null, 2), 'utf-8');

    const reloaded = new SessionManager();
    const restored = reloaded.getSession(sessionId);
    expect(restored).toBeDefined();

    const migratedDir = reloaded.resolveSessionStorageDir(sessionId);
    expect(migratedDir).not.toBeNull();
    expect(migratedDir?.startsWith(join(FINGER_PATHS.home, 'system', 'sessions'))).toBe(false);
    expect(existsSync(join(migratedDir!, 'main.json'))).toBe(true);
    expect(existsSync(legacyFile)).toBe(false);
  });

  it('backfills worker-owned memory fields for legacy session data on startup', () => {
    const manager = new SessionManager();
    const session = manager.createSession(TEST_PROJECT_PATH, 'Legacy Ownership Session');

    const sessionDir = manager.resolveSessionStorageDir(session.id);
    expect(sessionDir).not.toBeNull();
    const sessionFile = join(sessionDir!, 'main.json');
    expect(existsSync(sessionFile)).toBe(true);

    const legacy = JSON.parse(readFileSync(sessionFile, 'utf-8'));
    if (legacy.context && typeof legacy.context === 'object') {
      delete legacy.context.ownerAgentId;
      delete legacy.context.memoryOwnerWorkerId;
      delete legacy.context.memoryOwnershipVersion;
      delete legacy.context.memoryAccessPolicy;
      delete legacy.context.memoryOwnershipUpdatedAt;
    }
    writeFileSync(sessionFile, JSON.stringify(legacy, null, 2), 'utf-8');

    const managerReloaded = new SessionManager();
    const restored = managerReloaded.getSession(session.id);
    expect(restored).toBeDefined();
    expect((restored?.context as Record<string, unknown>).memoryOwnerWorkerId).toBe('finger-system-agent');
    expect((restored?.context as Record<string, unknown>).memoryOwnershipVersion).toBe(1);
    expect((restored?.context as Record<string, unknown>).memoryAccessPolicy).toBe('owner_write_shared_read');

    const migrated = JSON.parse(readFileSync(sessionFile, 'utf-8'));
    expect(migrated.context.memoryOwnerWorkerId).toBe('finger-system-agent');
    expect(migrated.context.memoryOwnershipVersion).toBe(1);
    expect(migrated.context.memoryAccessPolicy).toBe('owner_write_shared_read');
  });

  it('backfills missing owner for legacy root session main.json to system owner', () => {
    const manager = new SessionManager();
    const session = manager.createSession(TEST_PROJECT_PATH, 'Legacy Root Ownership Session');

    const sessionDir = manager.resolveSessionStorageDir(session.id);
    expect(sessionDir).not.toBeNull();
    const mainFile = join(sessionDir!, 'main.json');
    expect(existsSync(mainFile)).toBe(true);

    const legacy = JSON.parse(readFileSync(mainFile, 'utf-8'));
    if (legacy.context && typeof legacy.context === 'object') {
      delete legacy.context.ownerAgentId;
      delete legacy.context.memoryOwnerWorkerId;
      delete legacy.context.memoryOwnershipVersion;
      delete legacy.context.memoryAccessPolicy;
      delete legacy.context.memoryOwnershipUpdatedAt;
      delete legacy.context.sessionTier;
    }
    writeFileSync(mainFile, JSON.stringify(legacy, null, 2), 'utf-8');

    const managerReloaded = new SessionManager();
    const restored = managerReloaded.getSession(session.id);
    expect(restored).toBeDefined();
    expect((restored?.context as Record<string, unknown>).memoryOwnerWorkerId).toBe('finger-system-agent');
    expect((restored?.context as Record<string, unknown>).ownerAgentId).toBe('finger-system-agent');
    expect((restored?.context as Record<string, unknown>).memoryOwnershipVersion).toBe(1);
    expect((restored?.context as Record<string, unknown>).memoryAccessPolicy).toBe('owner_write_shared_read');
  });

  it('backfills missing activeWorkflows for legacy session json on startup', () => {
    const manager = new SessionManager();
    const session = manager.createSession(TEST_PROJECT_PATH, 'Legacy ActiveWorkflows Session');

    const sessionDir = manager.resolveSessionStorageDir(session.id);
    expect(sessionDir).not.toBeNull();
    const mainFile = join(sessionDir!, 'main.json');
    expect(existsSync(mainFile)).toBe(true);

    const legacy = JSON.parse(readFileSync(mainFile, 'utf-8'));
    delete legacy.activeWorkflows;
    writeFileSync(mainFile, JSON.stringify(legacy, null, 2), 'utf-8');

    expect(() => new SessionManager()).not.toThrow();
    const reloaded = new SessionManager();
    const restored = reloaded.getSession(session.id);

    expect(restored).toBeDefined();
    expect(restored?.activeWorkflows).toEqual([]);

    const migrated = JSON.parse(readFileSync(mainFile, 'utf-8'));
    expect(migrated.activeWorkflows).toEqual([]);
  });

  it('syncs compact projection from ledger immediately after digest append', async () => {
    const manager = new SessionManager();
    const session = manager.createSession(TEST_PROJECT_PATH, 'Ledger Projection Sync Session');

    await manager.addMessage(session.id, 'user', 'first live compact message');
    await manager.addMessage(session.id, 'assistant', 'second live compact message');

    await manager.appendDigest(
      session.id,
      {
        id: 'digest-source-msg',
        role: 'assistant',
        content: '<task_digest>{\"task_id\":\"ledger-sync-test\",\"tags\":[\"compact\"],\"topic\":\"ledger\"}</task_digest>',
        timestamp: new Date().toISOString(),
      },
      ['compact'],
      'finger-system-agent',
      'main',
    );

    const syncResult = await manager.syncProjectionFromLedger(session.id, {
      agentId: 'finger-system-agent',
      mode: 'main',
      source: 'test_ledger_sync',
    });

    expect(syncResult.applied).toBe(true);
    expect((syncResult.latestCompactIndex ?? -1)).toBeGreaterThanOrEqual(0);

    const restored = manager.getSession(session.id);
    expect(restored).toBeDefined();
    expect((restored?.latestCompactIndex ?? -1)).toBeGreaterThanOrEqual(0);
    expect((restored?.totalTokens ?? 0)).toBeGreaterThan(0);
    expect(((restored?.context as Record<string, unknown>)?.kernelProjection as Record<string, unknown>)?.compactApplied).toBe(true);

    const sessionDir = manager.resolveSessionStorageDir(session.id);
    expect(sessionDir).not.toBeNull();
    const mainFile = join(sessionDir!, 'main.json');
    const persisted = JSON.parse(readFileSync(mainFile, 'utf-8'));
    expect(persisted.latestCompactIndex).toBeGreaterThanOrEqual(0);
    expect(persisted.context.kernelProjection.compactApplied).toBe(true);
  });

  it('normalizes kernel compact projection into historical prefix and current suffix', () => {
    const manager = new SessionManager();
    const projectPath = `/tmp/kernel-projection-normalize-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(projectPath, { recursive: true });
    const session = manager.createSession(projectPath, 'Kernel Projection Normalize Session', { allowReuse: false });
    manager.updateContext(session.id, { ownerAgentId: 'finger-system-agent' });

    const ledgerRoot = manager.resolveLedgerRootForSession(session.id);
    expect(ledgerRoot).not.toBeNull();
    const compactDir = resolveBaseDir(ledgerRoot!, session.id, 'finger-system-agent', 'main');
    mkdirSync(compactDir, { recursive: true });
    writeFileSync(
      join(compactDir, 'compact-memory.jsonl'),
      `${JSON.stringify({
        id: 'compact-normalize-1',
        timestamp_ms: Date.now(),
        timestamp_iso: new Date().toISOString(),
        session_id: session.id,
        agent_id: 'finger-system-agent',
        mode: 'main',
        payload: {
          algorithm: 'task_digest_v2',
          summary: 'kernel normalize summary',
          replacement_history: [
            { task_id: 'hist-1', summary: 'history 1' },
            { task_id: 'hist-2', summary: 'history 2' },
          ],
        },
      })}\n`,
      'utf-8',
    );

    const syncResult = manager.syncProjectionFromKernelMetadata(session.id, {
      compact: {
        applied: true,
        summary: 'kernel normalize summary',
      },
      api_history: [
        {
          id: '',
          role: 'user',
          timestamp_iso: '2026-04-09T12:00:00.000Z',
          content: [{ type: 'input_text', text: '<environment_context>cwd=/tmp/test-project</environment_context>' }],
        },
        {
          id: 'hist-1',
          role: 'assistant',
          timestamp_iso: '2026-04-09T12:00:01.000Z',
          content: [{ type: 'output_text', text: '<task_digest>{"task_id":"hist-1","summary":"history 1"}</task_digest>' }],
        },
        {
          id: 'hist-2',
          role: 'assistant',
          timestamp_iso: '2026-04-09T12:00:02.000Z',
          content: [{ type: 'output_text', text: '<task_digest>{"task_id":"hist-2","summary":"history 2"}</task_digest>' }],
        },
        {
          id: 'current-user',
          role: 'user',
          timestamp_iso: '2026-04-09T12:00:03.000Z',
          content: [{ type: 'input_text', text: 'continue after compact' }],
        },
        {
          id: 'current-assistant',
          role: 'assistant',
          timestamp_iso: '2026-04-09T12:00:04.000Z',
          content: [{ type: 'output_text', text: 'final reply' }],
        },
      ],
    }, {
      agentId: 'finger-system-agent',
      mode: 'main',
    });

    expect(syncResult.applied).toBe(true);
    expect(syncResult.latestCompactIndex).toBe(0);

    const restored = manager.getSession(session.id);
    expect(restored).toBeDefined();
    expect(restored?.messages.slice(0, 2).map((message) => message.id)).toEqual(['hist-1', 'hist-2']);
    expect(restored?.messages.map((message) => message.id.trim().length > 0)).toEqual([true, true, true, true, true]);
    expect(restored?.messages.map((message) => message.content)).toEqual([
      '<task_digest>{"task_id":"hist-1","summary":"history 1"}</task_digest>',
      '<task_digest>{"task_id":"hist-2","summary":"history 2"}</task_digest>',
      '<environment_context>cwd=/tmp/test-project</environment_context>',
      'continue after compact',
      'final reply',
    ]);
    expect(restored?.messages.slice(0, 2).every((message) => message.metadata?.contextZone === 'historical_memory')).toBe(true);
    expect(restored?.messages.slice(2).every((message) => message.metadata?.contextZone === 'current_history')).toBe(true);
    expect(restored?.pointers?.contextHistory.endLine).toBe(1);
    expect(restored?.pointers?.currentHistory.startLine).toBe(2);

    const reloaded = new SessionManager();
    const persisted = reloaded.getSession(session.id);
    expect(persisted?.messages.map((message) => message.id.trim().length > 0)).toEqual([true, true, true, true, true]);
    expect(persisted?.messages.map((message) => message.content)).toEqual([
      '<task_digest>{"task_id":"hist-1","summary":"history 1"}</task_digest>',
      '<task_digest>{"task_id":"hist-2","summary":"history 2"}</task_digest>',
      '<environment_context>cwd=/tmp/test-project</environment_context>',
      'continue after compact',
      'final reply',
    ]);
    expect(persisted?.pointers?.contextHistory.endLine).toBe(1);
    expect(persisted?.pointers?.currentHistory.startLine).toBe(2);
  });

  it('repairs stale compacted projection on startup load', async () => {
    const manager = new SessionManager();
    const session = manager.createSession(TEST_PROJECT_PATH, 'Startup Projection Repair Session');

    await manager.addMessage(session.id, 'user', 'startup repair user message');
    await manager.addMessage(session.id, 'assistant', 'startup repair assistant message');
    await manager.appendDigest(
      session.id,
      {
        id: 'startup-repair-digest',
        role: 'assistant',
        content: '<task_digest>{\"task_id\":\"startup-repair\",\"tags\":[\"repair\"],\"topic\":\"startup\"}</task_digest>',
        timestamp: new Date().toISOString(),
      },
      ['repair'],
      'finger-system-agent',
      'main',
    );

    const sessionDir = manager.resolveSessionStorageDir(session.id);
    expect(sessionDir).not.toBeNull();
    const mainFile = join(sessionDir!, 'main.json');
    const stale = JSON.parse(readFileSync(mainFile, 'utf-8'));
    stale.latestCompactIndex = -1;
    stale.totalTokens = 300000;
    stale.context = stale.context || {};
    delete stale.context.kernelProjection;
    writeFileSync(mainFile, JSON.stringify(stale, null, 2), 'utf-8');

    const reloaded = new SessionManager();
    const repaired = reloaded.getSession(session.id);
    expect(repaired).toBeDefined();
    expect((repaired?.latestCompactIndex ?? -1)).toBeGreaterThanOrEqual(0);
    expect((repaired?.totalTokens ?? 0)).toBeGreaterThan(0);
    expect(((repaired?.context as Record<string, unknown>)?.kernelProjection as Record<string, unknown>)?.compactApplied).toBe(true);
    expect(((repaired?.context as Record<string, unknown>)?.kernelProjection as Record<string, unknown>)?.source).toBe('startup_ledger_projection_repair');

    const persisted = JSON.parse(readFileSync(mainFile, 'utf-8'));
    expect(persisted.latestCompactIndex).toBeGreaterThanOrEqual(0);
    expect(persisted.context.kernelProjection.compactApplied).toBe(true);
    expect(persisted.context.kernelProjection.source).toBe('startup_ledger_projection_repair');
  });

  it('repairs mixed compact projection ordering on startup load', () => {
    const manager = new SessionManager();
    const projectPath = `/tmp/startup-order-repair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(projectPath, { recursive: true });
    const session = manager.createSession(projectPath, 'Startup Projection Order Repair Session', { allowReuse: false });

    const sessionDir = manager.resolveSessionStorageDir(session.id);
    expect(sessionDir).not.toBeNull();
    const mainFile = join(sessionDir!, 'main.json');
    const stale = JSON.parse(readFileSync(mainFile, 'utf-8'));
    stale.latestCompactIndex = 1;
    stale.totalTokens = 999999;
    stale.messages = [
      {
        id: '',
        role: 'user',
        content: '<environment_context>cwd=/tmp/test-project</environment_context>',
        timestamp: '2026-04-09T12:10:00.000Z',
        metadata: { contextZone: 'current_history' },
      },
      {
        id: 'hist-1',
        role: 'assistant',
        content: '<task_digest>{"task_id":"hist-1","summary":"history 1"}</task_digest>',
        timestamp: '2026-04-09T12:10:01.000Z',
        metadata: { contextZone: 'historical_memory', compactDigest: true },
      },
      {
        id: 'hist-2',
        role: 'assistant',
        content: '<task_digest>{"task_id":"hist-2","summary":"history 2"}</task_digest>',
        timestamp: '2026-04-09T12:10:02.000Z',
        metadata: { contextZone: 'historical_memory', compactDigest: true },
      },
      {
        id: 'current-user',
        role: 'user',
        content: 'continue after compact',
        timestamp: '2026-04-09T12:10:03.000Z',
      },
    ];
    stale.pointers = {
      contextHistory: { startLine: 0, endLine: -1, estimatedTokens: 0 },
      currentHistory: { startLine: 0, endLine: 3, estimatedTokens: 0 },
    };
    stale.context = stale.context || {};
    stale.context.kernelProjection = {
      version: 1,
      source: 'rust_kernel_api_history',
      compactApplied: true,
    };
    writeFileSync(mainFile, JSON.stringify(stale, null, 2), 'utf-8');

    const reloaded = new SessionManager();
    const repaired = reloaded.getSession(session.id);

    expect(repaired).toBeDefined();
    expect(repaired?.messages.map((message) => message.id.trim().length > 0)).toEqual([true, true, true, true]);
    expect(repaired?.messages.map((message) => message.content)).toEqual([
      '<task_digest>{"task_id":"hist-1","summary":"history 1"}</task_digest>',
      '<task_digest>{"task_id":"hist-2","summary":"history 2"}</task_digest>',
      '<environment_context>cwd=/tmp/test-project</environment_context>',
      'continue after compact',
    ]);
    expect(repaired?.messages.slice(0, 2).every((message) => message.metadata?.contextZone === 'historical_memory')).toBe(true);
    expect(repaired?.messages.slice(2).every((message) => message.metadata?.contextZone === 'current_history')).toBe(true);
    expect(repaired?.pointers?.contextHistory.endLine).toBe(1);
    expect(repaired?.pointers?.currentHistory.startLine).toBe(2);
    expect((repaired?.totalTokens ?? 0)).toBeGreaterThan(0);
    expect((repaired?.totalTokens ?? 0)).toBeLessThan(999999);

    const persisted = JSON.parse(readFileSync(mainFile, 'utf-8'));
    expect(persisted.messages.map((message: { id: string }) => message.id.trim().length > 0)).toEqual([true, true, true, true]);
    expect(persisted.messages.map((message: { content: string }) => message.content)).toEqual([
      '<task_digest>{"task_id":"hist-1","summary":"history 1"}</task_digest>',
      '<task_digest>{"task_id":"hist-2","summary":"history 2"}</task_digest>',
      '<environment_context>cwd=/tmp/test-project</environment_context>',
      'continue after compact',
    ]);
    expect(persisted.pointers.contextHistory.endLine).toBe(1);
    expect(persisted.pointers.currentHistory.startLine).toBe(2);
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
