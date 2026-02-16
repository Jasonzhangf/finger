import React from 'react';
import type { AgentExecutionDetail } from '../../api/types.js';
import './ExecutionModal.css';

interface ExecutionModalProps {
  isOpen: boolean;
  onClose: () => void;
  detail: AgentExecutionDetail | null;
}

export const ExecutionModal: React.FC<ExecutionModalProps> = ({ isOpen, onClose, detail }) => {
  if (!isOpen || !detail) return null;

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'running': return '#10b981';
      case 'error': return '#ef4444';
      case 'paused': return '#f59e0b';
      default: return '#3b82f6';
    }
  };

  return (
    <div className="execution-modal-overlay" onClick={onClose}>
      <div className="execution-modal" onClick={(e) => e.stopPropagation()}>
        <div className="execution-modal-header">
          <div>
            <h2>{detail.agentName}</h2>
            <span className="agent-id">{detail.agentId}</span>
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="execution-summary">
          <div className="summary-item">
            <span className="label">状态</span>
            <span className="value" style={{ color: getStatusColor(detail.status) }}>
              {detail.status}
            </span>
          </div>
          <div className="summary-item">
            <span className="label">当前轮次</span>
            <span className="value">{detail.currentRound}/{detail.totalRounds}</span>
          </div>
          <div className="summary-item">
            <span className="label">任务</span>
            <span className="value">{detail.taskDescription || detail.taskId || 'N/A'}</span>
          </div>
          <div className="summary-item">
            <span className="label">开始时间</span>
            <span className="value">{new Date(detail.startTime).toLocaleString()}</span>
          </div>
        </div>

        <div className="execution-steps">
          <h3>执行迭代详情</h3>
          {detail.steps.length === 0 ? (
            <div className="empty-steps">暂无执行步骤数据</div>
          ) : (
            <div className="steps-list">
              {detail.steps.map((step) => (
                <div key={`${step.round}-${step.timestamp}`} className="step-card">
                  <div className="step-header">
                    <span className="step-round">Round {step.round}</span>
                    <span className={`step-status ${step.success ? 'success' : 'error'}`}>
                      {step.success ? '✓ 成功' : '✗ 失败'}
                    </span>
                    <span className="step-time">
                      {new Date(step.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="step-action">Action: {step.action}</div>
                  {step.thought && <div className="step-thought">Thought: {step.thought}</div>}
                  {step.observation && <div className="step-observation">Observation: {step.observation}</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        {detail.sessionFilePath && (
          <div className="execution-footer">
            <a href={`file://${detail.sessionFilePath}`} target="_blank" rel="noreferrer">
              查看完整日志文件 →
            </a>
          </div>
        )}
      </div>
    </div>
  );
};
