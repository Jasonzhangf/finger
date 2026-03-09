import React, { useState, useCallback } from 'react';
import './CreateAgentDialog.css';

interface CreateAgentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (agentId: string, name: string, role: string) => Promise<void>;
  isCreating: boolean;
}

export const CreateAgentDialog: React.FC<CreateAgentDialogProps> = ({
  isOpen,
  onClose,
  onCreate,
  isCreating,
}) => {
  const [agentId, setAgentId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('general');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!agentId.trim()) {
      setError('Agent ID is required');
      return;
    }
    setError(null);
    try {
      await onCreate(agentId.trim(), name.trim() || agentId.trim(), role.trim() || 'general');
      setAgentId('');
      setName('');
      setRole('general');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    }
  }, [agentId, name, role, onCreate]);

  if (!isOpen) return null;

  return (
    <div className="create-agent-overlay" onClick={onClose}>
      <div className="create-agent-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Create New Agent</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit} className="dialog-content">
          <div className="form-group">
            <label htmlFor="agentId">Agent ID *</label>
            <input
              id="agentId"
              type="text"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="my-new-agent"
              disabled={isCreating}
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="agentName">Name</label>
            <input
              id="agentName"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My New Agent"
              disabled={isCreating}
            />
          </div>
          <div className="form-group">
            <label htmlFor="agentRole">Role</label>
            <select
              id="agentRole"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={isCreating}
            >
              <option value="general">General</option>
              <option value="orchestrator">Orchestrator</option>
              <option value="researcher">Researcher</option>
              <option value="executor">Executor</option>
              <option value="coder">Coder</option>
              <option value="reviewer">Reviewer</option>
            </select>
          </div>
          {error && <div className="error-message">{error}</div>}
          <div className="dialog-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={isCreating}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={isCreating || !agentId.trim()}>
              {isCreating ? 'Creating...' : 'Create Agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
