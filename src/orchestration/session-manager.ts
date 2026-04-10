/**
 * Session Manager - 会话管理
 * 负责会话创建、恢复、隔离、上下文压缩
 *
 * Ledger-Session 一体化架构：
 * - Ledger (context-ledger.jsonl) 负责 append-only 持久化
 * - Session messages 是运行时消费的会话快照（projection）
 * - 写入顺序：先 Ledger，再同步更新 Session snapshot
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
 import { FINGER_PATHS, ensureDir, normalizeSessionDirName } from '../core/finger-paths.js';
import { Session, SessionMessage, LEDGER_POINTER_DEFAULTS, ensureLedgerPointers, ISessionManager, SessionStatus } from './session-types.js';
import type { Attachment } from '../runtime/events.js';
import type { UpdateSessionParams, SessionQuery, SessionStats } from './session-types.js';
import { appendSessionMessage } from '../runtime/ledger-writer.js';
import { resolveBaseDir } from '../runtime/context-ledger-memory-helpers.js';
import { buildSessionView, type SessionView, type SessionViewMessage } from '../runtime/ledger-reader.js';
import { appendDigestForTurn } from '../runtime/context-history-compact.js';
import { createRustKernelCompactionError } from '../runtime/kernel-owned-compaction.js';
import { estimateTokens } from '../utils/token-counter.js';
import { getContextWindow } from '../core/user-settings.js';
import { loadContextBuilderSettings } from '../core/user-settings.js';
import { buildContext } from '../runtime/context-builder.js';
import { logger } from '../core/logger.js';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';
import { inferTagsAndTopic } from '../common/tag-topic-inference.js';
import { pruneOrphanSessionRootDirs } from '../core/runtime-hygiene.js';
import { normalizeProjectPathCanonical } from '../common/path-normalize.js';
import { writeFileAtomicSync } from '../core/atomic-write.js';
import { isObjectRecord } from '../server/common/object.js';

const clog = createConsoleLikeLogger('SessionManager');

export { Session, SessionMessage } from './session-types.js';

const SESSIONS_DIR = FINGER_PATHS.sessions.dir;
const SYSTEM_SESSIONS_DIR = path.join(FINGER_PATHS.home, 'system', 'sessions');
const SYSTEM_PROJECT_PATH = path.join(FINGER_PATHS.home, 'system');
const SYSTEM_AGENT_ID = 'finger-system-agent';
const SYSTEM_SESSION_PREFIX = 'system-';
const ROOT_SESSION_FILE = 'main.json';
const MEMORY_OWNERSHIP_VERSION = 1;
const MEMORY_ACCESS_POLICY = 'owner_write_shared_read';

const log = logger.module('SessionManager');

function isCorruptSessionFileName(fileName: string): boolean {
  return /\.corrupt(?:[.-].*)?\.json$/i.test(fileName);
}

function stripCorruptSuffix(baseName: string): string {
  return baseName.replace(/\.corrupt(?:[.-].*)?$/i, '');
}

export class SessionManager implements ISessionManager {
  private sessions: Map<string, Session> = new Map();
  private sessionFilePaths: Map<string, string> = new Map();
  private currentSessionId: string | null = null;

  constructor() {
    this.ensureDirs();
    this.loadSessions({ autoResume: true });
  }

  private ensureDirs(): void {
    ensureDir(SESSIONS_DIR);
    ensureDir(SYSTEM_SESSIONS_DIR);
    pruneOrphanSessionRootDirs(SESSIONS_DIR);
    pruneOrphanSessionRootDirs(SYSTEM_SESSIONS_DIR);
  }

  private isSystemSessionId(sessionId: string): boolean {
    return sessionId.startsWith(SYSTEM_SESSION_PREFIX) || sessionId === 'system-default-session';
  }

  private isSystemSession(session: Session): boolean {
    const ctx = session.context ?? {};
    if (ctx.sessionTier === 'system') return true;
    if (session.projectPath === SYSTEM_PROJECT_PATH) return true;
    if (session.id.startsWith(SYSTEM_SESSION_PREFIX)) return true;
    return false;
  }

  private isHeartbeatControlSession(session: Session): boolean {
    const context = session.context ?? {};
    if (session.id.startsWith('hb-session-')) return true;
    if (context.sessionTier === 'heartbeat-control' || context.sessionTier === 'heartbeat') return true;
    if (typeof context.controlPath === 'string' && context.controlPath.trim().toLowerCase() === 'heartbeat') return true;
    if (context.controlSession === true) return true;
    if (context.userInputAllowed === false) return true;
    return false;
  }

  private getSystemSessionsDir(): string {
    return SYSTEM_SESSIONS_DIR;
  }

  private getProjectDirName(projectPath: string): string {
    const normalizedPath = this.normalizeProjectPath(projectPath).replace(/\\/g, '/');
    const encoded = normalizedPath.replace(/[/:]/g, '_');
    return encoded.length > 0 ? encoded : '_';
  }

  private getProjectSessionsDir(projectPath: string): string {
    if (projectPath === SYSTEM_PROJECT_PATH) {
      return SYSTEM_SESSIONS_DIR;
    }
    return path.join(SESSIONS_DIR, this.getProjectDirName(projectPath));
  }

  private resolveSessionsRoot(session: Session): string {
    if (this.isSystemSession(session)) {
      return SYSTEM_SESSIONS_DIR;
    }
    return this.getProjectSessionsDir(session.projectPath);
  }

  resolveLedgerRootForSession(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return this.resolveSessionsRoot(session);
  }

  private sanitizeFileComponent(value: string): string {
    const normalized = value.trim();
    if (!normalized) return 'unknown';
    return normalized.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private getRootSessionId(session: Session): string {
    const context = session.context ?? {};
    const root = typeof context.rootSessionId === 'string' ? context.rootSessionId : '';
    const parent = typeof context.parentSessionId === 'string' ? context.parentSessionId : '';
    const resolved = root || parent;
    return resolved || session.id;
  }

  private isRuntimeSession(session: Session): boolean {
    const context = session.context ?? {};
    return context.sessionTier === 'runtime'
      || typeof context.parentSessionId === 'string'
      || typeof context.rootSessionId === 'string';
  }

  private getSessionDir(session: Session): string {
    if (this.isSystemSession(session)) {
      const rootSessionId = this.getRootSessionId(session);
      return path.join(SYSTEM_SESSIONS_DIR, normalizeSessionDirName(rootSessionId));
    }
   const rootSessionId = this.getRootSessionId(session);
   return path.join(this.getProjectSessionsDir(session.projectPath), normalizeSessionDirName(rootSessionId));
  }

 resolveSessionStorageDir(sessionId: string): string | null {
   const session = this.sessions.get(sessionId);
   if (!session) return null;
    if (this.isSystemSession(session)) {
      const rootSessionId = this.getRootSessionId(session);
      return path.join(SYSTEM_SESSIONS_DIR, normalizeSessionDirName(rootSessionId));
    }
   const rootSessionId = this.getRootSessionId(session);
   return path.join(this.getProjectSessionsDir(session.projectPath), normalizeSessionDirName(rootSessionId));
  }

  resolveSessionWorkspaceRoot(sessionId: string): string | null {
    const dir = this.resolveSessionStorageDir(sessionId);
    if (!dir) return null;
    return path.join(dir, 'workspace');
  }

  private getSessionFileName(session: Session): string {
    if (this.isRuntimeSession(session)) {
      const context = session.context ?? {};
      const ownerAgentId = typeof context.ownerAgentId === 'string' ? context.ownerAgentId : '';
      if (ownerAgentId) {
        return `agent-${this.sanitizeFileComponent(ownerAgentId)}.json`;
      }
    }
    return ROOT_SESSION_FILE;
  }

  private getSessionPath(session: Session): string {
    return path.join(this.getSessionDir(session), this.getSessionFileName(session));
  }

  private inferOwnerFromSessionFilePath(filePath: string): string {
    const base = path.basename(filePath);
    const match = base.match(/^agent-(.+)\.json$/);
    if (!match) return '';
    return match[1]?.trim() ?? '';
  }

  private loadSessionFile(filePath: string): void {
    const content = fs.readFileSync(filePath, 'utf-8');
    let session: Session;
    try {
      session = JSON.parse(content) as Session;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.quarantineCorruptedSessionFile(filePath, error);
      throw new Error(`Corrupted session file quarantined: ${filePath}`);
    }
    if (!session.id || !session.projectPath) {
      throw new Error('Invalid session content');
    }
    session.projectPath = this.normalizeProjectPath(session.projectPath);
    // Ensure ledger pointer fields exist for backward compatibility
    ensureLedgerPointers(session);
    session.messages = Array.isArray(session.messages) ? session.messages : [];
    const activeWorkflowsNormalized = this.normalizeActiveWorkflows(session);
    const ownershipNormalized = this.normalizeSessionOwnershipContext(session, session.context, {
      sourceFilePath: filePath,
    });
    session.context = ownershipNormalized.context;
    const staleProjectionRepaired = this.repairStaleCompactedProjectionOnLoad(session);
    const compactedProjectionRepaired = this.repairCompactedProjectionStructureOnLoad(session);
    this.updateSessionProjectionState(session);
    delete (session as Session & { _cachedView?: unknown })._cachedView;
    this.sessions.set(session.id, session);
    this.sessionFilePaths.set(session.id, filePath);
    const expectedPath = this.getSessionPath(session);
    const storagePathChanged = path.resolve(expectedPath) !== path.resolve(filePath);
    if (storagePathChanged) {
      this.saveSession(session);
      log.info('[SessionManager] Migrated session file to canonical storage path during load', {
        sessionId: session.id,
        previousPath: filePath,
        nextPath: expectedPath,
      });
      return;
    }
    if (ownershipNormalized.migrated || activeWorkflowsNormalized || staleProjectionRepaired || compactedProjectionRepaired) {
      this.persistMigratedSessionFile(filePath, session);
    }
  }

  private asContextString(context: Record<string, unknown>, key: string): string {
    const value = context[key];
    return typeof value === 'string' ? value.trim() : '';
  }

  private resolveSessionMemoryOwner(
    session: Session,
    context: Record<string, unknown>,
    options?: { sourceFilePath?: string },
  ): string {
    const explicitOwner = this.asContextString(context, 'memoryOwnerWorkerId')
      || this.asContextString(context, 'memory_owner_worker_id');
    if (explicitOwner) return explicitOwner;

    const ownerFromFile = this.inferOwnerFromSessionFilePath(options?.sourceFilePath ?? '');
    if (ownerFromFile) return ownerFromFile;

    const ownerAgentId = this.asContextString(context, 'ownerAgentId');
    if (ownerAgentId) return ownerAgentId;

    const dispatchWorkerId = this.asContextString(context, 'dispatchWorkerId');
    if (dispatchWorkerId) return dispatchWorkerId;

    const dispatchTargetAgentId = this.asContextString(context, 'dispatchTargetAgentId');
    if (dispatchTargetAgentId) return dispatchTargetAgentId;

    const sessionTier = this.asContextString(context, 'sessionTier').toLowerCase();
    if (
      session.id.startsWith('review-')
      || sessionTier === 'system'
    ) {
      return SYSTEM_AGENT_ID;
    }

    if (
      session.id.startsWith(SYSTEM_SESSION_PREFIX)
      || sessionTier === 'system'
      || sessionTier === 'orchestrator-root'
      || sessionTier === 'orchestrator'
      || session.projectPath === SYSTEM_PROJECT_PATH
    ) {
      return SYSTEM_AGENT_ID;
    }

    return SYSTEM_AGENT_ID;
  }

  private normalizeSessionOwnershipContext(
    session: Session,
    rawContext: Record<string, unknown> | undefined,
    options?: { sourceFilePath?: string },
  ): { context: Record<string, unknown>; migrated: boolean } {
    const context = isObjectRecord(rawContext) ? { ...rawContext } : {};
    let migrated = false;

    const owner = this.resolveSessionMemoryOwner(session, context, options);
    const currentOwner = this.asContextString(context, 'memoryOwnerWorkerId');
    if (owner && currentOwner !== owner) {
      context.memoryOwnerWorkerId = owner;
      migrated = true;
    }

    const currentOwnerAgentId = this.asContextString(context, 'ownerAgentId');
    if (owner && !currentOwnerAgentId) {
      context.ownerAgentId = owner;
      migrated = true;
    }

    if (!('memoryAccessPolicy' in context)) {
      context.memoryAccessPolicy = MEMORY_ACCESS_POLICY;
      migrated = true;
    }

    const schemaVersion = context.memoryOwnershipVersion;
    if (schemaVersion !== MEMORY_OWNERSHIP_VERSION) {
      context.memoryOwnershipVersion = MEMORY_OWNERSHIP_VERSION;
      migrated = true;
    }

    if (migrated) {
      context.memoryOwnershipUpdatedAt = new Date().toISOString();
    }

    return { context, migrated };
  }

  private persistMigratedSessionFile(filePath: string, session: Session): void {
    try {
      const persistedSession: Session = { ...session };
      delete (persistedSession as Session & { _cachedView?: unknown })._cachedView;
      writeFileAtomicSync(filePath, JSON.stringify(persistedSession, null, 2));
      log.debug('Backfilled session ownership metadata during load', {
        sessionId: session.id,
        filePath,
        memoryOwnerWorkerId: this.asContextString(session.context, 'memoryOwnerWorkerId') || undefined,
      });
    } catch (error) {
      log.warn('Failed to persist session ownership migration', {
        sessionId: session.id,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private normalizeProjectPath(projectPath: string): string {
    const normalized = normalizeProjectPathCanonical(projectPath);
    const marker = `${path.sep}.finger${path.sep}session${path.sep}`;
    const idx = normalized.indexOf(marker);
    if (idx > 0) {
      const candidate = normalized.slice(0, idx);
      return candidate || normalized;
    }
    return normalized;
  }

  private loadSessionsFromDir(dirPath: string): void {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessionDir = path.join(dirPath, entry.name);
        let sessionEntries: fs.Dirent[] = [];
        try {
          sessionEntries = fs.readdirSync(sessionDir, { withFileTypes: true });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            continue;
          }
          throw error;
        }
        for (const sessionEntry of sessionEntries) {
          if (!sessionEntry.isFile() || !sessionEntry.name.endsWith('.json')) continue;
          if (isCorruptSessionFileName(sessionEntry.name)) continue;
          const filePath = path.join(sessionDir, sessionEntry.name);
          try {
            this.loadSessionFile(filePath);
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            if (error.message.includes('Unexpected end of JSON input')
              || error.message.includes('Corrupted session file quarantined')) {
              clog.warn('[SessionManager] Skipped truncated/corrupted session file during startup', {
                filePath,
                reason: error.message,
              });
              continue;
            }
            clog.error(`[SessionManager] Failed to load session ${filePath}:`, error);
          }
        }
        continue;
      }
      // Backward compatibility: legacy flat session files.
      if (entry.isFile() && entry.name.endsWith('.json')) {
        if (isCorruptSessionFileName(entry.name)) continue;
        const filePath = path.join(dirPath, entry.name);
        try {
          this.loadSessionFile(filePath);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (error.message.includes('Unexpected end of JSON input')
            || error.message.includes('Corrupted session file quarantined')) {
            clog.warn('[SessionManager] Skipped truncated/corrupted legacy session file during startup', {
              filePath,
              reason: error.message,
            });
            continue;
          }
          clog.error(`[SessionManager] Failed to load session ${filePath}:`, error);
        }
      }
    }
  }

  private loadSessions(options?: { autoResume?: boolean; preserveCurrentId?: string | null }): void {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        this.loadSessionsFromDir(path.join(SESSIONS_DIR, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.json')) {
        if (isCorruptSessionFileName(entry.name)) continue;
        const legacyFilePath = path.join(SESSIONS_DIR, entry.name);
        try {
          this.loadSessionFile(legacyFilePath);
        } catch (err) {
          clog.error(`[SessionManager] Failed to load legacy session ${legacyFilePath}:`, err);
        }
      }
    }

    if (fs.existsSync(SYSTEM_SESSIONS_DIR)) {
      const systemEntries = fs.readdirSync(SYSTEM_SESSIONS_DIR, { withFileTypes: true });
      for (const entry of systemEntries) {
        if (entry.isDirectory()) {
          this.loadSessionsFromDir(path.join(SYSTEM_SESSIONS_DIR, entry.name));
        }
      }
    }

    this.cleanupEmptySessionsAcrossProjects();

    const preserveId = options?.preserveCurrentId ?? null;
    if (preserveId && this.sessions.has(preserveId)) {
      this.setCurrentSession(preserveId);
      return;
    }

    if (options?.autoResume === false) {
      this.currentSessionId = null;
      return;
    }

    const sorted = this.listRootSessions().sort(
      (a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()
    );
    if (sorted.length > 0 && this.setCurrentSession(sorted[0].id)) {
      log.info('Auto-resumed session: ${sorted[0].name}', { "sorted[0].name": sorted[0].name });
    }
  }

  private saveSession(session: Session): void {
    session.updatedAt = new Date().toISOString();
    if (!Array.isArray(session.messages)) {
      session.messages = [];
    }
    this.normalizeActiveWorkflows(session);
    this.updateSessionProjectionState(session);
    const sessionDir = this.getSessionDir(session);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const filePath = this.getSessionPath(session);
    const persistedSession: Session = { ...session };
    delete (persistedSession as Session & { _cachedView?: unknown })._cachedView;
    writeFileAtomicSync(filePath, JSON.stringify(persistedSession, null, 2));

    const previousPath = this.sessionFilePaths.get(session.id);
    if (previousPath && previousPath !== filePath && fs.existsSync(previousPath)) {
      fs.unlinkSync(previousPath);
      const previousDir = path.dirname(previousPath);
      if (previousDir !== SESSIONS_DIR && fs.existsSync(previousDir) && fs.readdirSync(previousDir).length === 0) {
        fs.rmdirSync(previousDir);
      }
    }
    this.sessionFilePaths.set(session.id, filePath);
  }

  private quarantineCorruptedSessionFile(filePath: string, error: Error): void {
    try {
      const originalName = path.basename(filePath);
      if (isCorruptSessionFileName(originalName)) {
        clog.error(`[SessionManager] Corrupted quarantined session ignored: ${filePath}`, error);
        return;
      }
      const dir = path.dirname(filePath);
      const base = stripCorruptSuffix(path.basename(filePath, '.json')).slice(0, 64) || 'session';
      const pathHash = createHash('sha1').update(filePath).digest('hex').slice(0, 8);
      const quarantineName = `${base}.corrupt-${pathHash}-${Date.now()}.json`;
      const quarantinePath = path.join(dir, quarantineName);
      fs.renameSync(filePath, quarantinePath);
      clog.error(`[SessionManager] Corrupted session file quarantined: ${filePath} -> ${quarantinePath}`, error);
      return;
    } catch (moveErr) {
      const moveError = moveErr instanceof Error ? moveErr : new Error(String(moveErr));
      clog.error(`[SessionManager] Failed to quarantine corrupted session file ${filePath}:`, moveError);
    }
  }

  private updateSessionProjectionState(session: Session): void {
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
    const context = (session.context ?? {}) as Record<string, unknown>;
    session.context = {
      ...context,
      sessionProjection: {
        version: 1,
        messageCount: messages.length,
        ...(last?.id ? { lastMessageId: last.id } : {}),
        ...(last?.timestamp ? { lastMessageAt: last.timestamp } : {}),
        updatedAt: new Date().toISOString(),
      },
    };
  }

  private normalizeActiveWorkflows(session: Session): boolean {
    const normalized = Array.isArray(session.activeWorkflows)
      ? session.activeWorkflows.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const previous = session.activeWorkflows;
    const changed = !Array.isArray(previous)
      || previous.length !== normalized.length
      || previous.some((item, index) => item !== normalized[index]);
    session.activeWorkflows = normalized;
    return changed;
  }

  private repairStaleCompactedProjectionOnLoad(session: Session): boolean {
    if (session.latestCompactIndex >= 0) return false;

    const sessionContext = isObjectRecord(session.context) ? session.context : {};
    const resolvedAgentId = typeof sessionContext.ownerAgentId === 'string' && sessionContext.ownerAgentId.trim().length > 0
      ? sessionContext.ownerAgentId.trim()
      : SYSTEM_AGENT_ID;
    const compactLineCount = this.readCompactMemoryLineCountSync(session, resolvedAgentId, 'main');
    if (compactLineCount <= 0) return false;

    const compactSummary = this.readLatestCompactSummarySync(session, resolvedAgentId, 'main');
    const ledgerMessages = this.readLedgerSessionMessagesSync(session, 0, resolvedAgentId);
    const projectedMessages: SessionMessage[] = [];

    if (compactSummary.length > 0) {
      projectedMessages.push({
        id: `startup-compact-${Date.now()}`,
        role: 'assistant',
        content: compactSummary,
        timestamp: new Date().toISOString(),
        metadata: buildKernelProjectionMessageMetadata(compactSummary),
      });
    }

    projectedMessages.push(
      ...ledgerMessages.map((message) => ({
        ...message,
        metadata: {
          ...buildKernelProjectionMessageMetadata(message.content),
          ...(isObjectRecord(message.metadata) ? message.metadata : {}),
        },
      })),
    );

    if (projectedMessages.length === 0) return false;

    const normalizedProjection = normalizeProjectionMessages(projectedMessages);
    const pointerState = buildProjectionPointerState(normalizedProjection.messages);
    const syncedAt = new Date().toISOString();
    session.messages = normalizedProjection.messages;
    session.latestCompactIndex = compactLineCount - 1;
    session.originalStartIndex = 0;
    session.originalEndIndex = normalizedProjection.messages.length > 0 ? normalizedProjection.messages.length - 1 : 0;
    session.totalTokens = pointerState.totalTokens;
    session.pointers = pointerState.pointers;
    session.lastAccessedAt = syncedAt;
    session.context = this.normalizeSessionOwnershipContext(session, {
      ...sessionContext,
      kernelProjection: {
        version: 1,
        source: 'startup_ledger_projection_repair',
        compactApplied: true,
        syncedAt,
        agentId: resolvedAgentId,
        mode: 'main',
        projectedMessageCount: projectedMessages.length,
        latestCompactIndex: compactLineCount - 1,
        ...(compactSummary.length > 0 ? { compactSummary } : {}),
      },
    }).context;
    session._cachedView = undefined;
    return true;
  }

  private repairCompactedProjectionStructureOnLoad(session: Session): boolean {
    const kernelProjection = isObjectRecord(session.context)
      ? isObjectRecord(session.context.kernelProjection)
        ? session.context.kernelProjection
        : {}
      : {};
    const compactApplied = kernelProjection.compactApplied === true || session.latestCompactIndex >= 0;
    const hasHistoricalMessages = Array.isArray(session.messages) && session.messages.some((message) => isHistoricalProjectionMessage(message));
    if (!compactApplied && !hasHistoricalMessages) {
      return false;
    }

    const normalizedProjection = normalizeProjectionMessages(Array.isArray(session.messages) ? session.messages : []);
    const pointerState = buildProjectionPointerState(normalizedProjection.messages);
    const pointersChanged = JSON.stringify(session.pointers ?? null) !== JSON.stringify(pointerState.pointers);
    const totalTokensChanged = session.totalTokens !== pointerState.totalTokens;
    const originalEndIndex = normalizedProjection.messages.length > 0 ? normalizedProjection.messages.length - 1 : 0;
    const originalWindowChanged = session.originalStartIndex !== 0 || session.originalEndIndex !== originalEndIndex;
    if (!normalizedProjection.changed && !pointersChanged && !totalTokensChanged && !originalWindowChanged) {
      return false;
    }

    session.messages = normalizedProjection.messages;
    session.originalStartIndex = 0;
    session.originalEndIndex = originalEndIndex;
    session.totalTokens = pointerState.totalTokens;
    session.pointers = pointerState.pointers;
    session._cachedView = undefined;
    return true;
  }

  private getActiveWorkflowCount(session: Session): number {
    this.normalizeActiveWorkflows(session);
    return session.activeWorkflows.length;
  }

  createSession(projectPath: string, name?: string, options?: { allowReuse?: boolean }): Session {
    // Special handling for system sessions
    if (projectPath === SYSTEM_PROJECT_PATH) {
      return this.createSystemSession(name, options);
    }
   const normalizedPath = this.normalizeProjectPath(projectPath);
    const now = new Date().toISOString();
    const finalAllowReuse = options?.allowReuse !== false;

    if (finalAllowReuse) {
      this.cleanupEmptySessionsForProject(normalizedPath);
      const reusable = this.findReusableEmptySession(normalizedPath);
      if (reusable) {
        if (typeof name === 'string' && name.trim().length > 0) {
          reusable.name = name.trim();
        }
        reusable.lastAccessedAt = now;
        this.saveSession(reusable);
        if (!this.setCurrentSession(reusable.id)) {
          log.warn('Failed to set cwd for reused session: ${reusable.id}', { "reusable.id": reusable.id });
        }
        log.info('Reused empty session: ${reusable.name} (${reusable.id})', { "reusable.name": reusable.name, "reusable.id": reusable.id });
        return reusable;
      }
    }

    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: Session = {
      id,
      name: name || path.basename(normalizedPath),
      projectPath: normalizedPath,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      messages: [],
      activeWorkflows: [],
      context: {},
      ...LEDGER_POINTER_DEFAULTS,
    };
    session.context = this.normalizeSessionOwnershipContext(session, session.context).context;

    // Hard limit: evict oldest session if at capacity
    const MAX_SESSIONS = 100;
    if (this.sessions.size >= MAX_SESSIONS) {
      const entries = Array.from(this.sessions.entries());
      const oldest = entries
        .sort((a, b) => new Date(a[1].lastAccessedAt).getTime() - new Date(b[1].lastAccessedAt).getTime())[0];
      if (oldest) {
        this.sessions.delete(oldest[0]);
      }
    }

    this.sessions.set(id, session);
    this.saveSession(session);
    if (!this.setCurrentSession(id)) {
      log.warn('Failed to set cwd for new session: ${id}', { "id": id });
    }

   log.info('Created session: ${session.name} (${id})', { "session.name": session.name, "id": id });
    return session;
  }

  ensureSystemSession(): Session {
    const systemSessions = this.listSessions().filter((session) => this.isSystemSession(session));
    if (systemSessions.length > 0) {
      return systemSessions[0];
    }
    return this.createSystemSession();
  }

  createSystemSession(name?: string, _options?: { allowReuse?: boolean }): Session {
    const now = new Date().toISOString();
    const systemSessionId = `${SYSTEM_SESSION_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const systemSessionName = name && name.trim().length > 0 ? name.trim() : 'system-main';

    const session: Session = {
      id: systemSessionId,
      name: systemSessionName,
      projectPath: SYSTEM_PROJECT_PATH,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      messages: [],
      activeWorkflows: [],
      context: {
        sessionTier: 'system',
        ownerAgentId: SYSTEM_AGENT_ID,
      },
      ...LEDGER_POINTER_DEFAULTS,
    };
    session.context = this.normalizeSessionOwnershipContext(session, session.context).context;

    // Hard limit: evict oldest session if at capacity
    const MAX_SESSIONS = 100;
    if (this.sessions.size >= MAX_SESSIONS) {
      const entries = Array.from(this.sessions.entries());
      const oldest = entries
        .sort((a, b) => new Date(a[1].lastAccessedAt).getTime() - new Date(b[1].lastAccessedAt).getTime())[0];
      if (oldest) {
        this.sessions.delete(oldest[0]);
      }
    }

    this.sessions.set(systemSessionId, session);
    this.saveSession(session);
    log.info('Created system session: ${session.name} (${systemSessionId})', { "session.name": session.name, "systemSessionId": systemSessionId });
    return session;
  }

 getOrCreateSystemSession(): Session {
   const candidates = this.listSessions()
     .filter((session) =>
       this.isSystemSession(session)
       && !this.isRuntimeSession(session)
       && !this.isHeartbeatControlSession(session))
     .sort((a, b) => {
       const tierA = a.projectPath === SYSTEM_PROJECT_PATH ? 3 : a.id.startsWith(SYSTEM_SESSION_PREFIX) ? 2 : 1;
       const tierB = b.projectPath === SYSTEM_PROJECT_PATH ? 3 : b.id.startsWith(SYSTEM_SESSION_PREFIX) ? 2 : 1;
       if (tierA !== tierB) return tierB - tierA;
       return new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime();
     });

   const existing = candidates[0];
   if (existing) {
     const context = (existing.context && typeof existing.context === 'object')
       ? (existing.context as Record<string, unknown>)
       : {};
     const ownerAgentId = typeof context.ownerAgentId === 'string' ? context.ownerAgentId.trim() : '';
     const memoryOwnerWorkerId = typeof context.memoryOwnerWorkerId === 'string'
       ? context.memoryOwnerWorkerId.trim()
       : '';
     if (ownerAgentId !== SYSTEM_AGENT_ID || memoryOwnerWorkerId !== SYSTEM_AGENT_ID) {
       existing.context = {
         ...context,
         ownerAgentId: SYSTEM_AGENT_ID,
         memoryOwnerWorkerId: SYSTEM_AGENT_ID,
         memoryOwnershipUpdatedAt: new Date().toISOString(),
       };
       log.warn('Repaired system session ownership mismatch during getOrCreateSystemSession', {
         sessionId: existing.id,
         previousOwnerAgentId: ownerAgentId || undefined,
         previousMemoryOwnerWorkerId: memoryOwnerWorkerId || undefined,
       });
     }
     existing.lastAccessedAt = new Date().toISOString();
     this.saveSession(existing);
     return existing;
   }

   return this.createSystemSession();
  }

 ensureSession(sessionId: string, projectPath: string, name?: string): Session {
    // Resolve system session alias
    if (sessionId === 'system-default-session') {
      const systemSession = this.getOrCreateSystemSession();
      return systemSession;
    }

    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastAccessedAt = new Date().toISOString();
      return existing;
    }

    const normalizedPath = this.normalizeProjectPath(projectPath);
    const now = new Date().toISOString();
    const resolvedName = name && name.trim().length > 0 ? name.trim() : (path.basename(normalizedPath) || sessionId);
    const session: Session = {
      id: sessionId,
      name: resolvedName,
      projectPath: normalizedPath,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      messages: [],
      activeWorkflows: [],
      context: {},
      ...LEDGER_POINTER_DEFAULTS,
    };
    session.context = this.normalizeSessionOwnershipContext(session, session.context).context;

    this.sessions.set(sessionId, session);
    this.saveSession(session);
    return session;
  }

  private isEmptySession(session: Session): boolean {
    return this.getLedgerMessageCountSync(session) === 0 && this.getActiveWorkflowCount(session) === 0;
  }

  private findReusableEmptySession(projectPath: string): Session | null {
    const normalized = this.normalizeProjectPath(projectPath);
    const candidates = this.listSessions()
      .filter((session) =>
        session.projectPath === normalized
        && !this.isRuntimeSession(session)
        && this.isEmptySession(session))
      .sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime());
    return candidates[0] ?? null;
  }

  private cleanupEmptySessionsAcrossProjects(): void {
    const projectPaths = new Set(Array.from(this.sessions.values()).map((session) => session.projectPath));
    for (const projectPath of projectPaths) {
      this.cleanupEmptySessionsForProject(projectPath);
    }
  }

  private cleanupEmptySessionsForProject(projectPath: string): void {
    const normalized = this.normalizeProjectPath(projectPath);
    const emptySessions = this.listSessions()
      .filter((session) =>
        session.projectPath === normalized
        && !this.isRuntimeSession(session)
        && this.isEmptySession(session))
      .sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime());

    if (emptySessions.length <= 1) return;
    const keeper = emptySessions[0];
    for (let i = 1; i < emptySessions.length; i += 1) {
      this.deleteSession(emptySessions[i].id);
    }

    if (this.currentSessionId && !this.sessions.has(this.currentSessionId)) {
      this.currentSessionId = keeper.id;
    }
  }

  getSession(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastAccessedAt = new Date().toISOString();
    }
    return session;
  }

  getCurrentSession(): Session | null {
    if (!this.currentSessionId) return null;
    return this.getSession(this.currentSessionId) || null;
  }

  private applySessionCwd(_session: Session): boolean {
    // 根因修复：禁止 SessionManager 通过 process.chdir() 修改全局 cwd。
    // 全局 cwd 是进程级共享状态，会导致并发请求出现 session 串扰。
    // 工具执行路径必须显式从 session/projectPath 传递，不依赖全局 cwd。
    return true;
  }

  setCurrentSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    const session = this.sessions.get(sessionId)!;
    this.applySessionCwd(session);
    this.currentSessionId = sessionId;
    session.lastAccessedAt = new Date().toISOString();
    this.saveSession(session);
    return true;
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()
    );
  }

  listRootSessions(): Session[] {
    return this.listSessions().filter((session) => !this.isRuntimeSession(session) && !this.isHeartbeatControlSession(session));
  }

  refreshSessionsFromDisk(options?: { preserveCurrent?: boolean }): void {
    const preserve = options?.preserveCurrent !== false;
    const preservedId = preserve ? this.currentSessionId : null;
    this.sessions.clear();
    this.sessionFilePaths.clear();
    this.currentSessionId = preservedId;
    this.loadSessions({ autoResume: false, preserveCurrentId: preservedId });
  }

  findSessionsByProjectPath(projectPath: string): Session[] {
    const normalized = this.normalizeProjectPath(projectPath);
    const prefix = normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`;
    return this.listSessions().filter((session) => {
      if (this.isRuntimeSession(session)) return false;
      return session.projectPath === normalized || session.projectPath.startsWith(prefix);
    });
  }

  async addMessage(
    sessionId: string,
    role: SessionMessage['role'],
    content: string,
    metadata?: {
      workflowId?: string;
      taskId?: string;
      attachments?: Attachment[];
      type?: SessionMessage['type'];
      agentId?: string;
      toolName?: string;
      toolStatus?: SessionMessage['toolStatus'];
      toolDurationMs?: number;
      toolInput?: unknown;
      toolOutput?: unknown;
      tags?: string[];
      topic?: string;
      timestamp?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<SessionMessage | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestedTimestamp = typeof metadata?.timestamp === 'string' && metadata.timestamp.trim().length > 0
      ? metadata.timestamp.trim()
      : '';
    const normalizedTimestamp = requestedTimestamp.length > 0
      ? requestedTimestamp
      : new Date().toISOString();

    const message: SessionMessage = {
      id: messageId,
      role,
      content,
      timestamp: normalizedTimestamp,
      ...metadata,
      attachments: metadata?.attachments,
    };

    // Write to ledger (primary storage)
    const ctx = session.context ?? {};
    const agentId = metadata?.agentId || (typeof ctx.ownerAgentId === 'string' ? ctx.ownerAgentId : '') || 'unknown';
    const rootDir = this.resolveSessionsRoot(session);
    const rawLedgerMetadata = metadata?.metadata;
    const baseLedgerMetadata = rawLedgerMetadata && typeof rawLedgerMetadata === 'object'
      ? (rawLedgerMetadata as Record<string, unknown>)
      : {};
    const topLevelTags = Array.isArray(metadata?.tags)
      ? metadata.tags.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const topLevelTopic = typeof metadata?.topic === 'string' && metadata.topic.trim().length > 0
      ? metadata.topic.trim()
      : undefined;
    const mergedLedgerMetadata: Record<string, unknown> = { ...baseLedgerMetadata };
    if (!Array.isArray(mergedLedgerMetadata.tags) && topLevelTags.length > 0) {
      mergedLedgerMetadata.tags = topLevelTags;
    }
    if (typeof mergedLedgerMetadata.topic !== 'string' && topLevelTopic) {
      mergedLedgerMetadata.topic = topLevelTopic;
    }
    const rawCodexAlignedContext = baseLedgerMetadata.codexAlignedContext;
    const baseCodexAlignedContext = rawCodexAlignedContext && typeof rawCodexAlignedContext === 'object'
      ? (rawCodexAlignedContext as Record<string, unknown>)
      : {};
    const messageType = typeof metadata?.type === 'string' ? metadata.type : undefined;
    const resolvedLedgerMode = this.resolveLedgerModeForWrite(session, metadata);
    const buildLedgerMetadata = (mode: string): Record<string, unknown> => {
      const codexAlignedContext: Record<string, unknown> = {
        ...baseCodexAlignedContext,
        role,
        session_id: session.id,
        agent_id: agentId,
        mode,
        ...(messageType ? { message_type: messageType } : {}),
        ...(role === 'user' ? { user_input: content } : {}),
      };
      return {
        ...mergedLedgerMetadata,
        codexAlignedContext,
        _fingerLedger: {
          schema: 'finger.session_message.v1',
          role,
          session_id: session.id,
          agent_id: agentId,
          mode,
          ...(messageType ? { message_type: messageType } : {}),
        },
      };
    };
    // 默认对 user/assistant 文本写入做 tag/topic 推断（若调用方未显式提供）
    if (role === 'user' || role === 'assistant') {
      const hasTags = Array.isArray(mergedLedgerMetadata.tags)
        && mergedLedgerMetadata.tags.some((item) => typeof item === 'string' && item.trim().length > 0);
      const hasTopic = typeof mergedLedgerMetadata.topic === 'string'
        && mergedLedgerMetadata.topic.trim().length > 0;
      if (!hasTags || !hasTopic) {
        const inferred = inferTagsAndTopic({
          texts: [content],
          seedTags: [
            agentId,
            role,
            messageType ?? '',
          ],
          seedTopic: hasTopic ? String(mergedLedgerMetadata.topic) : undefined,
          maxTags: 10,
        });
        if (!hasTags && inferred.tags) {
          mergedLedgerMetadata.tags = inferred.tags;
        }
        if (!hasTopic && inferred.topic) {
          mergedLedgerMetadata.topic = inferred.topic;
        }
      }
    }

    const writeMessageToLedger = async (mode: string): Promise<void> => {
      await appendSessionMessage(
        { rootDir, sessionId: session.id, agentId, mode },
        {
          role,
          content,
          messageId,
          tokenCount: estimateTokens(content),
          metadata: buildLedgerMetadata(mode),
        },
      );
    };
    try {
      await writeMessageToLedger(resolvedLedgerMode);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const shouldRetryOnMain = code === 'ENOENT' && resolvedLedgerMode !== 'main';
      if (shouldRetryOnMain) {
        clog.warn('[SessionManager] Ledger write ENOENT on transient mode, retrying on main mode', {
          sessionId: session.id,
          agentId,
          failedMode: resolvedLedgerMode,
        });
        try {
          await writeMessageToLedger('main');
        } catch (retryErr) {
          clog.error('[SessionManager] Ledger write retry on main mode failed, message append aborted:', retryErr);
          return null;
        }
      } else {
        clog.error('[SessionManager] Ledger write failed, message append aborted:', err);
        return null;
      }
    }

    session.lastAccessedAt = new Date().toISOString();
    if (!Array.isArray(session.messages)) {
      session.messages = [];
    }
    const lastMessage = session.messages.length > 0 ? session.messages[session.messages.length - 1] : undefined;
    if (!lastMessage || typeof lastMessage.timestamp !== 'string' || lastMessage.timestamp <= message.timestamp) {
      session.messages.push(message);
    } else {
      let insertAt = session.messages.length;
      while (insertAt > 0) {
        const prev = session.messages[insertAt - 1];
        if (typeof prev.timestamp !== 'string' || prev.timestamp <= message.timestamp) break;
        insertAt -= 1;
      }
      session.messages.splice(insertAt, 0, message);
    }

    // Update ledger pointers
    session.originalEndIndex = (session.originalEndIndex || 0) + 1;
    session.totalTokens = (session.totalTokens || 0) + estimateTokens(content);

    // Invalidate cached view (will be rebuilt on next read)
    session._cachedView = undefined;

    this.saveSession(session);
    return message;
  }

  private resolveLedgerModeForWrite(
    session: Session,
    metadata?: {
      metadata?: Record<string, unknown>;
    },
  ): string {
    const sessionCtx = session.context ?? {};
    const explicit = metadata?.metadata && typeof metadata.metadata === 'object'
      ? metadata.metadata as Record<string, unknown>
      : {};
    const explicitMode = typeof explicit.ledgerMode === 'string'
      ? explicit.ledgerMode.trim()
      : '';
    if (explicitMode.length > 0) return explicitMode;
    const activeMode = typeof sessionCtx.activeLedgerMode === 'string'
      ? sessionCtx.activeLedgerMode.trim()
      : '';
    if (activeMode.length > 0) return activeMode;
    return 'main';
  }

  setTransientLedgerMode(sessionId: string, mode: string, options?: {
    source?: string;
    autoDeleteOnStop?: boolean;
  }): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const normalizedMode = mode.trim();
    if (!normalizedMode) return false;
    session.context = this.normalizeSessionOwnershipContext(session, {
      ...session.context,
      activeLedgerMode: normalizedMode,
      transientLedgerMode: normalizedMode,
      transientLedgerSource: options?.source ?? session.context.transientLedgerSource,
      transientLedgerAutoDeleteOnStop: options?.autoDeleteOnStop !== false,
      transientLedgerSetAt: new Date().toISOString(),
    }).context;
    this.saveSession(session);
    return true;
  }

  clearTransientLedgerMode(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const nextContext = { ...session.context };
    delete nextContext.activeLedgerMode;
    delete nextContext.transientLedgerMode;
    delete nextContext.transientLedgerSource;
    delete nextContext.transientLedgerAutoDeleteOnStop;
    delete nextContext.transientLedgerSetAt;
    session.context = this.normalizeSessionOwnershipContext(session, nextContext).context;
    this.saveSession(session);
    return true;
  }

  async finalizeTransientLedgerMode(sessionId: string, options: {
    finishReason?: string;
    keepOnFailure?: boolean;
  } = {}): Promise<{ active: boolean; deleted: boolean; mode?: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { active: false, deleted: false };
    const context = session.context ?? {};
    const mode = typeof context.transientLedgerMode === 'string'
      ? context.transientLedgerMode.trim()
      : typeof context.activeLedgerMode === 'string'
        ? context.activeLedgerMode.trim()
        : '';
    if (!mode || mode === 'main') return { active: false, deleted: false };

    const autoDeleteOnStop = context.transientLedgerAutoDeleteOnStop !== false;
    const finishedStop = options.finishReason === 'stop';
    const shouldDelete = autoDeleteOnStop && finishedStop && options.keepOnFailure !== true;
    let deleted = false;
    if (shouldDelete) {
      // Persist mode clear first so subsequent writes fall back to main ledger
      // and do not race on deleted transient paths.
      this.clearTransientLedgerMode(sessionId);
      try {
        const ownerAgentId = typeof context.ownerAgentId === 'string' && context.ownerAgentId.trim().length > 0
          ? context.ownerAgentId.trim()
          : SYSTEM_AGENT_ID;
        const rootDir = this.resolveSessionsRoot(session);
        const dir = resolveBaseDir(rootDir, session.id, ownerAgentId, mode);
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            await fs.promises.rm(dir, { recursive: true, force: true });
            deleted = true;
            break;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            const retryable = code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM';
            if (!retryable || attempt >= maxAttempts) throw error;
            await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
          }
        }
        log.info('[SessionManager] transient ledger removed on successful completion', {
          sessionId: session.id,
          agentId: ownerAgentId,
          mode,
          deleted,
        });
      } catch (error) {
        log.warn('[SessionManager] failed to remove transient ledger mode', {
          sessionId: session.id,
          mode,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { active: true, deleted, mode };
    }
    return { active: true, deleted: false, mode };
  }

  getMessages(sessionId: string, limit = 50): SessionMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    return this.getMessagesFromLedger(session, limit);
  }

  /**
   * Build session view from ledger via Context Builder / LedgerReader.
   * Used only when session snapshot needs hydration or explicit async view refresh.
   */
  private async getLedgerView(session: Session, options?: { maxTokens?: number; includeSummary?: boolean }): Promise<SessionView> {
    const ctx = session.context ?? {};
    const agentId = typeof ctx.ownerAgentId === 'string' ? ctx.ownerAgentId : SYSTEM_AGENT_ID;
    const rootDir = this.resolveSessionsRoot(session);
    const contextWindow = getContextWindow();
    const contextBuilder = loadContextBuilderSettings();
    const maxTokens = options?.maxTokens ?? contextWindow;
    const latestUserPrompt = this.getLatestUserPromptFromLedgerSync(session, agentId);

    // Context Builder path (default enabled)
    if (contextBuilder.enabled) {
      try {
        const configuredBudget = Number.isFinite(contextBuilder.historyBudgetTokens) && contextBuilder.historyBudgetTokens > 0
          ? Math.floor(contextBuilder.historyBudgetTokens)
          : Math.floor(maxTokens * contextBuilder.budgetRatio);
        const targetBudget = Math.max(1, Math.min(maxTokens, configuredBudget));
        const built = await buildContext(
          {
            rootDir,
            sessionId: session.id,
            agentId,
            mode: 'main',
            currentPrompt: latestUserPrompt,
          },
          {
            targetBudget,
            buildMode: contextBuilder.mode,
            includeMemoryMd: false,
            enableTaskGrouping: true,
            enableModelRanking: contextBuilder.enableModelRanking,
            rankingProviderId: contextBuilder.rankingProviderId,
          },
        );

        const mappedMessages: SessionViewMessage[] = [];

        for (const msg of built.messages) {
          mappedMessages.push({
            role: msg.role,
            content: msg.content,
            tokenCount: msg.tokenCount,
            messageId: msg.id,
            timestamp: msg.timestampIso,
            metadata: msg.contextZone ? { contextZone: msg.contextZone } : undefined,
          });
        }

        const total = mappedMessages.reduce((sum, m) => sum + m.tokenCount, 0);
        return {
          compressedSummary: undefined,
          compressedSummaryTokens: undefined,
          messages: mappedMessages,
          tokenCount: total,
          source: {
            ledgerPath: `${rootDir}/${session.id}/${agentId}/main/context-ledger.jsonl`,
            compactPath: `${rootDir}/${session.id}/${agentId}/main/compact-memory.jsonl`,
          },
        };
      } catch (err) {
        log.warn('[SessionManager] Context builder failed, fallback to ledger-reader', {
          sessionId: session.id,
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return buildSessionView(
      { rootDir, sessionId: session.id, agentId, mode: 'main' },
      { maxTokens, includeSummary: options?.includeSummary ?? true },
    );
  }

  private getMessagesFromLedger(session: Session, limit: number): SessionMessage[] {
    const snapshot = Array.isArray(session.messages) ? session.messages : [];
    if (snapshot.length > 0) {
      if (!Number.isFinite(limit) || limit <= 0) {
        return [...snapshot];
      }
      return snapshot.slice(-limit);
    }

    const view = session._cachedView;
    if (view) {
      const msgs = view.messages;
      if (!Number.isFinite(limit) || limit <= 0) {
        return this.viewMessagesToSessionMessages(msgs);
      }
      return this.viewMessagesToSessionMessages(msgs.slice(-limit));
    }

    const hydrated = this.readLedgerSessionMessagesSync(session, limit);
    if (hydrated.length > 0) {
      return hydrated;
    }

    return [];
  }

  /**
   * Async version of getMessages.
   * Runtime strict mode: consumes session snapshot only.
   */
  async getMessagesAsync(sessionId: string, limit = 50): Promise<SessionMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const snapshot = Array.isArray(session.messages) ? session.messages : [];
    if (snapshot.length > 0) {
      if (!Number.isFinite(limit) || limit <= 0) {
        return [...snapshot];
      }
      return snapshot.slice(-limit);
    }

    const view = session._cachedView;
    if (view) {
      const msgs = view.messages;
      if (!Number.isFinite(limit) || limit <= 0) {
        return this.viewMessagesToSessionMessages(msgs);
      }
      return this.viewMessagesToSessionMessages(msgs.slice(-limit));
    }

    const hydrated = this.readLedgerSessionMessagesSync(session, limit);
    if (hydrated.length > 0) {
      return hydrated;
    }
    return [];
  }

  private viewMessagesToSessionMessages(msgs: SessionViewMessage[]): SessionMessage[] {
    return msgs.map((msg) => ({
      id: msg.messageId || `ledger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp || new Date().toISOString(),
      ...(msg.metadata ? { metadata: msg.metadata } : {}),
    }));
  }

  updateMessage(sessionId: string, messageId: string, content: string): SessionMessage | null {
    void sessionId;
    void messageId;
    void content;
    log.warn('[SessionManager] updateMessage skipped: ledger-only mode does not support in-place history mutation');
    return null;
  }

  deleteMessage(sessionId: string, messageId: string): boolean {
    void sessionId;
    void messageId;
    log.warn('[SessionManager] deleteMessage skipped: ledger-only mode does not support in-place history deletion');
    return false;
  }

  /**
   * 获取完整上下文 (包含压缩摘要)
   */
  getFullContext(sessionId: string): { messages: SessionMessage[]; compressedSummary?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { messages: [] };

    const compressed = session.context.compressedHistory as { summary?: string } | undefined;
    return {
      messages: this.getMessages(sessionId, 0),
      compressedSummary: compressed?.summary,
    };
  }
  async compressContext(sessionId: string, options?: { force?: boolean }): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    log.warn('[SessionManager] TS compact path rejected: compaction is kernel-owned', {
      sessionId,
      force: options?.force === true,
      ownerAgentId: typeof session.context?.ownerAgentId === 'string' ? session.context.ownerAgentId : SYSTEM_AGENT_ID,
    });
    throw createRustKernelCompactionError();
  }
  /**
   * finish_reason = stop 时自动生成 digest + 保存 tags
   */
  async appendDigest(
    sessionId: string,
    message: SessionMessage,
    tags: string[],
    agentId?: string,
    mode?: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.warn("[SessionManager.appendDigest] Session not found", { sessionId });
      return;
    }

    const ctx = session.context ?? {};
    const resolvedAgentId = agentId || (typeof ctx.ownerAgentId === "string" ? ctx.ownerAgentId : SYSTEM_AGENT_ID);
    const resolvedMode = mode || "main";
    const rootDir = this.resolveSessionsRoot(session);

    await appendDigestForTurn(sessionId, rootDir, {
      tags,
      currentMessage: message,
      agentId: resolvedAgentId,
      mode: resolvedMode,
    });

    log.info("[SessionManager.appendDigest] Digest appended", {
      sessionId,
      agentId: resolvedAgentId,
      messageId: message.id,
      tags,
    });
  }

  getCompressionStatus(sessionId: string): { compressed: boolean; summary?: string; originalCount?: number } {
    const session = this.sessions.get(sessionId);
    if (!session) return { compressed: false };
    const compressed = session.context.compressedHistory as { summary?: string; originalCount?: number } | undefined;
    return { compressed: !!compressed, summary: compressed?.summary, originalCount: compressed?.originalCount };
  }

  syncProjectionFromKernelMetadata(
    sessionId: string,
    metadata: Record<string, unknown> | undefined,
    options?: {
      agentId?: string;
      mode?: string;
      assistantReply?: string;
    },
  ): {
    applied: boolean;
    reason: string;
    messageCount?: number;
    latestCompactIndex?: number;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { applied: false, reason: 'session_not_found' };
    }
    if (!isObjectRecord(metadata)) {
      return { applied: false, reason: 'metadata_missing' };
    }

    const rawApiHistory = Array.isArray(metadata.api_history)
      ? metadata.api_history.filter((item): item is Record<string, unknown> => isObjectRecord(item))
      : [];
    const compactMetadata = isObjectRecord(metadata.compact) ? metadata.compact : {};
    const compactApplied = compactMetadata.applied === true || historyContainsCompactDigest(rawApiHistory);
    if (!compactApplied) {
      return { applied: false, reason: 'compact_not_applied' };
    }
    if (rawApiHistory.length === 0) {
      return { applied: false, reason: 'api_history_empty' };
    }

    const projectedMessages = normalizeProjectionMessages(
      this.buildSessionMessagesFromKernelApiHistory(session, rawApiHistory, options?.assistantReply),
    ).messages;
    if (projectedMessages.length === 0) {
      return { applied: false, reason: 'projection_empty' };
    }

    const sessionContext = isObjectRecord(session.context) ? session.context : {};
    const resolvedAgentId = typeof options?.agentId === 'string' && options.agentId.trim().length > 0
      ? options.agentId.trim()
      : typeof sessionContext.ownerAgentId === 'string' && sessionContext.ownerAgentId.trim().length > 0
        ? sessionContext.ownerAgentId.trim()
        : SYSTEM_AGENT_ID;
    const resolvedMode = typeof options?.mode === 'string' && options.mode.trim().length > 0
      ? options.mode.trim()
      : typeof metadata.kernelMode === 'string' && metadata.kernelMode.trim().length > 0
        ? metadata.kernelMode.trim()
        : typeof metadata.mode === 'string' && metadata.mode.trim().length > 0
          ? metadata.mode.trim()
          : 'main';

    const compactLineCount = this.readCompactMemoryLineCountSync(session, resolvedAgentId, resolvedMode);
    const latestCompactIndex = compactLineCount > 0 ? compactLineCount - 1 : -1;
    const pointerState = buildProjectionPointerState(projectedMessages);
    const syncedAt = new Date().toISOString();

    session.messages = projectedMessages;
    session.latestCompactIndex = latestCompactIndex;
    session.originalStartIndex = 0;
    session.originalEndIndex = projectedMessages.length > 0 ? projectedMessages.length - 1 : 0;
    session.totalTokens = pointerState.totalTokens;
    session.pointers = pointerState.pointers;
    session.lastAccessedAt = syncedAt;
    session.context = this.normalizeSessionOwnershipContext(session, {
      ...sessionContext,
      kernelProjection: {
        version: 1,
        source: 'rust_kernel_api_history',
        compactApplied: true,
        syncedAt,
        agentId: resolvedAgentId,
        mode: resolvedMode,
        projectedMessageCount: projectedMessages.length,
        latestCompactIndex,
        ...(typeof compactMetadata.summary === 'string' && compactMetadata.summary.trim().length > 0
          ? { compactSummary: compactMetadata.summary.trim() }
          : {}),
        ...(typeof compactMetadata.source_time_start === 'string' && compactMetadata.source_time_start.trim().length > 0
          ? { sourceTimeStart: compactMetadata.source_time_start.trim() }
          : {}),
        ...(typeof compactMetadata.source_time_end === 'string' && compactMetadata.source_time_end.trim().length > 0
          ? { sourceTimeEnd: compactMetadata.source_time_end.trim() }
          : {}),
      },
    }).context;
    session._cachedView = undefined;
    this.saveSession(session);

    return {
      applied: true,
      reason: 'compact_projection_synced',
      messageCount: projectedMessages.length,
      latestCompactIndex,
    };
  }

  async syncProjectionFromLedger(
    sessionId: string,
    options?: {
      agentId?: string;
      mode?: string;
      source?: string;
    },
  ): Promise<{
    applied: boolean;
    reason: string;
    messageCount?: number;
    latestCompactIndex?: number;
    totalTokens?: number;
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { applied: false, reason: 'session_not_found' };
    }

    const sessionContext = isObjectRecord(session.context) ? session.context : {};
    const resolvedAgentId = typeof options?.agentId === 'string' && options.agentId.trim().length > 0
      ? options.agentId.trim()
      : typeof sessionContext.ownerAgentId === 'string' && sessionContext.ownerAgentId.trim().length > 0
        ? sessionContext.ownerAgentId.trim()
        : SYSTEM_AGENT_ID;
    const resolvedMode = typeof options?.mode === 'string' && options.mode.trim().length > 0
      ? options.mode.trim()
      : 'main';
    const rootDir = this.resolveSessionsRoot(session);

    const view = await buildSessionView(
      { rootDir, sessionId: session.id, agentId: resolvedAgentId, mode: resolvedMode },
      { includeSummary: true },
    );

    const projectedMessages: SessionMessage[] = [];
    const compactSummary = typeof view.compressedSummary === 'string' ? view.compressedSummary.trim() : '';
    if (compactSummary.length > 0) {
      projectedMessages.push({
        id: `ledger-compact-${Date.now()}`,
        role: 'assistant',
        content: compactSummary,
        timestamp: new Date().toISOString(),
        metadata: buildKernelProjectionMessageMetadata(compactSummary),
      });
    }

    projectedMessages.push(
      ...view.messages.map((msg, index) => ({
        id: msg.messageId || `ledger-${Date.now()}-${index}`,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp || new Date().toISOString(),
        metadata: { ...buildKernelProjectionMessageMetadata(msg.content), ...(msg.metadata ?? {}) },
      })),
    );

    const compactLineCount = this.readCompactMemoryLineCountSync(session, resolvedAgentId, resolvedMode);
    if (compactLineCount <= 0 && compactSummary.length === 0) {
      return { applied: false, reason: 'compact_memory_empty' };
    }

    const normalizedProjection = normalizeProjectionMessages(projectedMessages);
    const latestCompactIndex = compactLineCount > 0 ? compactLineCount - 1 : -1;
    const pointerState = buildProjectionPointerState(normalizedProjection.messages);
    const syncedAt = new Date().toISOString();

    session.messages = normalizedProjection.messages;
    session.latestCompactIndex = latestCompactIndex;
    session.originalStartIndex = 0;
    session.originalEndIndex = normalizedProjection.messages.length > 0 ? normalizedProjection.messages.length - 1 : 0;
    session.totalTokens = pointerState.totalTokens;
    session.pointers = pointerState.pointers;
    session.lastAccessedAt = syncedAt;
    session.context = this.normalizeSessionOwnershipContext(session, {
      ...sessionContext,
      kernelProjection: {
        version: 1,
        source: typeof options?.source === 'string' && options.source.trim().length > 0
          ? options.source.trim()
          : 'runtime_ledger_projection',
        compactApplied: latestCompactIndex >= 0 || compactSummary.length > 0,
        syncedAt,
        agentId: resolvedAgentId,
        mode: resolvedMode,
        projectedMessageCount: normalizedProjection.messages.length,
        latestCompactIndex,
        ...(compactSummary.length > 0 ? { compactSummary } : {}),
      },
    }).context;
    session._cachedView = undefined;
    this.saveSession(session);

    return {
      applied: true,
      reason: 'ledger_projection_synced',
      messageCount: normalizedProjection.messages.length,
      latestCompactIndex,
      totalTokens: pointerState.totalTokens,
    };
  }

  pauseSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.context = this.normalizeSessionOwnershipContext(session, {
      ...session.context,
      paused: true,
      pausedAt: new Date().toISOString(),
    }).context;
    this.saveSession(session);
    return true;
  }

  resumeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.context = this.normalizeSessionOwnershipContext(session, {
      ...session.context,
      paused: false,
      resumedAt: new Date().toISOString(),
    }).context;
    this.saveSession(session);
    return true;
  }

  isPaused(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.context.paused === true;
  }

  updateContext(sessionId: string, context: Record<string, unknown>): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const mergedContext = {
      ...(isObjectRecord(session.context) ? session.context : {}),
      ...context,
    };
    session.context = this.normalizeSessionOwnershipContext(session, mergedContext).context;
    this.saveSession(session);
    return true;
  }

  addWorkflowToSession(sessionId: string, workflowId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.normalizeActiveWorkflows(session);
    if (!session.activeWorkflows.includes(workflowId)) {
      session.activeWorkflows.push(workflowId);
      this.saveSession(session);
    }
    return true;
  }

  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const candidatePaths = new Set<string>();
    const trackedPath = this.sessionFilePaths.get(sessionId);
    if (trackedPath) candidatePaths.add(trackedPath);
    candidatePaths.add(this.getSessionPath(session));

    if (!this.isRuntimeSession(session)) {
      const rootDir = this.getSessionDir(session);
      if (fs.existsSync(rootDir)) {
        fs.rmSync(rootDir, { recursive: true, force: true });
      }
    } else {
      for (const filePath of candidatePaths) {
        if (!fs.existsSync(filePath)) continue;
        fs.unlinkSync(filePath);
        const parentDir = path.dirname(filePath);
        if (parentDir !== SESSIONS_DIR && fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
          fs.rmdirSync(parentDir);
        }
      }
    }

    this.sessions.delete(sessionId);
    this.sessionFilePaths.delete(sessionId);
    if (this.currentSessionId === sessionId) {
      const remaining = this.listSessions();
      this.currentSessionId = remaining.length > 0 ? remaining[0].id : null;
    }
    return true;
  }

  deleteProjectSessions(projectPath: string, options?: { allowActive?: boolean }): {
    removed: string[];
    projectDir: string;
    hadActive: boolean;
  } {
    const normalized = this.normalizeProjectPath(projectPath);
    const projectDir = this.getProjectSessionsDir(normalized);
    const candidates = Array.from(this.sessions.values()).filter(
      (session) => session.projectPath === normalized,
    );
    const hasActive = candidates.some((session) => this.getActiveWorkflowCount(session) > 0);
    if (hasActive && options?.allowActive !== true) {
      return { removed: [], projectDir, hadActive: true };
    }

    const removed: string[] = [];
    for (const session of candidates) {
      if (this.deleteSession(session.id)) {
        removed.push(session.id);
      }
    }

    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }

    return { removed, projectDir, hadActive: false };
  }

  renameSession(sessionId: string, nextName: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const normalized = nextName.trim();
    if (!normalized) {
      throw new Error('Session name cannot be empty');
    }
    session.name = normalized;
    session.lastAccessedAt = new Date().toISOString();
    this.saveSession(session);
    return session;
  }

  getSessionMessageSnapshot(
    sessionId: string,
    previewLimit = 3,
  ): {
    messageCount: number;
    previewMessages: SessionMessage[];
    lastMessageAt?: string;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        messageCount: 0,
        previewMessages: [],
      };
    }
    const allMessages = this.readLedgerSessionMessagesSync(session, 0);
    const previewMessages = previewLimit > 0 ? allMessages.slice(-previewLimit) : [];
    const lastMessageAt = previewMessages.length > 0 ? previewMessages[previewMessages.length - 1].timestamp : undefined;
    return {
      messageCount: allMessages.length,
      previewMessages,
      ...(lastMessageAt ? { lastMessageAt } : {}),
    };
  }

  private getLatestUserPromptFromLedgerSync(session: Session, agentId: string): string | undefined {
    const snapshot = this.getMessagesFromLedger(session, 0);
    if (snapshot.length > 0) {
      for (let index = snapshot.length - 1; index >= 0; index -= 1) {
        const message = snapshot[index];
        if (message.role === 'user' && typeof message.content === 'string' && message.content.trim().length > 0) {
          return message.content;
        }
      }
      return undefined;
    }

    const messages = this.readLedgerSessionMessagesSync(session, 0, agentId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'user' && typeof message.content === 'string' && message.content.trim().length > 0) {
        return message.content;
      }
    }
    return undefined;
  }

  private getLedgerMessageCountSync(session: Session): number {
    return this.readLedgerSessionMessagesSync(session, 0).length;
  }

  private readLedgerSessionMessagesSync(
    session: Session,
    limit: number,
    explicitAgentId?: string,
  ): SessionMessage[] {
    const context = session.context ?? {};
    const rootDir = this.resolveSessionsRoot(session);
    const ownerAgentId = typeof context.ownerAgentId === 'string' && context.ownerAgentId.trim().length > 0
      ? context.ownerAgentId.trim()
      : '';
    const preferredAgentIds = Array.from(new Set([
      typeof explicitAgentId === 'string' ? explicitAgentId.trim() : '',
      ownerAgentId,
      SYSTEM_AGENT_ID,
    ].filter((item) => item.length > 0)));

    const readFromLedgerPath = (ledgerPath: string): SessionMessage[] => {
      if (!fs.existsSync(ledgerPath)) return [];
      try {
        const lines = fs.readFileSync(ledgerPath, 'utf-8')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        const parsed = lines
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as Record<string, unknown>];
            } catch {
              return [];
            }
          })
          .filter((entry) => entry.event_type === 'session_message')
          .map((entry) => {
            const payload = typeof entry.payload === 'object' && entry.payload !== null
              ? entry.payload as Record<string, unknown>
              : {};
            const role = typeof payload.role === 'string'
              ? payload.role as SessionMessage['role']
              : 'user';
            const content = typeof payload.content === 'string' ? payload.content : '';
            const timestamp = typeof entry.timestamp_iso === 'string'
              ? entry.timestamp_iso
              : new Date().toISOString();
            const messageId = typeof payload.message_id === 'string'
              ? payload.message_id
              : (typeof entry.id === 'string' ? entry.id : `ledger-${Date.now()}`);
            return {
              id: messageId,
              role,
              content,
              timestamp,
              ...(Array.isArray(payload.attachments) ? { attachments: payload.attachments as Attachment[] } : {}),
              ...(typeof payload.metadata === 'object' && payload.metadata !== null ? { metadata: payload.metadata as Record<string, unknown> } : {}),
            } as SessionMessage;
          });
        if (!Number.isFinite(limit) || limit <= 0) return parsed;
        return parsed.slice(-limit);
      } catch (error) {
        clog.error('[SessionManager] Failed to read ledger messages sync:', error);
        return [];
      }
    };

    for (const agentId of preferredAgentIds) {
      const ledgerPath = path.join(rootDir, session.id, agentId, 'main', 'context-ledger.jsonl');
      const hit = readFromLedgerPath(ledgerPath);
      if (hit.length > 0) return hit;
    }

    const sessionRoot = path.join(rootDir, session.id);
    if (!fs.existsSync(sessionRoot)) return [];
    try {
      const agentDirs = fs.readdirSync(sessionRoot, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => item.name);
      let best: SessionMessage[] = [];
      for (const agentId of agentDirs) {
        const ledgerPath = path.join(sessionRoot, agentId, 'main', 'context-ledger.jsonl');
        const hit = readFromLedgerPath(ledgerPath);
        if (hit.length > best.length) {
          best = hit;
        }
      }
      return best;
    } catch (error) {
      clog.error('[SessionManager] Failed to scan session ledger roots:', error);
      return [];
    }
  }

  private buildSessionMessagesFromKernelApiHistory(
    session: Session,
    apiHistory: Record<string, unknown>[],
    assistantReply?: string,
  ): SessionMessage[] {
    const existingBySignature = indexSessionMessagesBySignature(Array.isArray(session.messages) ? session.messages : []);
    const projected: SessionMessage[] = [];

    for (const [index, item] of apiHistory.entries()) {
      const content = extractKernelHistoryContent(item);
      if (!content) continue;
      const timestamp = extractKernelHistoryTimestamp(item) ?? new Date().toISOString();
      const role = normalizeKernelHistoryRole(item);
      const metadata = buildKernelProjectionMessageMetadata(content);
      const signature = buildMessageSignature(role, content, timestamp);
      const reused = existingBySignature.get(signature)?.shift();
      const itemId = typeof item.id === 'string' && item.id.trim().length > 0 ? item.id.trim() : '';
      const resolvedId = typeof reused?.id === 'string' && reused.id.trim().length > 0
        ? reused.id.trim()
        : itemId || `kernel-${Date.now()}-${index}`;
      projected.push({
        id: resolvedId,
        role,
        content,
        timestamp,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
    }

    const fallbackReply = typeof assistantReply === 'string' ? assistantReply.trim() : '';
    if (fallbackReply.length > 0) {
      const lastMessage = projected.length > 0 ? projected[projected.length - 1] : undefined;
      if (!lastMessage || lastMessage.role !== 'assistant' || lastMessage.content.trim() !== fallbackReply) {
        projected.push({
          id: `kernel-reply-${Date.now()}`,
          role: 'assistant',
          content: fallbackReply,
          timestamp: new Date().toISOString(),
          metadata: {
            kernelApiHistory: true,
            contextZone: 'current_history',
          },
        });
      }
    }

    return projected;
  }

  private readCompactMemoryLineCountSync(session: Session, agentId: string, mode: string): number {
    const rootDir = this.resolveSessionsRoot(session);
    const compactPath = path.join(resolveBaseDir(rootDir, session.id, agentId, mode), 'compact-memory.jsonl');
    if (!fs.existsSync(compactPath)) return 0;
    try {
      return fs.readFileSync(compactPath, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .length;
    } catch (error) {
      clog.error('[SessionManager] Failed to read compact-memory for projection sync:', error);
      return 0;
    }
  }

  private readLatestCompactSummarySync(session: Session, agentId: string, mode: string): string {
    const rootDir = this.resolveSessionsRoot(session);
    const compactPath = path.join(resolveBaseDir(rootDir, session.id, agentId, mode), 'compact-memory.jsonl');
    if (!fs.existsSync(compactPath)) return '';
    try {
      const lines = fs.readFileSync(compactPath, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const parsed = JSON.parse(lines[index]) as Record<string, unknown>;
          const payload = isObjectRecord(parsed.payload) ? parsed.payload : {};
          const summary = typeof payload.summary === 'string' && payload.summary.trim().length > 0
            ? payload.summary.trim()
            : typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
              ? parsed.summary.trim()
              : '';
          if (summary.length > 0) return summary;
        } catch {
          continue;
        }
      }
      return '';
    } catch (error) {
      clog.error('[SessionManager] Failed to read compact-memory summary for startup repair:', error);
      return '';
    }
  }

  // ─── ISessionManager interface methods ──────────────────────────────

  async initialize(): Promise<unknown> {
    // Already initialized in constructor
    return { initialized: true };
  }

  getSessionSnapshot(sessionId: string): Session | undefined {
    return this.getSession(sessionId);
  }

  updateSession(sessionId: string, params: UpdateSessionParams): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (params.title) session.name = params.title;
    if (params.name) session.name = params.name;
    if (params.status) session.status = params.status;
    if (params.metadata) {
      session.context = { ...session.context, ...params.metadata };
    }
    session.updatedAt = new Date().toISOString();
    return session;
  }

  querySessions(query?: SessionQuery): Session[] {
    const sessions = Array.from(this.sessions.values());
    if (!query) return sessions;

    let filtered = sessions;
    if (query.status) {
      filtered = filtered.filter(s => s.status === query.status);
    }
    if (query.projectPath) {
      filtered = filtered.filter(s => s.projectPath === query.projectPath);
    }

    const sortBy = query.sortBy || 'updatedAt';
    const sortOrder = query.sortOrder || 'desc';
    filtered.sort((a, b) => {
      const aVal = String(a[sortBy as keyof Session] || '');
      const bVal = String(b[sortBy as keyof Session] || '');
      return sortOrder === 'desc' ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
    });

    if (query.limit) {
      filtered = filtered.slice(0, query.limit);
    }
    if (query.offset) {
      filtered = filtered.slice(query.offset);
    }

    return filtered;
  }

  getMessageHistory(sessionId: string, limit?: number): SessionMessage[] {
    return this.getMessages(sessionId, limit || 50);
  }

  restoreSession(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.status === SessionStatus.ARCHIVED) {
      session.status = SessionStatus.ACTIVE;
      session.updatedAt = new Date().toISOString();
    }
    return session;
  }

  restoreAllSessions(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.status === SessionStatus.ARCHIVED) {
        session.status = SessionStatus.ACTIVE;
        session.updatedAt = new Date().toISOString();
        count++;
      }
    }
    return count;
  }

  cleanupExpiredSessions(ttlDays?: number): number {
    const days = ttlDays || 30;
    const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
    let count = 0;
    for (const [id, session] of this.sessions.entries()) {
      const lastAccessed = new Date(session.lastAccessedAt).getTime();
      if (lastAccessed < threshold) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  getStats(): SessionStats {
    const sessions = Array.from(this.sessions.values());
    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter(s => s.status === SessionStatus.ACTIVE).length,
      totalMessages: sessions.reduce((sum, s) => sum + (s.messageCount || 0), 0),
      oldestSession: sessions.length > 0 ? sessions[sessions.length - 1]?.id : undefined,
      newestSession: sessions.length > 0 ? sessions[0]?.id : undefined,
    };
  }

  destroy(): void {
    this.sessions.clear();
    this.sessionFilePaths.clear();
    this.currentSessionId = null;
  }

}

function buildMessageSignature(role: SessionMessage['role'], content: string, timestamp: string): string {
  return `${role}\u0000${timestamp}\u0000${content}`;
}

function indexSessionMessagesBySignature(messages: SessionMessage[]): Map<string, SessionMessage[]> {
  const indexed = new Map<string, SessionMessage[]>();
  for (const message of messages) {
    const signature = buildMessageSignature(message.role, message.content, message.timestamp);
    const bucket = indexed.get(signature);
    if (bucket) {
      bucket.push(message);
    } else {
      indexed.set(signature, [message]);
    }
  }
  return indexed;
}

function normalizeKernelHistoryRole(item: Record<string, unknown>): SessionMessage['role'] {
  const role = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
  if (role === 'assistant' || role === 'system') return role;
  return 'user';
}

function extractKernelHistoryTimestamp(item: Record<string, unknown>): string | undefined {
  const candidates = [
    item.timestamp_iso,
    item.timestampIso,
    item.timestamp,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function extractKernelHistoryContent(item: Record<string, unknown>): string {
  const direct = typeof item.output_text === 'string' && item.output_text.trim().length > 0
    ? item.output_text
    : typeof item.content === 'string' && item.content.trim().length > 0
      ? item.content
      : '';
  if (direct) return direct;

  const content = item.content;
  if (!Array.isArray(content)) return '';
  const parts = content
    .flatMap((entry) => {
      if (!isObjectRecord(entry)) return [];
      const text = typeof entry.text === 'string' && entry.text.trim().length > 0
        ? entry.text
        : typeof entry.content === 'string' && entry.content.trim().length > 0
          ? entry.content
          : '';
      return text ? [text] : [];
    })
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.join('\n').trim();
}

function historyContainsCompactDigest(history: Record<string, unknown>[]): boolean {
  return history.some((item) => {
    const content = extractKernelHistoryContent(item);
    return isCompactDigestContent(content);
  });
}

function isCompactDigestContent(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  return normalized.includes('<task_digest>') || normalized.includes('<history_summary>');
}

function isHistoricalProjectionMessage(message: SessionMessage): boolean {
  const metadata = isObjectRecord(message.metadata) ? message.metadata : {};
  const zone = typeof metadata.contextZone === 'string' ? metadata.contextZone.trim() : '';
  return metadata.compactDigest === true || zone === 'historical_memory' || isCompactDigestContent(message.content);
}

function normalizeProjectionMessages(
  messages: SessionMessage[],
): {
  messages: SessionMessage[];
  changed: boolean;
} {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], changed: false };
  }

  const shouldNormalizeZones = messages.some((message) => {
    const metadata = isObjectRecord(message.metadata) ? message.metadata : {};
    const zone = typeof metadata.contextZone === 'string' ? metadata.contextZone.trim() : '';
    return metadata.compactDigest === true
      || zone === 'historical_memory'
      || zone === 'current_history'
      || isCompactDigestContent(message.content);
  });

  const historical: SessionMessage[] = [];
  const current: SessionMessage[] = [];
  let changed = false;

  for (const [index, message] of messages.entries()) {
    const historicalMessage = isHistoricalProjectionMessage(message);
    const contentIsDigest = isCompactDigestContent(message.content);
    const rawMetadata = isObjectRecord(message.metadata) ? message.metadata : {};
    let normalizedMessage = message;

    if (shouldNormalizeZones) {
      const metadata = { ...rawMetadata };
      const targetZone = historicalMessage ? 'historical_memory' : 'current_history';
      if (metadata.contextZone !== targetZone) {
        metadata.contextZone = targetZone;
        changed = true;
      }
      if (contentIsDigest && metadata.compactDigest !== true) {
        metadata.compactDigest = true;
        changed = true;
      }
      normalizedMessage = {
        ...message,
        metadata,
      };
    }

    if (typeof normalizedMessage.id !== 'string' || normalizedMessage.id.trim().length === 0) {
      normalizedMessage = {
        ...normalizedMessage,
        id: buildProjectionFallbackId(normalizedMessage, index),
      };
      changed = true;
    }

    if (historicalMessage) {
      historical.push(normalizedMessage);
    } else {
      current.push(normalizedMessage);
    }
  }

  const normalized = [...historical, ...current];
  if (!changed && normalized.length === messages.length) {
    for (let index = 0; index < normalized.length; index += 1) {
      if (normalized[index] !== messages[index]) {
        changed = true;
        break;
      }
    }
  }

  return {
    messages: changed ? normalized : messages,
    changed,
  };
}

function buildProjectionFallbackId(message: SessionMessage, index: number): string {
  const timestamp = typeof message.timestamp === 'string' ? message.timestamp : '';
  const digest = createHash('sha1')
    .update(`${message.role}\u0000${timestamp}\u0000${message.content}\u0000${index}`)
    .digest('hex')
    .slice(0, 12);
  return `projection-${digest}`;
}

function buildKernelProjectionMessageMetadata(content: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    kernelApiHistory: true,
  };
  if (isCompactDigestContent(content)) {
    metadata.compactDigest = true;
    metadata.contextZone = 'historical_memory';
  } else {
    metadata.contextZone = 'current_history';
  }
  const digestJson = extractTaggedJson(content, 'task_digest');
  if (digestJson && isObjectRecord(digestJson)) {
    if (typeof digestJson.task_id === 'string' && digestJson.task_id.trim().length > 0) {
      metadata.taskId = digestJson.task_id.trim();
    }
    if (typeof digestJson.topic === 'string' && digestJson.topic.trim().length > 0) {
      metadata.topic = digestJson.topic.trim();
    }
    if (Array.isArray(digestJson.tags)) {
      const tags = digestJson.tags.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      if (tags.length > 0) metadata.tags = tags;
    }
  }
  return metadata;
}

function extractTaggedJson(content: string, tagName: string): Record<string, unknown> | undefined {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, 'i');
  const match = content.match(pattern);
  if (!match || typeof match[1] !== 'string') return undefined;
  try {
    const parsed = JSON.parse(match[1]);
    return isObjectRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function buildProjectionPointerState(
  messages: SessionMessage[],
): {
  totalTokens: number;
  pointers: NonNullable<Session['pointers']>;
} {
  const normalizedProjection = normalizeProjectionMessages(messages);
  let historicalTokens = 0;
  let currentTokens = 0;
  let historicalPrefixCount = 0;

  for (const message of normalizedProjection.messages) {
    const tokens = estimateTokens(message.content);
    if (isHistoricalProjectionMessage(message)) {
      historicalPrefixCount += 1;
      historicalTokens += tokens;
      continue;
    }
    currentTokens += tokens;
  }

  const totalTokens = historicalTokens + currentTokens;
  const currentStart = historicalPrefixCount < normalizedProjection.messages.length
    ? historicalPrefixCount
    : Math.max(0, normalizedProjection.messages.length - 1);
  const currentEnd = normalizedProjection.messages.length > 0 ? normalizedProjection.messages.length - 1 : 0;

  return {
    totalTokens,
    pointers: {
      contextHistory: {
        startLine: historicalPrefixCount > 0 ? 0 : 0,
        endLine: historicalPrefixCount > 0 ? historicalPrefixCount - 1 : -1,
        estimatedTokens: historicalTokens,
      },
      currentHistory: {
        startLine: currentStart,
        endLine: currentEnd,
        estimatedTokens: currentTokens,
      },
    },
  };
}
