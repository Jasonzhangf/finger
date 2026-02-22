import React from 'react';
import type { SessionInfo } from '../../api/types';
import './SessionRecoveryModal.css';

interface SessionRecoveryModalProps {
  sessions: SessionInfo[];
  isOpen: boolean;
  onCreateNew: () => void;
  onResumeSession: (sessionId: string) => void;
  onDismiss: () => void;
}

export const SessionRecoveryModal: React.FC<SessionRecoveryModalProps> = ({
  sessions,
  isOpen,
  onCreateNew,
  onResumeSession,
  onDismiss,
}) => {
  if (!isOpen || sessions.length === 0) return null;

  const sortedSessions = [...sessions].sort(
    (a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()
  );
  const recentSessions = sortedSessions.slice(0, 5);

  return (
    <div className="session-recovery-overlay">
      <div className="session-recovery-modal">
        <div className="modal-header">
          <h2>🔄 会话恢复</h2>
          <p>检测到未完成的会话，是否恢复？</p>
        </div>

        <div className="modal-body">
          <div className="sessions-list">
            {recentSessions.map((session) => (
              <div key={session.id} className="session-item">
                <div className="session-info">
                  <div className="session-name">{session.name || session.id}</div>
                  <div className="session-meta">
                    <span className="session-time">
                      最后访问: {new Date(session.lastAccessedAt).toLocaleString()}
                    </span>
                    <span className="session-messages">
                      {session.messageCount} 条消息
                    </span>
                  </div>
                  {session.activeWorkflows.length > 0 && (
                    <div className="session-workflows">
                      {session.activeWorkflows.length} 个活跃工作流
                    </div>
                  )}
                </div>
                <button
                  className="resume-btn"
                  onClick={() => onResumeSession(session.id)}
                >
                  恢复会话
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="modal-footer">
          <button className="new-session-btn" onClick={onCreateNew}>
            🆕 创建新会话
          </button>
          <button className="dismiss-btn" onClick={onDismiss}>
            稍后决定
          </button>
        </div>
      </div>
    </div>
  );
};

export default SessionRecoveryModal;
