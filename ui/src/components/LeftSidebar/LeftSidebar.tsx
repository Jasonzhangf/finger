import { useMemo, useState, useEffect, useRef, useCallback, type FC, type MouseEvent as ReactMouseEvent } from 'react';
import type { SessionInfo } from '../../api/types.js';
import type { ProviderConfig } from '../../api/types.js';
import { listProviders, selectProvider, testProvider, upsertProvider } from '../../api/client.js';
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
}

interface ProjectTabProps {
  sessions: SessionInfo[];
  currentSession: SessionInfo | null;
  isLoading: boolean;
  onCreateSession: (projectPath: string, name?: string) => Promise<SessionInfo>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onRenameSession: (sessionId: string, name: string) => Promise<SessionInfo>;
  onSwitchSession: (sessionId: string) => Promise<void>;
}

const TABS: Array<{ key: SidebarTab; label: string }> = [
  { key: 'project', label: 'Project' },
  { key: 'ai-provider', label: 'AI Provider' },
  { key: 'settings', label: 'Settings' },
];

const WORKDIR_STORAGE_KEY = 'finger-ui-workdir';

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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

interface DirectoryPickerHandle {
  name: string;
}

interface WindowWithDirectoryPicker extends Window {
  showDirectoryPicker?: () => Promise<DirectoryPickerHandle>;
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
}) => {
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const autoSwitchKeyRef = useRef('');
  const autoCreateKeyRef = useRef('');

  useEffect(() => {
    const stored = localStorage.getItem(WORKDIR_STORAGE_KEY);
    if (stored && stored.trim().length > 0) {
      setWorkingDirectory(stored.trim());
      return;
    }
    if (currentSession?.projectPath) {
      setWorkingDirectory(currentSession.projectPath);
    }
  }, [currentSession?.projectPath]);

  useEffect(() => {
    const next = workingDirectory.trim();
    if (!next) return;
    localStorage.setItem(WORKDIR_STORAGE_KEY, next);
  }, [workingDirectory]);

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

  const knownDirectories = useMemo(
    () => Array.from(new Set(sortedSessions.map((session) => session.projectPath))).sort((a, b) => a.localeCompare(b)),
    [sortedSessions],
  );

  const filteredSessions = useMemo(() => {
    const normalizedWorkdir = normalizePath(workingDirectory);
    if (!normalizedWorkdir) return sortedSessions;
    return sortedSessions.filter((session) => normalizePath(session.projectPath).startsWith(normalizedWorkdir));
  }, [sortedSessions, workingDirectory]);

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

  useEffect(() => {
    const normalizedWorkdir = normalizePath(workingDirectory);
    if (!normalizedWorkdir || filteredSessions.length > 0 || isSubmitting) return;

    const autoCreateKey = `${normalizedWorkdir}:empty`;
    if (autoCreateKeyRef.current === autoCreateKey) return;
    autoCreateKeyRef.current = autoCreateKey;

    setIsSubmitting(true);
    setHint('当前目录无会话，正在创建...');
    void onCreateSession(workingDirectory.trim())
      .then((created) => {
        setSelectedSessionIds(new Set([created.id]));
        setHint(`已自动创建会话: ${created.name}`);
      })
      .catch((error: unknown) => {
        setHint(error instanceof Error ? error.message : '自动创建会话失败');
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  }, [filteredSessions.length, isSubmitting, onCreateSession, workingDirectory]);

  useEffect(() => {
    const normalizedWorkdir = normalizePath(workingDirectory);
    if (!normalizedWorkdir || filteredSessions.length === 0) {
      autoSwitchKeyRef.current = '';
      return;
    }

    const latest = filteredSessions[0];
    const autoSwitchKey = `${normalizedWorkdir}:${latest.id}`;
    if (autoSwitchKeyRef.current === autoSwitchKey) return;
    if (currentSession?.id === latest.id) {
      autoSwitchKeyRef.current = autoSwitchKey;
      return;
    }

    autoSwitchKeyRef.current = autoSwitchKey;

    setIsSubmitting(true);
    setHint(`已切换到最新会话: ${latest.name}`);
    void onSwitchSession(latest.id)
      .then(() => {
        setSelectedSessionIds(new Set([latest.id]));
      })
      .catch((error: unknown) => {
        setHint(error instanceof Error ? error.message : '自动加载会话失败');
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  }, [currentSession?.id, filteredSessions, onSwitchSession, workingDirectory]);

  const selectedCount = selectedSessionIds.size;
  const selectedSession = useMemo(() => {
    if (selectedSessionIds.size !== 1) return null;
    const [id] = Array.from(selectedSessionIds);
    return filteredSessions.find((session) => session.id === id) ?? null;
  }, [filteredSessions, selectedSessionIds]);

  const handlePickDirectory = async () => {
    const maybeWindow = window as WindowWithDirectoryPicker;
    if (typeof maybeWindow.showDirectoryPicker !== 'function') {
      setHint('当前浏览器不支持目录选择，请手动输入绝对路径');
      return;
    }

    try {
      const handle = await maybeWindow.showDirectoryPicker();
      const matched = knownDirectories.filter((item) => normalizePath(item).endsWith(`/${normalizePath(handle.name)}`));
      if (matched.length > 0) {
        setWorkingDirectory(matched[0]);
      } else {
        setWorkingDirectory(handle.name);
        setHint('目录已选择，请补全为 daemon 可访问的绝对路径');
      }
    } catch {
      // user cancel
    }
  };

  const handleUseCurrentDir = () => {
    if (!currentSession?.projectPath) return;
    setWorkingDirectory(currentSession.projectPath);
    setHint(null);
  };

  const handleCreate = async () => {
    const target = workingDirectory.trim();
    if (!target) {
      setHint('请先输入工作目录绝对路径');
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

  const handleSwitchSession = useCallback(async (sessionId: string) => {
    setIsSubmitting(true);
    setHint(null);
    try {
      await onSwitchSession(sessionId);
      setSelectedSessionIds(new Set([sessionId]));
      const selected = filteredSessions.find((session) => session.id === sessionId);
      setHint(`已加载会话: ${selected?.name || sessionId}`);
    } catch (error) {
      setHint(error instanceof Error ? error.message : '加载会话失败');
    } finally {
      setIsSubmitting(false);
    }
  }, [filteredSessions, onSwitchSession]);

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
    handleToggleSelection(sessionId, event.metaKey || event.ctrlKey);
  }, [handleToggleSelection]);

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
      <div className="folder-picker">
        <label htmlFor="workdir-input">工作目录</label>
        <input
          id="workdir-input"
          list="workdir-options"
          type="text"
          placeholder="/absolute/path/to/project"
          value={workingDirectory}
          onChange={(e) => setWorkingDirectory(e.target.value)}
        />
        <datalist id="workdir-options">
          {knownDirectories.map((path) => (
            <option value={path} key={path} />
          ))}
        </datalist>
        <div className="folder-picker-actions">
          <button type="button" onClick={handlePickDirectory}>选择文件夹</button>
          <button type="button" onClick={handleUseCurrentDir} disabled={!currentSession?.projectPath}>使用当前目录</button>
        </div>
        <button type="button" onClick={handleCreate} disabled={isSubmitting}>新建会话</button>
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
