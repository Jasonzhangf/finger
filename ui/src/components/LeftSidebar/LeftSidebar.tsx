import { useMemo, useState, useEffect, useCallback, type FC, type MouseEvent as ReactMouseEvent } from 'react';
import type { SessionInfo } from '../../api/types.js';
import type { ProviderConfig } from '../../api/types.js';
import {
  listProviders,
  selectProvider,
  testProvider,
  upsertProvider,
  deleteProjectSessions,
  pickProjectDirectory,
} from '../../api/client.js';
import './LeftSidebar.css';

type SidebarTab = 'project' | 'ai-provider' | 'settings';

interface LeftSidebarProps {
  sessions: SessionInfo[];
  currentSession: SessionInfo | null;
  isLoadingSessions: boolean;
  onCreateSession: (projectPath: string, name?: string) => Promise<SessionInfo>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onRenameSession: (sessionId: string, name: string) => Promise<SessionInfo>;
  onSwitchSession: (sessionId: string) => Promise<void>;
  onRefreshSessions: () => Promise<void>;
}

interface ProjectTabProps {
  sessions: SessionInfo[];
  currentSession: SessionInfo | null;
  isLoading: boolean;
  onCreateSession: (projectPath: string, name?: string) => Promise<SessionInfo>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onRenameSession: (sessionId: string, name: string) => Promise<SessionInfo>;
  onSwitchSession: (sessionId: string) => Promise<void>;
  onRefreshSessions: () => Promise<void>;
}

const TABS: Array<{ key: SidebarTab; label: string }> = [
  { key: 'project', label: 'Project' },
  { key: 'ai-provider', label: 'AI Provider' },
  { key: 'settings', label: 'Settings' },
];


function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function hasActiveWorkflow(session: SessionInfo): boolean {
  return Array.isArray(session.activeWorkflows) && session.activeWorkflows.length > 0;
}

function pickLatestSession(sessions: SessionInfo[]): SessionInfo | null {
  if (sessions.length === 0) return null;
  return sessions
    .slice()
    .sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime())[0];
}

function projectDisplayName(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function previewRoleLabel(role: 'user' | 'assistant' | 'system' | 'orchestrator'): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '助手';
  if (role === 'orchestrator') return '编排';
  return '系统';
}

function buildSessionPreviewLines(session: SessionInfo): string[] {
  const previewMessages = Array.isArray(session.previewMessages) ? session.previewMessages : [];
  if (previewMessages.length === 0) return [];
  return previewMessages.map((item) => {
    const when = new Date(item.timestamp).toLocaleTimeString();
    return `[${when}] ${previewRoleLabel(item.role)}: ${item.summary}`;
  });
}

interface SessionContextMenuState {
  x: number;
  y: number;
  sessionId: string;
}

export const LeftSidebar: FC<LeftSidebarProps> = ({
  sessions,
  currentSession,
  isLoadingSessions,
  onCreateSession,
  onDeleteSession,
  onRenameSession,
  onSwitchSession,
  onRefreshSessions,
}) => {
  const [activeTab, setActiveTab] = useState<SidebarTab | null>('project');

  const panelTitle = useMemo(() => {
    if (activeTab === 'project') return 'Project Management';
    if (activeTab === 'ai-provider') return 'AI Provider';
    if (activeTab === 'settings') return 'System Settings';
    return '';
  }, [activeTab]);

  const onTabClick = (tab: SidebarTab) => {
    setActiveTab(tab);
  };

  return (
    <div className="left-rail-shell">
      <nav className="left-rail" aria-label="Sidebar tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`left-rail-tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => onTabClick(tab.key)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab && (
        <aside className="left-flyout">
          <header className="left-flyout-header">{panelTitle}</header>
          <div className="left-flyout-content">
            {activeTab === 'project' && (
              <ProjectTab
                sessions={sessions}
                currentSession={currentSession}
                isLoading={isLoadingSessions}
                onCreateSession={onCreateSession}
                onDeleteSession={onDeleteSession}
                onRenameSession={onRenameSession}
                onSwitchSession={onSwitchSession}
                onRefreshSessions={onRefreshSessions}
              />
            )}
            {activeTab === 'ai-provider' && <AIProviderTab />}
            {activeTab === 'settings' && <SettingsTab />}
          </div>
        </aside>
      )}
    </div>
  );
};

