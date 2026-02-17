import React from 'react';
import type { AgentExecutionDetail } from '../../api/types.js';
import './ExecutionModal.css';

interface ExecutionModalProps {
  isOpen: boolean;
  onClose: () => void;
  detail: AgentExecutionDetail | null;
}

function statusText(status: string): string {
  if (status === 'running') return 'Running';
  if (status === 'error') return 'Error';
  if (status === 'paused') return 'Paused';
  return 'Pending';
}

function statusClass(status: string): string {
  if (status === 'running') return 'status-running';
  if (status === 'error') return 'status-error';
  if (status === 'paused') return 'status-paused';
  return 'status-idle';
}

const MemoizedStepCard = React.memo(function StepCard({
  step,
}: {
  step: AgentExecutionDetail['steps'][0];
}) {
  return (
    <div className={`step-card ${step.success ? 'success' : 'error'}`}>
      <div className="step-header">
        <span className="step-round">Round {step.round}</span>
        <span className={`step-status ${step.success ? 'success' : 'error'}`}>
          {step.success ? 'Success' : 'Failed'}
        </span>
        <span className="step-time">{new Date(step.timestamp).toLocaleTimeString()}</span>
      </div>
      <div className="step-action">Action: {step.action}</div>
      {step.thought && <div className="step-thought">Thought: {step.thought}</div>}
      {step.observation && <div className="step-observation">Observation: {step.observation}</div>}
    </div>
  );
});

export const ExecutionModal = ({ isOpen, onClose, detail }: ExecutionModalProps) => {
  if (!isOpen || !detail) return null;

  const startedAt = new Date(detail.startTime).toLocaleString();
  const finishedAt = detail.endTime ? new Date(detail.endTime).toLocaleString() : 'In Progress';

  return (
    <div className="execution-modal-overlay" onClick={onClose}>
      <div className="execution-modal" onClick={(event) => event.stopPropagation()}>
        <div className="execution-modal-header">
          <div className="header-title-wrap">
            <h2>{detail.agentName}</h2>
            <span className="agent-id">{detail.agentId}</span>
          </div>
          <button className="close-btn" onClick={onClose}>
            x
          </button>
        </div>

        <div className="execution-summary">
          <div className="summary-item">
            <span className="label">Status</span>
            <span className={`value status-pill ${statusClass(detail.status)}`}>{statusText(detail.status)}</span>
          </div>
          <div className="summary-item">
            <span className="label">Round</span>
            <span className="value">{detail.currentRound}/{detail.totalRounds}</span>
          </div>
          <div className="summary-item">
            <span className="label">Task</span>
            <span className="value task-text">{detail.taskDescription || detail.taskId || 'N/A'}</span>
          </div>
          <div className="summary-item">
            <span className="label">Started</span>
            <span className="value">{startedAt}</span>
          </div>
          <div className="summary-item">
            <span className="label">Finished</span>
            <span className="value">{finishedAt}</span>
          </div>
        </div>

        <div className="execution-steps">
          <h3>Execution Timeline</h3>
          {detail.steps.length === 0 ? (
            <div className="empty-steps">No execution steps yet.</div>
          ) : (
            <div className="steps-list">
              {detail.steps.map((step) => (
                <MemoizedStepCard key={`${step.round}-${step.timestamp}`} step={step} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
