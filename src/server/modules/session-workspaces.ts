import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { FINGER_PATHS, ensureDir, normalizeSessionDirName } from '../../core/finger-paths.js';
import { isObjectRecord } from '../common/object.js';
import { asString } from '../common/strings.js';

export interface SessionWorkspaceDirs {
  sessionWorkspaceRoot: string;
  agentWorkspaceRoot: string;
  memoryDir: string;
  deliverablesDir: string;
  exchangeDir: string;
}

export interface RootSessionInfo {
  id: string;
  projectPath: string;
  sessionWorkspaceRoot: string;
  memoryDir: string;
  deliverablesDir: string;
  exchangeDir: string;
}

interface AgentSessionWorkspaceDirs {
  agentWorkspaceRoot: string;
  agentSessionWorkspace: string;
  memoryDir: string;
  deliverablesDir: string;
  exchangeDir: string;
}

export interface SessionWorkspaceManager {
  ensureSessionWorkspaceDirs(sessionId: string): SessionWorkspaceDirs;
  resolveSessionWorkspaceDirsForMessage(sessionId: string): SessionWorkspaceDirs;
  ensureOrchestratorRootSession(): RootSessionInfo;
  ensureRuntimeChildSession(root: RootSessionInfo, agentId: string): { id: string; projectPath: string };
  resolveWorkspaceForAgent(agentId: string): string;
  isRuntimeChildSession(session: { context?: Record<string, unknown> } | null | undefined): boolean;
  hydrateSessionWorkspace(sessionId: string): RootSessionInfo;
  findRuntimeChildSession(rootSessionId: string, agentId: string): { id: string; projectPath: string } | null;
}

function sanitizeWorkspaceComponent(raw: string): string {
  return raw.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
}

function ensureSessionBeadsWorkspace(sessionWorkspaceRoot: string): void {
  const beadsDir = ensureDir(join(sessionWorkspaceRoot, '.beads'));
  const beadsConfigPath = join(beadsDir, 'config.yaml');
  if (!existsSync(beadsConfigPath)) {
    writeFileSync(beadsConfigPath, 'mode: git-portable\n', 'utf8');
  }
}

function resolveSessionWorkspaceRoot(sessionManager: SessionManager, sessionId: string): string {
  const resolved = sessionManager.resolveSessionWorkspaceRoot(sessionId);
  if (resolved) return resolved;
  const fallback = join(
    FINGER_PATHS.sessions.dir,
    '_unknown',
    normalizeSessionDirName(sanitizeWorkspaceComponent(sessionId)),
    'workspace',
  );
  ensureDir(fallback);
  return fallback;
}

function resolveSessionAgentWorkspace(sessionWorkspaceRoot: string, agentId: string): string {
  return join(sessionWorkspaceRoot, 'agents', sanitizeWorkspaceComponent(agentId));
}

function resolveAgentSessionWorkspace(agentWorkspaceRoot: string, agentSessionId: string): string {
  return join(agentWorkspaceRoot, 'session', sanitizeWorkspaceComponent(agentSessionId));
}

function ensureAgentSessionWorkspaceDirs(agentWorkspaceRoot: string, agentSessionId: string): AgentSessionWorkspaceDirs {
  const normalizedAgentWorkspaceRoot = ensureDir(agentWorkspaceRoot);
  const agentSessionWorkspace = ensureDir(resolveAgentSessionWorkspace(normalizedAgentWorkspaceRoot, agentSessionId));
  ensureSessionBeadsWorkspace(agentSessionWorkspace);
  const memoryDir = ensureDir(join(agentSessionWorkspace, 'memory'));
  const deliverablesDir = ensureDir(join(agentSessionWorkspace, 'deliverables'));
  const exchangeDir = ensureDir(join(agentSessionWorkspace, 'exchange'));
  return {
    agentWorkspaceRoot: normalizedAgentWorkspaceRoot,
    agentSessionWorkspace,
    memoryDir,
    deliverablesDir,
    exchangeDir,
  };
}

