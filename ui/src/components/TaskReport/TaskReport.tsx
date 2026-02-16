import React from 'react';
import type { TaskReport as TaskReportType } from '../../api/types.js';
import './TaskReport.css';

interface TaskReportProps {
  report: TaskReportType | null;
  isOpen: boolean;
  onClose: () => void;
}

export const TaskReport: React.FC<TaskReportProps> = ({ report, isOpen, onClose }) => {
  if (!isOpen || !report) return null;

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return '✓';
      case 'failed': return '✗';
      case 'in_progress': return '⏳';
      default: return '○';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return '#10b981';
      case 'failed': return '#ef4444';
      case 'in_progress': return '#f59e0b';
      default: return '#6b7280';
    }
  };

  return (
    <div className="task-report-overlay" onClick={onClose}>
      <div className="task-report-modal" onClick={(e) => e.stopPropagation()}>
        <div className="task-report-header">
          <h2>任务执行报告</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="task-report-summary">
          <div className={`report-status ${report.summary.success ? 'success' : 'partial'}`}>
            {report.summary.success ? '✓ 全部成功' : '⚠ 部分完成'}
          </div>
          
          <div className="summary-grid">
            <div className="summary-card">
              <span className="value">{report.summary.totalTasks}</span>
              <span className="label">总任务</span>
            </div>
            <div className="summary-card success">
              <span className="value">{report.summary.completed}</span>
              <span className="label">已完成</span>
            </div>
            <div className="summary-card error">
              <span className="value">{report.summary.failed}</span>
              <span className="label">失败</span>
            </div>
            <div className="summary-card">
              <span className="value">{report.summary.rounds}</span>
              <span className="label">编排轮次</span>
            </div>
          </div>

          <div className="report-meta">
            <div>
              <strong>用户任务:</strong> {report.userTask}
            </div>
            <div>
              <strong>工作流 ID:</strong> {report.workflowId}
            </div>
            <div>
              <strong>开始时间:</strong> {new Date(report.createdAt).toLocaleString()}
            </div>
            {report.completedAt && (
              <div>
                <strong>完成时间:</strong> {new Date(report.completedAt).toLocaleString()}
              </div>
            )}
          </div>
        </div>

        <div className="task-details">
          <h3>任务详情</h3>
          <div className="task-list">
            {report.taskDetails.map((task, idx) => (
              <div key={task.taskId} className={`task-item ${task.status}`}>
                <div className="task-number">{idx + 1}</div>
                <div className="task-status-icon" style={{ color: getStatusColor(task.status) }}>
                  {getStatusIcon(task.status)}
                </div>
                <div className="task-content">
                  <div className="task-description">{task.description}</div>
                  {task.assignee && <div className="task-assignee">执行者: {task.assignee}</div>}
                  {task.output && <div className="task-output">{task.output}</div>}
                  {task.error && <div className="task-error">错误: {task.error}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
