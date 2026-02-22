import React from 'react';
import './SessionResumeDialog.css';

interface SessionResumeDialogProps {
  isOpen: boolean;
  sessionId: string;
  progress: number;
  originalTask: string;
  timestamp: string;
  onResume: () => void;
  onStartFresh: () => void;
  onClose: () => void;
}

export const SessionResumeDialog: React.FC<SessionResumeDialogProps> = ({
  isOpen,
  sessionId,
  progress,
  originalTask,
  timestamp,
  onResume,
  onStartFresh,
  onClose,
}) => {
  if (!isOpen) return null;

  const formattedDate = new Date(timestamp).toLocaleString('zh-CN');
  
  return (
    <div className="session-resume-overlay">
      <div className="session-resume-dialog">
        <div className="dialog-header">
          <h3>📋 发现未完成的会话</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        
        <div className="dialog-content">
          <div className="session-info">
            <div className="info-row">
              <span className="label">会话ID:</span>
              <span className="value">{sessionId}</span>
            </div>
            <div className="info-row">
              <span className="label">最后更新:</span>
              <span className="value">{formattedDate}</span>
            </div>
            <div className="info-row">
              <span className="label">原始任务:</span>
              <span className="value task-preview">{originalTask}</span>
            </div>
            <div className="info-row">
              <span className="label">完成进度:</span>
              <div className="progress-bar">
                <div 
                  className="progress-fill" 
                  style={{ width: `${progress}%` }}
                />
                <span className="progress-text">{progress.toFixed(1)}%</span>
              </div>
            </div>
          </div>
          
          <div className="dialog-actions">
            <button className="btn-secondary" onClick={onStartFresh}>
              🔄 开始新会话
            </button>
            <button className="btn-primary" onClick={onResume}>
              ▶️ 恢复会话
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
