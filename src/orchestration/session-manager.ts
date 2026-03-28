/**
 * Session Manager - 会话管理
 * 负责会话创建、恢复、隔离、上下文压缩
 *
 * Ledger-Session 一体化架构：
 * - Ledger (context-ledger.jsonl) 是消息的唯一数据真源
 * - Session 只存元数据和指针，messages 字段已废弃
 */

import fs from 'fs';
import path from 'path';
import { FINGER_PATHS, ensureDir, normalizeSessionDirName } from '../core/finger-paths.js';
import { Session, SessionMessage, LEDGER_POINTER_DEFAULTS, ensureLedgerPointers } from './session-types.js';
import type { Attachment } from '../runtime/events.js';
import { appendSessionMessage } from '../runtime/ledger-writer.js';
import { buildSessionView, type SessionView, type SessionViewMessage } from '../runtime/ledger-reader.js';
import { needsCompression, compressSession, type CompressResult } from '../runtime/session-compressor.js';
import { estimateTokens } from '../utils/token-counter.js';
import { getContextWindow } from '../core/user-settings.js';
import { loadContextBuilderSettings } from '../core/user-settings.js';
import { buildContext } from '../runtime/context-builder.js';
import { logger } from '../core/logger.js';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';
import { inferTagsAndTopic } from '../common/tag-topic-inference.js';
import { pruneOrphanSessionRootDirs } from '../core/runtime-hygiene.js';

const clog = createConsoleLikeLogger('SessionManager');

export { Session, SessionMessage } from './session-types.js';

const SESSIONS_DIR = FINGER_PATHS.sessions.dir;
const SYSTEM_SESSIONS_DIR = path.join(FINGER_PATHS.home, 'system', 'sessions');
const SYSTEM_PROJECT_PATH = path.join(FINGER_PATHS.home, 'system');
const SYSTEM_AGENT_ID = 'finger-system-agent';
const SYSTEM_SESSION_PREFIX = 'system-';
const ROOT_SESSION_FILE = 'main.json';

const log = logger.module('SessionManager');