export function createSessionWorkspaceManager(sessionManager: SessionManager): SessionWorkspaceManager {
  const ensureSessionWorkspaceDirs = (sessionId: string): SessionWorkspaceDirs => {
    const sessionWorkspaceRoot = ensureDir(resolveSessionWorkspaceRoot(sessionManager, sessionId));
    ensureSessionBeadsWorkspace(sessionWorkspaceRoot);
    const agentWorkspaceRoot = ensureDir(join(sessionWorkspaceRoot, 'agents'));
    const memoryDir = ensureDir(join(sessionWorkspaceRoot, 'memory'));
    const deliverablesDir = ensureDir(join(sessionWorkspaceRoot, 'deliverables'));
    const exchangeDir = ensureDir(join(sessionWorkspaceRoot, 'exchange'));
    return {
      sessionWorkspaceRoot,
      agentWorkspaceRoot,
      memoryDir,
      deliverablesDir,
      exchangeDir,
    };
  };

  const hydrateSessionWorkspace = (sessionId: string): RootSessionInfo => {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }
    const dirs = ensureSessionWorkspaceDirs(session.id);
    sessionManager.updateContext(session.id, {
      sessionWorkspaceRoot: dirs.sessionWorkspaceRoot,
      agentWorkspaceRoot: dirs.agentWorkspaceRoot,
      memoryDir: dirs.memoryDir,
      deliverablesDir: dirs.deliverablesDir,
      exchangeDir: dirs.exchangeDir,
    });
    const refreshed = sessionManager.getSession(session.id) ?? session;
    return {
      id: refreshed.id,
      projectPath: refreshed.projectPath,
      sessionWorkspaceRoot: dirs.sessionWorkspaceRoot,
      memoryDir: dirs.memoryDir,
      deliverablesDir: dirs.deliverablesDir,
      exchangeDir: dirs.exchangeDir,
    };
  };

  const isRuntimeChildSession = (session: { context?: Record<string, unknown> } | null | undefined): boolean => {
    if (!session || typeof session !== 'object') return false;
    const context = isObjectRecord(session.context) ? session.context : {};
    return context.sessionTier === 'runtime' || typeof context.parentSessionId === 'string';
  };

  const ensureOrchestratorRootSession = (): RootSessionInfo => {
    const current = sessionManager.getCurrentSession();
    if (current && !isRuntimeChildSession(current)) {
      const hydrated = hydrateSessionWorkspace(current.id);
      sessionManager.updateContext(current.id, { sessionTier: 'orchestrator-root' });
      return hydrated;
    }

    if (current && isRuntimeChildSession(current)) {
      const rootSessionId = asString((current.context as Record<string, unknown>)?.rootSessionId);
      if (rootSessionId) {
        const rootSession = sessionManager.getSession(rootSessionId);
        if (rootSession && !isRuntimeChildSession(rootSession)) {
          sessionManager.setCurrentSession(rootSession.id);
          const hydrated = hydrateSessionWorkspace(rootSession.id);
          sessionManager.updateContext(rootSession.id, { sessionTier: 'orchestrator-root' });
          return hydrated;
        }
      }
    }

    const created = sessionManager.createSession(process.cwd(), 'orchestrator', { allowReuse: false });
    const hydrated = hydrateSessionWorkspace(created.id);
    sessionManager.updateContext(created.id, {
      sessionTier: 'orchestrator-root',
    });
    return hydrated;
  };

  const findRuntimeChildSession = (rootSessionId: string, agentId: string): { id: string; projectPath: string } | null => {
    const sessions = sessionManager.listSessions();
    for (const session of sessions) {
      const context = isObjectRecord(session.context) ? session.context : {};
      if (context.sessionTier !== 'runtime') continue;
      if (asString(context.parentSessionId) !== rootSessionId) continue;
      if (asString(context.ownerAgentId) !== agentId) continue;
      return {
        id: session.id,
        projectPath: session.projectPath,
      };
    }
    return null;
  };

  const ensureRuntimeChildSession = (root: RootSessionInfo, agentId: string): { id: string; projectPath: string } => {
    const agentWorkspaceRoot = ensureDir(resolveSessionAgentWorkspace(root.sessionWorkspaceRoot, agentId));
    const existing = findRuntimeChildSession(root.id, agentId);
    if (existing) {
      const dirs = ensureAgentSessionWorkspaceDirs(agentWorkspaceRoot, existing.id);
      sessionManager.updateContext(existing.id, {
        sessionTier: 'runtime',
        parentSessionId: root.id,
        rootSessionId: root.id,
        ownerAgentId: agentId,
        sessionWorkspaceRoot: root.sessionWorkspaceRoot,
        memoryDir: dirs.memoryDir,
        deliverablesDir: dirs.deliverablesDir,
        exchangeDir: dirs.exchangeDir,
        agentWorkspaceRoot,
        agentSessionWorkspace: dirs.agentSessionWorkspace,
      });
      return {
        id: existing.id,
        projectPath: sessionManager.getSession(existing.id)?.projectPath ?? dirs.agentSessionWorkspace,
      };
    }

    const created = sessionManager.createSession(root.projectPath, `${agentId} runtime`, { allowReuse: false });
    const dirs = ensureAgentSessionWorkspaceDirs(agentWorkspaceRoot, created.id);
    sessionManager.updateContext(created.id, {
      sessionTier: 'runtime',
      parentSessionId: root.id,
      rootSessionId: root.id,
      ownerAgentId: agentId,
      sessionWorkspaceRoot: root.sessionWorkspaceRoot,
      memoryDir: dirs.memoryDir,
      deliverablesDir: dirs.deliverablesDir,
      exchangeDir: dirs.exchangeDir,
      agentWorkspaceRoot,
      agentSessionWorkspace: dirs.agentSessionWorkspace,
    });
    sessionManager.setCurrentSession(root.id);
    return {
      id: created.id,
      projectPath: sessionManager.getSession(created.id)?.projectPath ?? dirs.agentSessionWorkspace,
    };
  };

  const resolveWorkspaceForAgent = (agentId: string): string => {
    const root = ensureOrchestratorRootSession();
    return ensureDir(resolveSessionAgentWorkspace(root.sessionWorkspaceRoot, agentId));
  };

  const resolveSessionWorkspaceDirsForMessage = (sessionId: string): SessionWorkspaceDirs => {
    const knownSession = sessionManager.getSession(sessionId);
    if (knownSession) {
      const context = isObjectRecord(knownSession.context) ? knownSession.context : {};
      const fromContext = {
        sessionWorkspaceRoot: asString(context.sessionWorkspaceRoot),
        agentWorkspaceRoot: asString(context.agentWorkspaceRoot),
        memoryDir: asString(context.memoryDir),
        deliverablesDir: asString(context.deliverablesDir),
        exchangeDir: asString(context.exchangeDir),
      };
      if (
        fromContext.sessionWorkspaceRoot
        && fromContext.agentWorkspaceRoot
        && fromContext.memoryDir
        && fromContext.deliverablesDir
        && fromContext.exchangeDir
      ) {
        ensureDir(fromContext.sessionWorkspaceRoot);
        ensureDir(fromContext.agentWorkspaceRoot);
        ensureDir(fromContext.memoryDir);
        ensureDir(fromContext.deliverablesDir);
        ensureDir(fromContext.exchangeDir);
        return {
          sessionWorkspaceRoot: fromContext.sessionWorkspaceRoot,
          agentWorkspaceRoot: fromContext.agentWorkspaceRoot,
          memoryDir: fromContext.memoryDir,
          deliverablesDir: fromContext.deliverablesDir,
          exchangeDir: fromContext.exchangeDir,
        };
      }
    }
    return ensureSessionWorkspaceDirs(sessionId);
  };

  return {
    ensureSessionWorkspaceDirs,
    resolveSessionWorkspaceDirsForMessage,
    ensureOrchestratorRootSession,
    ensureRuntimeChildSession,
    resolveWorkspaceForAgent,
    isRuntimeChildSession,
    hydrateSessionWorkspace,
    findRuntimeChildSession,
  };
}
