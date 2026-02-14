import { useMemo, useState } from 'react';
import './LeftSidebar.css';

type SidebarTab = 'project' | 'ai-provider' | 'settings';

const TABS: Array<{ key: SidebarTab; label: string }> = [
  { key: 'project', label: 'Project' },
  { key: 'ai-provider', label: 'AI Provider' },
  { key: 'settings', label: 'Settings' },
];

export const LeftSidebar = () => {
  const [activeTab, setActiveTab] = useState<SidebarTab | null>(null);

  const panelTitle = useMemo(() => {
    if (activeTab === 'project') return 'Project Management';
    if (activeTab === 'ai-provider') return 'AI Provider';
    if (activeTab === 'settings') return 'System Settings';
    return '';
  }, [activeTab]);

  const onTabClick = (tab: SidebarTab) => {
    setActiveTab((prev) => (prev === tab ? null : tab));
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
            {activeTab === 'project' && <ProjectTab />}
            {activeTab === 'ai-provider' && <AIProviderTab />}
            {activeTab === 'settings' && <SettingsTab />}
          </div>
        </aside>
      )}
    </div>
  );
};

const ProjectTab = () => (
  <div className="tab-content">
    <div className="folder-picker">
      <button type="button">Select Project Folder</button>
    </div>

    <div className="session-list">
      <h4>Sessions</h4>
      <button type="button" className="session-item active">
        ~/.finger/sessions/project-demo
      </button>
      <button type="button" className="session-item">
        ~/.finger/sessions/another-project
      </button>
    </div>
  </div>
);

const AIProviderTab = () => (
  <div className="tab-content">
    <div className="provider-list">
      <div className="provider-item">
        <span>OpenAI</span>
        <span className="status connected">Connected</span>
      </div>
      <div className="provider-item">
        <span>Anthropic</span>
        <span className="status disconnected">Not configured</span>
      </div>
      <div className="provider-item">
        <span>Local (Ollama)</span>
        <span className="status disconnected">Offline</span>
      </div>
    </div>
    <button className="add-provider-btn" type="button">+ Add Provider</button>
  </div>
);

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