export class SessionManager {
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
    if (typeof ctx.ownerAgentId === 'string' && ctx.ownerAgentId === SYSTEM_AGENT_ID) return true;
    if (session.id.startsWith(SYSTEM_SESSION_PREFIX)) return true;
    return false;
  }

  private getSystemSessionsDir(): string {
    return SYSTEM_SESSIONS_DIR;
  }

  private getProjectDirName(projectPath: string): string {
    const normalizedPath = path.resolve(projectPath).replace(/\\/g, '/');
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

  private loadSessionFile(filePath: string): void {
    const content = fs.readFileSync(filePath, 'utf-8');
    const session = JSON.parse(content) as Session;
    if (!session.id || !session.projectPath) {
      throw new Error('Invalid session content');
    }
    session.projectPath = this.normalizeProjectPath(session.projectPath);
    // Ensure ledger pointer fields exist for backward compatibility
    ensureLedgerPointers(session);
    // Session file no longer stores message history as source-of-truth.
    // Keep persisted metadata, but force in-memory message cache empty and rebuild from ledger views.
    session.messages = [];
    delete (session as Session & { _cachedView?: unknown })._cachedView;
    this.sessions.set(session.id, session);
    this.sessionFilePaths.set(session.id, filePath);
  }

  private normalizeProjectPath(projectPath: string): string {
    const normalized = path.resolve(projectPath);
    const marker = `${path.sep}.finger${path.sep}session${path.sep}`;
    const idx = normalized.indexOf(marker);
    if (idx > 0) {
      const candidate = normalized.slice(0, idx);
      return candidate || normalized;
    }
    return normalized;
  }

  private loadSessionsFromDir(dirPath: string): void {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessionDir = path.join(dirPath, entry.name);
        const sessionEntries = fs.readdirSync(sessionDir, { withFileTypes: true });
        for (const sessionEntry of sessionEntries) {
          if (!sessionEntry.isFile() || !sessionEntry.name.endsWith('.json')) continue;
          const filePath = path.join(sessionDir, sessionEntry.name);
          try {
            this.loadSessionFile(filePath);
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            if (error.message.includes('Unexpected end of JSON input')) {
              // Ignore truncated session files during startup
              continue;
            }
            clog.error(`[SessionManager] Failed to load session ${filePath}:`, error);
          }
        }
        continue;
      }
      // Backward compatibility: legacy flat session files.
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const filePath = path.join(dirPath, entry.name);
        try {
          this.loadSessionFile(filePath);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (error.message.includes('Unexpected end of JSON input')) {
            // Ignore truncated session files during startup
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
    const sessionDir = this.getSessionDir(session);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const filePath = this.getSessionPath(session);
    const persistedSession: Session = {
      ...session,
      messages: [],
    };
    delete (persistedSession as Session & { _cachedView?: unknown })._cachedView;
    fs.writeFileSync(filePath, JSON.stringify(persistedSession, null, 2));

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

  createSession(projectPath: string, name?: string, options?: { allowReuse?: boolean }): Session {
    // Special handling for system sessions
    if (projectPath === SYSTEM_PROJECT_PATH) {
      return this.createSystemSession(name, options);
    }
   const normalizedPath = path.resolve(projectPath);
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

    this.sessions.set(systemSessionId, session);
    this.saveSession(session);
    log.info('Created system session: ${session.name} (${systemSessionId})', { "session.name": session.name, "systemSessionId": systemSessionId });
    return session;
  }

 getOrCreateSystemSession(): Session {
   const candidates = this.listSessions()
     .filter((session) => this.isSystemSession(session) && !this.isRuntimeSession(session))
     .sort((a, b) => {
       const tierA = a.projectPath === SYSTEM_PROJECT_PATH ? 3 : a.id.startsWith(SYSTEM_SESSION_PREFIX) ? 2 : 1;
       const tierB = b.projectPath === SYSTEM_PROJECT_PATH ? 3 : b.id.startsWith(SYSTEM_SESSION_PREFIX) ? 2 : 1;
       if (tierA !== tierB) return tierB - tierA;
       return new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime();
     });

   const existing = candidates[0];
   if (existing) {
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

    const normalizedPath = path.resolve(projectPath);
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

    this.sessions.set(sessionId, session);
    this.saveSession(session);
    return session;
  }

  private isEmptySession(session: Session): boolean {
    return this.getLedgerMessageCountSync(session) === 0 && session.activeWorkflows.length === 0;
  }

  private findReusableEmptySession(projectPath: string): Session | null {
    const normalized = path.resolve(projectPath);
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
    const normalized = path.resolve(projectPath);
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

  private applySessionCwd(session: Session): boolean {
    const target = session.projectPath?.trim();
    if (!target) return false;
    try {
      process.chdir(target);
      return true;
    } catch (error) {
      clog.error(`[SessionManager] Failed to set cwd to ${target}:`, error);
      return false;
    }
  }

  setCurrentSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    const session = this.sessions.get(sessionId)!;
    if (!this.applySessionCwd(session)) return false;
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
    return this.listSessions().filter((session) => !this.isRuntimeSession(session));
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
    const normalized = path.resolve(projectPath);
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
      metadata?: Record<string, unknown>;
    }
  ): Promise<SessionMessage | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const message: SessionMessage = {
      id: messageId,
      role,
      content,
      timestamp: new Date().toISOString(),
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
    const codexAlignedContext: Record<string, unknown> = {
      ...baseCodexAlignedContext,
      role,
      session_id: session.id,
      agent_id: agentId,
      mode: 'main',
      ...(messageType ? { message_type: messageType } : {}),
      ...(role === 'user' ? { user_input: content } : {}),
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

    const ledgerMetadata: Record<string, unknown> = {
      ...mergedLedgerMetadata,
      codexAlignedContext,
      _fingerLedger: {
        schema: 'finger.session_message.v1',
        role,
        session_id: session.id,
        agent_id: agentId,
        mode: 'main',
        ...(messageType ? { message_type: messageType } : {}),
      },
    };
    try {
      await appendSessionMessage(
        { rootDir, sessionId: session.id, agentId, mode: 'main' },
        {
          role,
          content,
          messageId,
          tokenCount: estimateTokens(content),
          metadata: ledgerMetadata,
        },
      );
    } catch (err) {
      clog.error('[SessionManager] Ledger write failed, message append aborted:', err);
      return null;
    }

    session.lastAccessedAt = new Date().toISOString();

    // Update ledger pointers
    session.originalEndIndex = (session.originalEndIndex || 0) + 1;
    session.totalTokens = (session.totalTokens || 0) + estimateTokens(content);

    // Invalidate cached view (will be rebuilt on next read)
    session._cachedView = undefined;

    this.saveSession(session);
    return message;
  }

  getMessages(sessionId: string, limit = 50): SessionMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    return this.getMessagesFromLedger(session, limit);
  }

  /**
   * Build messages from Ledger via LedgerReader.
   * Returns SessionMessage[] for backward compatibility.
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
            timeWindow: {
              nowMs: Date.now(),
              halfLifeMs: contextBuilder.halfLifeMs,
              overThresholdRelevance: contextBuilder.overThresholdRelevance,
            },
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
    const view = session._cachedView;
    if (view) {
      const msgs = view.messages;
      if (!Number.isFinite(limit) || limit <= 0) {
        return this.viewMessagesToSessionMessages(msgs);
      }
      return this.viewMessagesToSessionMessages(msgs.slice(-limit));
    }

    return this.readLedgerSessionMessagesSync(session, limit);
  }

  /**
   * Async version of getMessages that always reads from Ledger.
   */
  async getMessagesAsync(sessionId: string, limit = 50): Promise<SessionMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const view = await this.getLedgerView(session, { includeSummary: false });
    session._cachedView = view;

    const msgs = view.messages;
    if (!Number.isFinite(limit) || limit <= 0) {
      return this.viewMessagesToSessionMessages(msgs);
    }
    return this.viewMessagesToSessionMessages(msgs.slice(-limit));
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

  async compressContext(sessionId: string, summarizer?: (messages: SessionMessage[]) => Promise<string>): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    if (!needsCompression(session)) {
      return 'No compression needed';
    }

    const ctx = session.context ?? {};
    const agentId = typeof ctx.ownerAgentId === 'string' ? ctx.ownerAgentId : SYSTEM_AGENT_ID;
    const rootDir = this.resolveSessionsRoot(session);

    const summarizerAdapter = summarizer
      ? async (entries: Array<{ payload: unknown }>): Promise<CompressResult> => {
          const messages: SessionMessage[] = entries.map((entry, idx) => {
            const pl = entry.payload as Record<string, unknown>;
            return {
              id: `ledger-${idx}`,
              role: (pl.role as SessionMessage['role']) || 'user',
              content: typeof pl.content === 'string' ? pl.content : '',
              timestamp: new Date().toISOString(),
            };
          });
          const summary = await summarizer(messages);
          return { summary, userPreferencePatch: '', tokenCount: estimateTokens(summary) };
        }
      : undefined;

    const result = await compressSession(session, {
      rootDir,
      agentId,
      mode: 'main',
      summarizer: summarizerAdapter,
    });

    if (!result.compressed) {
      return result.reason || 'Compression skipped';
    }

    session.latestCompactIndex = result.pointers.latestCompactIndex;
    session.originalStartIndex = result.pointers.originalStartIndex;
    session.totalTokens = result.pointers.totalTokens;
    session._cachedView = undefined;

    session.context = {
      ...session.context,
      compressedHistory: {
        timestamp: new Date().toISOString(),
        originalCount: result.result?.tokenCount || 0,
        summary: result.result?.summary || '',
      },
    };

    this.saveSession(session);
    log.info('Compressed session ${sessionId}: ${result.result?.summary?.slice(0, 100)}...', { "sessionId": sessionId, "result.result?.summary?.slice(0, 100)": result.result?.summary?.slice(0, 100) });

    return result.result?.summary || 'Compression completed';
  }

  getCompressionStatus(sessionId: string): { compressed: boolean; summary?: string; originalCount?: number } {
    const session = this.sessions.get(sessionId);
    if (!session) return { compressed: false };
    const compressed = session.context.compressedHistory as { summary?: string; originalCount?: number } | undefined;
    return { compressed: !!compressed, summary: compressed?.summary, originalCount: compressed?.originalCount };
  }

  pauseSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.context = { ...session.context, paused: true, pausedAt: new Date().toISOString() };
    this.saveSession(session);
    return true;
  }

  resumeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.context = { ...session.context, paused: false, resumedAt: new Date().toISOString() };
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
    session.context = { ...session.context, ...context };
    this.saveSession(session);
    return true;
  }

  addWorkflowToSession(sessionId: string, workflowId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
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
    const normalized = path.resolve(projectPath);
    const projectDir = this.getProjectSessionsDir(normalized);
    const candidates = Array.from(this.sessions.values()).filter(
      (session) => session.projectPath === normalized,
    );
    const hasActive = candidates.some((session) => session.activeWorkflows.length > 0);
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
    const agentId = explicitAgentId
      ?? (typeof context.ownerAgentId === 'string' && context.ownerAgentId.trim().length > 0
        ? context.ownerAgentId
        : SYSTEM_AGENT_ID);
    const rootDir = this.resolveSessionsRoot(session);
    const ledgerPath = path.join(rootDir, session.id, agentId, 'main', 'context-ledger.jsonl');
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
  }
}
