import { describe, it, expect } from 'vitest';
import { buildCompactSummary } from '../../../src/server/modules/progress-monitor-reporting.js';
import type { SessionProgressData } from '../../../src/server/modules/progress-monitor-utils.js';

const formatElapsed = (ms: number) => `${Math.floor(ms / 1000)}s`;

describe('progress-monitor-reporting', () => {
  it('shows stdin write content instead of generic command label', () => {
    const data: SessionProgressData = {
      agentId: 'finger-system-agent',
      status: 'running',
      currentTask: 'write_stdin → ✅',
      elapsedMs: 10_000,
      toolCallHistory: [
        {
          toolName: 'write_stdin',
          params: JSON.stringify({ chars: 'echo hello\nexit\n' }),
          success: true,
        },
      ],
    };

    const result = buildCompactSummary(data, formatElapsed, { headerMode: 'minimal' });
    expect(result).toContain('✍');
    expect(result).toContain('echo hello\\nexit\\n');
  });

  it('shows wait duration for stdin polling when chars is empty', () => {
    const data: SessionProgressData = {
      agentId: 'finger-system-agent',
      status: 'running',
      currentTask: 'write_stdin → ✅',
      elapsedMs: 10_000,
      toolCallHistory: [
        {
          toolName: 'write_stdin',
          params: JSON.stringify({ chars: '', yield_time_ms: 30000 }),
          success: true,
        },
      ],
    };

    const result = buildCompactSummary(data, formatElapsed, { headerMode: 'minimal' });
    expect(result).toContain('⏱ 等待输出 30s');
  });

  it('shows sleep duration for exec-like tools', () => {
    const data: SessionProgressData = {
      agentId: 'finger-system-agent',
      status: 'running',
      currentTask: 'sleep → ✅',
      elapsedMs: 8_000,
      toolCallHistory: [
        {
          toolName: 'command.exec',
          params: JSON.stringify({ input: 'sleep 120' }),
          success: true,
        },
      ],
    };

    const result = buildCompactSummary(data, formatElapsed, { headerMode: 'minimal' });
    expect(result).toContain('⏱ sleep 120s');
  });
});

