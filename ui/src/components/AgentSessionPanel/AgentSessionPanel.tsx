import { type FC, useState, useMemo } from 'react';
import { ChatInterface } from '../ChatInterface/ChatInterface.js';
import type { InputCapability } from '../ChatInterface/ChatInterface.js';
import { useWorkflowExecution } from '../../hooks/useWorkflowExecution.js';
import './AgentSessionPanel.css';

export interface AgentSessionPanelProps {
  projectPath: string;
  sessionId: string;
  sessions: Array<{ id: string; name: string; status?: string; lastMessage?: string }>;
  scheduledTasks: Array<{ id: string; title: string; status: string; nextRun?: string }>;
  selectedSessionId?: string;
  onSelectSession?: (sessionId: string) => void;
  hideProjectPath?: boolean;
  onOpenProject?: () => void;
  chatAgents?: Array<{ id: string; name: string; status: string }>;
  inputCapability?: InputCapability;
}

type TabType = 'path' | 'tasks' | 'sessions' | null;

const ChatSessionView: FC<{
  sessionId: string;
  projectPath: string;
  chatAgents: Array<{ id: string; name: string; status: string }>;
  inputCapability?: InputCapability;
}> = ({ sessionId, projectPath, chatAgents, inputCapability }) => {
  const {
    executionState,
    runtimeEvents,
    contextEditableEventIds,
    agentRunStatus,
    runtimeOverview,
    toolPanelOverview,
    sendUserInput,
    pauseWorkflow,
    resumeWorkflow,
    interruptCurrentTurn,
    selectedAgentId,
    setSelectedAgentId,
    isConnected,
    debugSnapshotsEnabled,
    setDebugSnapshotsEnabled,
    debugSnapshots,
    clearDebugSnapshots,
    orchestratorRuntimeMode,
    requestDetailsEnabled,
    setRequestDetailsEnabled,
  } = useWorkflowExecution(sessionId, projectPath);

  const panelTitle = useMemo(() => {
    return `Session: ${sessionId.slice(0, 8)}`;
  }, [sessionId]);

  return (
    <ChatInterface
      executionState={executionState}
      agents={chatAgents}
      events={runtimeEvents}
      contextEditableEventIds={contextEditableEventIds}
      agentRunStatus={agentRunStatus}
      runtimeOverview={runtimeOverview}
      toolPanelOverview={toolPanelOverview}
      onUpdateToolExposure={() => false}
      onSendMessage={sendUserInput}
      onEditMessage={() => Promise.resolve(false)}
      onDeleteMessage={() => Promise.resolve(false)}
      onCreateNewSession={() => Promise.resolve()}
      onPause={pauseWorkflow}
      onResume={resumeWorkflow}
      onInterruptTurn={interruptCurrentTurn}
      isPaused={executionState?.paused || false}
      isConnected={isConnected}
      onAgentClick={setSelectedAgentId}
      selectedAgentId={selectedAgentId}
      inputCapability={inputCapability}
      debugSnapshotsEnabled={debugSnapshotsEnabled}
      onToggleDebugSnapshots={setDebugSnapshotsEnabled}
      debugSnapshots={debugSnapshots}
      onClearDebugSnapshots={clearDebugSnapshots}
      orchestratorRuntimeMode={orchestratorRuntimeMode}
      requestDetailsEnabled={requestDetailsEnabled}
      onToggleRequestDetails={setRequestDetailsEnabled}
      panelTitle={panelTitle}
      showRuntimeModeBadge={false}
    />
  );
};

export const AgentSessionPanel: FC<AgentSessionPanelProps> = ({
  projectPath,
  sessionId,
  sessions,
  scheduledTasks,
  selectedSessionId,
  onSelectSession,
  hideProjectPath = false,
  onOpenProject,
  chatAgents = [],
  inputCapability,
}) => {
  const [activeTab, setActiveTab] = useState<TabType>(null);

  const handleOpenProject = () => {
    if (onOpenProject) {
      onOpenProject();
    }
  };

  const activeSessionId = selectedSessionId || sessionId;

  return (
    <div className="agent-session-panel">
      {/* Left sidebar with compact tabs */}
      <div className="agent-session-tabs">
        {!hideProjectPath && (
          <div
            className={`tab-item ${activeTab === 'path' ? 'active' : ''}`}
            onClick={() => setActiveTab(activeTab === 'path' ? null : 'path')}
            title="项目路径"
          >
            <span className="tab-icon">📁</span>
            <span className="tab-label">路径</span>
          </div>
        )}
        <div
          className={`tab-item ${activeTab === 'tasks' ? 'active' : ''}`}
          onClick={() => setActiveTab(activeTab === 'tasks' ? null : 'tasks')}
          title="定时任务"
        >
          <span className="tab-icon">⏰</span>
          <span className="tab-label">任务</span>
          {scheduledTasks.length > 0 && (
            <span className="tab-badge">{scheduledTasks.length}</span>
          )}
        </div>
        <div
          className={`tab-item ${activeTab === 'sessions' ? 'active' : ''}`}
          onClick={() => setActiveTab(activeTab === 'sessions' ? null : 'sessions')}
          title="会话列表"
        >
          <span className="tab-icon">💬</span>
          <span className="tab-label">会话</span>
          {sessions.length > 0 && (
            <span className="tab-badge">{sessions.length}</span>
          )}
        </div>
      </div>

      {/* Expandable panel for active tab */}
      {activeTab && (
        <div className="agent-session-sidebar">
          {activeTab === 'path' && !hideProjectPath && (
            <div className="sidebar-panel">
              <div className="sidebar-header">
                <span>项目路径</span>
                <button
                  className="open-project-btn"
                  onClick={handleOpenProject}
                  title="打开项目目录选择器"
                >
                  打开目录
                </button>
              </div>
              <div className="sidebar-content path-content">
                {projectPath || '未设置'}
              </div>
            </div>
          )}
          {activeTab === 'tasks' && (
            <div className="sidebar-panel">
              <div className="sidebar-header">
                <span>定时任务</span>
              </div>
              <div className="sidebar-content">
                {scheduledTasks.length === 0 ? (
                  <div className="empty-state">暂无任务</div>
                ) : (
                  scheduledTasks.map((task) => (
                    <div key={task.id} className="task-item">
                      <div className="task-title">{task.title}</div>
                      <div className="task-meta">{task.status} {task.nextRun ? `· ${task.nextRun}` : ''}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
          {activeTab === 'sessions' && (
            <div className="sidebar-panel">
              <div className="sidebar-header">
                <span>会话列表</span>
              </div>
              <div className="sidebar-content">
                {sessions.length === 0 ? (
                  <div className="empty-state">暂无会话</div>
                ) : (
                  sessions.map((session) => (
                    <div
                      key={session.id}
                      className={`session-item ${session.id === activeSessionId ? 'active' : ''}`}
                      onClick={() => onSelectSession?.(session.id)}
                    >
                      <div className="session-title">{session.name}</div>
                      <div className="session-meta">{session.status ?? 'idle'}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main chat area */}
      <div className="agent-session-panel-main">
        {activeSessionId ? (
          <ChatSessionView
            sessionId={activeSessionId}
            projectPath={projectPath}
            chatAgents={chatAgents}
            inputCapability={inputCapability}
          />
        ) : (
          <div className="empty-state">请选择一个会话</div>
        )}
      </div>
    </div>
  );
};
