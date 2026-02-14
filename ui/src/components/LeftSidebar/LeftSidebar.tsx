import React, { useState } from 'react';
import './LeftSidebar.css';

type Tab = 'project' | 'ai-provider' | 'settings';

export const LeftSidebar: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('project');

  return (
    <div className="left-sidebar-container">
      <div className="sidebar-tabs">
        <button
          className={`tab-btn ${activeTab === 'project' ? 'active' : ''}`}
          onClick={() => setActiveTab('project')}
        >
          Project
        </button>
        <button
          className={`tab-btn ${activeTab === 'ai-provider' ? 'active' : ''}`}
          onClick={() => setActiveTab('ai-provider')}
        >
          AI Provider
        </button>
        <button
          className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
      </div>

      <div className="sidebar-content">
        {activeTab === 'project' && <ProjectTab />}
        {activeTab === 'ai-provider' && <AIProviderTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
};

const ProjectTab: React.FC = () => (
  <div className="tab-content">
    <h3>Project Management</h3>
    <div className="folder-picker">
      <button>Select Project Folder</button>
    </div>
    <div className="session-list">
      <h4>Sessions</h4>
      <div className="session-item active">~/.finger/sessions/project-demo</div>
      <div className="session-item">~/.finger/sessions/another-project</div>
    </div>
  </div>
);

const AIProviderTab: React.FC = () => (
  <div className="tab-content">
    <h3>AI Providers</h3>
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
    <button className="add-provider-btn">+ Add Provider</button>
  </div>
);

const SettingsTab: React.FC = () => (
  <div className="tab-content">
    <h3>System Settings</h3>
    <div className="setting-item">
      <label>Theme</label>
      <select>
        <option>Dark</option>
        <option>Light</option>
      </select>
    </div>
    <div className="setting-item">
      <label>Log Level</label>
      <select>
        <option>Info</option>
        <option>Debug</option>
        <option>Warn</option>
      </select>
    </div>
  </div>
);
