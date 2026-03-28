import { describe, expect, it } from 'vitest';

import {
  extractAgentStatusFromRuntimeView,
  isBusyAgentRuntimeStatus,
} from '../../../src/core/agent-runtime-status.js';

describe('agent-runtime-status', () => {
  it('treats active execution states as busy', () => {
    expect(isBusyAgentRuntimeStatus('running')).toBe(true);
    expect(isBusyAgentRuntimeStatus('queued')).toBe(true);
    expect(isBusyAgentRuntimeStatus('waiting_input')).toBe(true);
    expect(isBusyAgentRuntimeStatus('paused')).toBe(true);
    expect(isBusyAgentRuntimeStatus('dispatching')).toBe(true);
    expect(isBusyAgentRuntimeStatus('retrying')).toBe(true);
  });

  it('treats completed and idle states as not busy', () => {
    expect(isBusyAgentRuntimeStatus('completed')).toBe(false);
    expect(isBusyAgentRuntimeStatus('idle')).toBe(false);
    expect(isBusyAgentRuntimeStatus('')).toBe(false);
  });

  it('extracts busy state from runtime view snapshot', () => {
    expect(extractAgentStatusFromRuntimeView({
      agents: [
        { id: 'finger-system-agent', status: 'running' },
      ],
    }, 'finger-system-agent')).toEqual({
      busy: true,
      status: 'running',
    });

    expect(extractAgentStatusFromRuntimeView({
      agents: [
        { id: 'finger-system-agent', status: 'completed' },
      ],
    }, 'finger-system-agent')).toEqual({
      busy: false,
      status: 'completed',
    });

    expect(extractAgentStatusFromRuntimeView({
      agents: [
        { id: 'other-agent', status: 'running' },
      ],
    }, 'finger-system-agent')).toEqual({
      busy: null,
    });
  });
});