const ProjectTab: FC<ProjectTabProps> = ({
  sessions,
  currentSession,
  isLoading,
  onCreateSession,
  onDeleteSession,
  onRenameSession,
  onSwitchSession,
  onRefreshSessions,
}) => {
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const currentProjectPath = currentSession?.projectPath?.trim() || '';

  useEffect(() => {
    if (!currentSession?.id) return;
    setSelectedSessionIds(new Set([currentSession.id]));
  }, [currentSession?.id]);

  useEffect(() => {
    const closeMenu = (): void => setContextMenu(null);
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setContextMenu(null);
    };

    document.addEventListener('click', closeMenu);
    window.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('click', closeMenu);
      window.removeEventListener('keydown', onEscape);
    };
  }, []);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()),
    [sessions],
  );

  const projectGroups = useMemo(() => {
    const groups: Array<{
      projectPath: string;
      name: string;
      sessions: SessionInfo[];
      latestSession: SessionInfo | null;
      latestRunningSession: SessionInfo | null;
      isRunning: boolean;
    }> = [];
    const index = new Map<string, number>();
    for (const session of sortedSessions) {
      const key = session.projectPath;
      const existingIndex = index.get(key);
      if (existingIndex === undefined) {
        const isRunning = hasActiveWorkflow(session);
        groups.push({
          projectPath: key,
          name: projectDisplayName(key),
          sessions: [session],
          latestSession: session,
          latestRunningSession: isRunning ? session : null,
          isRunning,
        });
        index.set(key, groups.length - 1);
      } else {
        const group = groups[existingIndex];
        group.sessions.push(session);
        if (!group.latestSession) group.latestSession = session;
        if (!group.latestRunningSession && hasActiveWorkflow(session)) {
          group.latestRunningSession = session;
        }
        if (hasActiveWorkflow(session)) {
          group.isRunning = true;
        }
      }
    }
    return groups;
  }, [sortedSessions]);

  const runningProjects = useMemo(
    () => projectGroups.filter((group) => group.isRunning),
    [projectGroups],
  );

  const idleProjects = useMemo(
    () => projectGroups.filter((group) => !group.isRunning),
    [projectGroups],
  );

  const filteredSessions = useMemo(() => {
    const normalizedProject = normalizePath(currentProjectPath);
    if (!normalizedProject) return sortedSessions;
    return sortedSessions.filter((session) => normalizePath(session.projectPath) === normalizedProject);
  }, [sortedSessions, currentProjectPath]);

  useEffect(() => {
    const validSet = new Set(filteredSessions.map((session) => session.id));
    setSelectedSessionIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (validSet.has(id)) next.add(id);
      }
      if (next.size > 0) return next;
      if (filteredSessions.length > 0) {
        next.add(filteredSessions[0].id);
      }
      return next;
    });
  }, [filteredSessions]);

  const selectedCount = selectedSessionIds.size;
  const selectedSession = useMemo(() => {
    if (selectedSessionIds.size !== 1) return null;
    const [id] = Array.from(selectedSessionIds);
    return filteredSessions.find((session) => session.id === id) ?? null;
  }, [filteredSessions, selectedSessionIds]);

  const handleCreate = async () => {
    const target = currentProjectPath;
    if (!target) {
      setHint('请先选择项目');
      return;
    }
    setIsSubmitting(true);
    setHint(null);
    try {
      const created = await onCreateSession(target);
      setSelectedSessionIds(new Set([created.id]));
      setHint(`已创建会话: ${created.name}`);
    } catch (error) {
      setHint(error instanceof Error ? error.message : '创建会话失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenDirectory = useCallback(async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setHint(null);
    try {
      const result = await pickProjectDirectory('选择工作目录');
      if (result.canceled) {
        setHint('已取消选择目录');
        return;
      }
      if (!result.path) {
        setHint(result.error || '未返回目录路径');
        return;
      }
      const created = await onCreateSession(result.path);
      await onSwitchSession(created.id);
      setSelectedSessionIds(new Set([created.id]));
      setHint(`已打开目录并创建会话: ${created.name}`);
    } catch (err) {
      setHint(err instanceof Error ? err.message : '打开目录失败');
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, onCreateSession, onSwitchSession]);

  const handleSwitchSession = useCallback(async (sessionId: string) => {
    setIsSubmitting(true);
    setHint(null);
    try {
      await onSwitchSession(sessionId);
      setSelectedSessionIds(new Set([sessionId]));
      const selected = sessions.find((session) => session.id === sessionId);
      setHint(`已加载会话: ${selected?.name || sessionId}`);
    } catch (error) {
      setHint(error instanceof Error ? error.message : '加载会话失败');
    } finally {
      setIsSubmitting(false);
    }
  }, [onSwitchSession, sessions]);

  const handleProjectJump = useCallback(async (projectPath: string) => {
    const group = projectGroups.find((item) => item.projectPath === projectPath);
    if (!group) return;
    const targetSession = group.latestRunningSession || group.latestSession || pickLatestSession(group.sessions);
    if (!targetSession) return;
    setIsSubmitting(true);
    setHint(null);
    try {
      await onSwitchSession(targetSession.id);
      setSelectedSessionIds(new Set([targetSession.id]));
    } catch (error) {
      setHint(error instanceof Error ? error.message : '项目跳转失败');
    } finally {
      setIsSubmitting(false);
    }
  }, [onSwitchSession, projectGroups]);

  const handleDeleteProject = useCallback(async (projectPath: string) => {
    const confirmed = window.confirm(`确认删除该项目的所有会话记录？\n${projectPath}`);
    if (!confirmed) return;
    setIsSubmitting(true);
    setHint(null);
    try {
      await deleteProjectSessions(projectPath);
      await onRefreshSessions();
      setHint(`已删除项目会话: ${projectDisplayName(projectPath)}`);
    } catch (error) {
      setHint(error instanceof Error ? error.message : '删除项目会话失败');
    } finally {
      setIsSubmitting(false);
    }
  }, [onRefreshSessions]);

  const handleToggleSelection = useCallback((sessionId: string, additive: boolean) => {
    setSelectedSessionIds((prev) => {
      if (!additive) return new Set([sessionId]);
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      if (next.size === 0) next.add(sessionId);
      return next;
    });
  }, []);

  const handleRowClick = useCallback((sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey) {
      handleToggleSelection(sessionId, true);
      return;
    }
    void handleSwitchSession(sessionId);
  }, [handleSwitchSession, handleToggleSelection]);

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>, sessionId: string) => {
    event.preventDefault();
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 220)),
      sessionId,
    });
    setSelectedSessionIds((prev) => {
      if (prev.has(sessionId)) return prev;
      return new Set([sessionId]);
    });
  }, []);

  const handleDeleteSessions = useCallback(async (sessionIds: string[]) => {
    if (sessionIds.length === 0) return;
    setIsSubmitting(true);
    setHint(null);
    try {
      for (const sessionId of sessionIds) {
        await onDeleteSession(sessionId);
      }
      setHint(`已删除会话: ${sessionIds.length} 个`);
      setSelectedSessionIds(new Set());
      setContextMenu(null);
    } catch (error) {
      setHint(error instanceof Error ? error.message : '删除会话失败');
    } finally {
      setIsSubmitting(false);
    }
  }, [onDeleteSession]);

  const handleRenameSession = useCallback(async (sessionId: string) => {
    const target = filteredSessions.find((session) => session.id === sessionId);
    if (!target) return;
    const nextName = window.prompt('重命名会话', target.name);
    if (nextName === null) return;
    const trimmed = nextName.trim();
    if (!trimmed) {
      setHint('会话名不能为空');
      return;
    }
    setIsSubmitting(true);
    setHint(null);
    try {
      await onRenameSession(sessionId, trimmed);
      setHint(`会话已重命名: ${trimmed}`);
      setContextMenu(null);
    } catch (error) {
      setHint(error instanceof Error ? error.message : '重命名失败');
    } finally {
      setIsSubmitting(false);
    }
  }, [filteredSessions, onRenameSession]);

  const contextSession = useMemo(
    () => (contextMenu ? filteredSessions.find((session) => session.id === contextMenu.sessionId) : null),
    [contextMenu, filteredSessions],
  );

  const deleteTargetIds = useMemo(() => {
    if (!contextMenu) return Array.from(selectedSessionIds);
    if (selectedSessionIds.has(contextMenu.sessionId) && selectedSessionIds.size > 1) {
      return Array.from(selectedSessionIds);
    }
    return [contextMenu.sessionId];
  }, [contextMenu, selectedSessionIds]);

  return (
    <div className="tab-content">
      <div className="project-status">
        <div className="project-status-card running">
          <div className="project-status-header">运行中项目</div>
          {runningProjects.length === 0 && (
            <div className="project-status-empty">暂无运行项目</div>
          )}
          {runningProjects.map((group) => {
            const isActive = normalizePath(currentSession?.projectPath || '') === normalizePath(group.projectPath);
            return (
              <button
                key={`running-${group.projectPath}`}
                type="button"
                className={`project-status-item ${isActive ? 'active' : ''}`}
                onClick={() => { void handleProjectJump(group.projectPath); }}
                onDoubleClick={() => { void handleProjectJump(group.projectPath); }}
              >
                <span className="project-status-name">{group.name}</span>
                <span className="project-status-path">{group.projectPath}</span>
              </button>
            );
          })}
        </div>
        <div className="project-status-card idle">
          <div className="project-status-header">Idle 项目</div>
          {idleProjects.length === 0 && (
            <div className="project-status-empty">暂无 Idle 项目</div>
          )}
          {idleProjects.map((group) => {
            const isActive = normalizePath(currentSession?.projectPath || '') === normalizePath(group.projectPath);
            return (
              <div key={`idle-${group.projectPath}`} className="project-status-row">
                <button
                  type="button"
                  className={`project-status-item ${isActive ? 'active' : ''}`}
                  onClick={() => { void handleProjectJump(group.projectPath); }}
                  onDoubleClick={() => { void handleProjectJump(group.projectPath); }}
                >
                  <span className="project-status-name">{group.name}</span>
                  <span className="project-status-path">{group.projectPath}</span>
                </button>
                <button
                  type="button"
                  className="project-status-delete"
                  onClick={() => { void handleDeleteProject(group.projectPath); }}
                  disabled={isSubmitting}
                >
                  删除
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="folder-picker">
        <label htmlFor="workdir-input">会话/工作目录</label>
        <input
          id="workdir-input"
          type="text"
          placeholder="当前会话绑定项目"
          value={currentProjectPath}
          readOnly
        />
        <div className="folder-picker-actions">
          <button type="button" onClick={() => { void handleOpenDirectory(); }} disabled={isSubmitting}>
            打开目录
          </button>
          <button type="button" onClick={() => { void onRefreshSessions(); }} disabled={isSubmitting || isLoading}>
            刷新项目
          </button>
        </div>
        {hint && <div className="session-hint">{hint}</div>}
      </div>

      <div className="session-list">
        <h4>Sessions ({filteredSessions.length})</h4>
        <div className="session-toolbar">
          <button type="button" onClick={handleCreate} disabled={isSubmitting}>新建</button>
          <button
            type="button"
            onClick={() => void handleDeleteSessions(Array.from(selectedSessionIds))}
            disabled={isSubmitting || selectedCount === 0}
          >
            删除选中 {selectedCount > 0 ? `(${selectedCount})` : ''}
          </button>
        </div>
        {isLoading && <div className="loading">Loading...</div>}
        {!isLoading && filteredSessions.length === 0 && (
          <div className="empty-sessions">当前目录下暂无会话</div>
        )}
        {filteredSessions.length > 0 && (
          <div className="session-list-items">
            {filteredSessions.map((session) => {
              const isSelected = selectedSessionIds.has(session.id);
              const isActive = currentSession?.id === session.id;
              const previewLines = buildSessionPreviewLines(session);
              return (
                <button
                  key={session.id}
                  type="button"
                  className={`session-item ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
                  onClick={(event) => handleRowClick(session.id, event)}
                  onDoubleClick={() => { void handleSwitchSession(session.id); }}
                  onContextMenu={(event) => handleContextMenu(event, session.id)}
                >
                  <span className="session-check" aria-hidden="true">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => handleToggleSelection(session.id, true)}
                      onClick={(event) => event.stopPropagation()}
                    />
                  </span>
                  <span className="session-content">
                    <span className="session-name">{session.name}</span>
                    <span className="session-meta">{new Date(session.lastAccessedAt).toLocaleString()}</span>
                    {previewLines.map((line, index) => (
                      <span className="session-preview" key={`${session.id}-preview-${index}`}>{line}</span>
                    ))}
                    <span className="session-meta">{session.id}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {contextMenu && contextSession && (
        <div
          className="session-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" onClick={() => { void handleSwitchSession(contextSession.id); setContextMenu(null); }}>
            打开会话
          </button>
          <button type="button" onClick={() => { void handleRenameSession(contextSession.id); }}>
            重命名
          </button>
          <button type="button" onClick={() => { void handleCreate(); setContextMenu(null); }}>
            新建会话
          </button>
          <button
            type="button"
            onClick={() => {
              if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return;
              void navigator.clipboard.writeText(contextSession.id);
              setContextMenu(null);
            }}
          >
            复制 Session ID
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => { void handleDeleteSessions(deleteTargetIds); }}
          >
            删除 {deleteTargetIds.length > 1 ? `(${deleteTargetIds.length})` : ''}
          </button>
        </div>
      )}

      <div className="session-selected-info">
        {selectedSession ? `已选: ${selectedSession.name}` : selectedCount > 1 ? `已多选 ${selectedCount} 个会话` : '未选择会话'}
      </div>
    </div>
  );
};

const AIProviderTab: FC = () => {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);

  const refreshProviders = useCallback(async () => {
    setIsLoading(true);
    try {
      const next = await listProviders();
      setProviders(next);
      setHint(null);
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const handleSelectProvider = useCallback(async (providerId: string) => {
    setBusyProviderId(providerId);
    try {
      await selectProvider(providerId);
      await refreshProviders();
      setHint(`已切换 provider: ${providerId}`);
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyProviderId(null);
    }
  }, [refreshProviders]);

  const handleTestProvider = useCallback(async (providerId: string) => {
    setBusyProviderId(providerId);
    try {
      const result = await testProvider(providerId);
      setHint(`${providerId}: ${result.message}`);
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyProviderId(null);
    }
  }, []);

  const handleEnsureRoutecodex = useCallback(async () => {
    setBusyProviderId('routecodex-5520');
    try {
      await upsertProvider({
        id: 'routecodex-5520',
        name: 'routecodex-local-5520',
        baseUrl: 'http://127.0.0.1:5520',
        wireApi: 'responses',
        select: false,
      });
      await refreshProviders();
      setHint('已写入 routecodex-5520 配置');
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyProviderId(null);
    }
  }, [refreshProviders]);

  return (
    <div className="tab-content">
      <div className="provider-list">
        {providers.map((provider) => {
          const active = provider.isActive === true;
          const busy = busyProviderId === provider.id;
          return (
            <div key={provider.id} className={`provider-item ${active ? 'active' : ''}`}>
              <div className="provider-main">
                <span className="provider-name">
                  {provider.name}
                  {active ? ' (当前)' : ''}
                </span>
                <span className={`status ${provider.status}`}>
                  {provider.status === 'connected' ? 'Connected' : provider.status === 'error' ? 'Error' : 'Idle'}
                </span>
              </div>
              <div className="provider-meta">{provider.baseUrl}</div>
              <div className="provider-meta">
                {provider.model ? `model=${provider.model}` : 'model=default'}
              </div>
              <div className="provider-actions">
                <button
                  type="button"
                  onClick={() => {
                    void handleTestProvider(provider.id);
                  }}
                  disabled={busy}
                >
                  测试
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleSelectProvider(provider.id);
                  }}
                  disabled={busy || active}
                >
                  切换
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <button className="add-provider-btn" type="button" onClick={() => { void handleEnsureRoutecodex(); }} disabled={busyProviderId === 'routecodex-5520'}>
        + 添加 5520 RouteCodex
      </button>
      <button className="add-provider-btn secondary" type="button" onClick={() => { void refreshProviders(); }} disabled={isLoading}>
        刷新 Provider 列表
      </button>
      {hint && <div className="provider-hint">{hint}</div>}
    </div>
  );
};

const SettingsTab = () => (
  <div className="tab-content">
    <div className="setting-item">
      <label htmlFor="theme-select">Theme</label>
      <select id="theme-select" defaultValue="Dark">
        <option value="Dark">Dark</option>
        <option value="Light">Light</option>
      </select>
    </div>
    <div className="setting-item">
      <label htmlFor="log-level-select">Log Level</label>
      <select id="log-level-select" defaultValue="Info">
        <option value="Info">Info</option>
        <option value="Debug">Debug</option>
        <option value="Warn">Warn</option>
      </select>
    </div>
  </div>
);
