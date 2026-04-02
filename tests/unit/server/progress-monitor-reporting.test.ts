import { describe, it, expect } from 'vitest';
import { buildCompactSummary } from '../../../src/server/modules/progress-monitor-reporting.js';
import type { SessionProgressData } from '../../../src/server/modules/progress-monitor-utils.js';

const formatElapsed = (ms: number) => `${Math.floor(ms / 1000)}s`;

describe('progress-monitor-reporting', () => {
  it('shows full update_plan list instead of single step', () => {
    const data: SessionProgressData = {
      agentId: 'finger-system-agent',
      status: 'running',
      currentTask: 'update_plan → ✅',
      elapsedMs: 10_000,
      toolCallHistory: [
        {
          toolName: 'update_plan',
          params: JSON.stringify({
            plan: [
              { step: 'Collect requirements', status: 'completed' },
              { step: 'Implement progress rendering', status: 'in_progress' },
              { step: 'Run tests and verify output', status: 'pending' },
            ],
          }),
          success: true,
        },
      ],
    };

    const result = buildCompactSummary(data, formatElapsed, { headerMode: 'minimal' });
    expect(result).toContain('计划共 3 项');
    expect(result).toContain('✓ Collect requirements');
    expect(result).toContain('▶ Implement progress rendering');
    expect(result).toContain('○ Run tests and verify output');
  });

  it('shows dispatch task identity and content preview', () => {
    const data: SessionProgressData = {
      agentId: 'finger-system-agent',
      status: 'running',
      currentTask: 'agent.dispatch → ✅',
      elapsedMs: 10_000,
      toolCallHistory: [
        {
          toolName: 'agent.dispatch',
          params: JSON.stringify({
            target_agent_id: 'finger-project-agent',
            assignment: { taskName: 'Fix progress report details' },
            metadata: { taskId: 'task-123' },
            task: 'Update progress monitor so write_stdin/update_plan/dispatch are fully visible',
          }),
          success: true,
        },
      ],
    };

    const result = buildCompactSummary(data, formatElapsed, { headerMode: 'minimal' });
    expect(result).toContain('→ finger-project-agent');
    expect(result).toContain('task=task-123');
    expect(result).toContain('name=Fix progress report details');
    expect(result).toContain('内容=Update progress monitor');
  });

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

  it('shows semantic read detail for shell cat command', () => {
    const data: SessionProgressData = {
      agentId: 'finger-system-agent',
      status: 'running',
      currentTask: 'cat → ✅',
      elapsedMs: 8_000,
      toolCallHistory: [
        {
          toolName: 'shell.exec',
          params: JSON.stringify({ cmd: 'cat /tmp/runtime.log' }),
          success: true,
        },
      ],
    };

    const result = buildCompactSummary(data, formatElapsed, { headerMode: 'minimal' });
    expect(result).toContain('📖 读取 /tmp/runtime.log');
  });

  it('shows semantic search detail for rg command', () => {
    const data: SessionProgressData = {
      agentId: 'finger-system-agent',
      status: 'running',
      currentTask: 'rg → ✅',
      elapsedMs: 8_000,
      toolCallHistory: [
        {
          toolName: 'shell.exec',
          params: JSON.stringify({ cmd: 'rg "mailbox" src/server/modules' }),
          success: true,
        },
      ],
    };

    const result = buildCompactSummary(data, formatElapsed, { headerMode: 'minimal' });
    expect(result).toContain('🔍 搜索「mailbox」');
    expect(result).toContain('src/server/modules');
  });

  it('shows semantic follow detail for tail -f command', () => {
    const data: SessionProgressData = {
      agentId: 'finger-system-agent',
      status: 'running',
      currentTask: 'tail → ✅',
      elapsedMs: 8_000,
      toolCallHistory: [
        {
          toolName: 'shell.exec',
          params: JSON.stringify({ cmd: 'tail -f ~/.finger/logs/daemon.log' }),
          success: true,
        },
      ],
    };

    const result = buildCompactSummary(data, formatElapsed, { headerMode: 'minimal' });
    expect(result).toContain('📜 跟踪日志');
    expect(result).toContain('daemon.log');
  });

  it('folds repeated search actions and keeps latest keyword hints', () => {
    const data: SessionProgressData = {
      agentId: 'finger-system-agent',
      status: 'running',
      currentTask: '搜索中',
      elapsedMs: 20_000,
      toolCallHistory: [
        {
          toolName: 'shell.exec',
          params: JSON.stringify({ cmd: 'rg "mailbox" src/server/modules' }),
          success: true,
        },
        {
          toolName: 'shell.exec',
          params: JSON.stringify({ cmd: 'rg "dispatch" src/server/modules' }),
          success: true,
        },
        {
          toolName: 'shell.exec',
          params: JSON.stringify({ cmd: 'rg "heartbeat" src/server/modules' }),
          success: true,
        },
      ],
    };

    const result = buildCompactSummary(data, formatElapsed, { headerMode: 'minimal' });
    const searchLineCount = result
      .split('\n')
      .filter((line) => line.includes('[搜索]') && line.includes('×3'))
      .length;
    expect(searchLineCount).toBe(1);
    expect(result).toContain('×3');
    expect(result).toContain('最近关键词');
    expect(result).toContain('dispatch');
    expect(result).toContain('heartbeat');
  });

  it('shows module token breakdown in release mode when context breakdown is available', () => {
    const data: SessionProgressData = {
      agentId: 'finger-system-agent',
      status: 'running',
      currentTask: '处理中',
      elapsedMs: 12_000,
      toolCallHistory: [],
      contextUsagePercent: 35,
      maxInputTokens: 262144,
      contextBreakdownMode: 'release',
      contextBreakdown: {
        historyContextTokens: 20_000,
        historyCurrentTokens: 12_000,
        systemPromptTokens: 2_400,
        developerPromptTokens: 1_600,
        userInstructionsTokens: 1_000,
        environmentContextTokens: 700,
        turnContextTokens: 400,
        skillsTokens: 3_000,
        mailboxTokens: 900,
        projectTokens: 4_200,
        inputTextTokens: 500,
        inputMediaTokens: 120,
        inputTotalTokens: 620,
        toolsSchemaTokens: 6_000,
        toolExecutionTokens: 300,
        contextLedgerConfigTokens: 200,
        responsesConfigTokens: 350,
        totalKnownTokens: 53_690,
      },
    };

    const result = buildCompactSummary(data, formatElapsed, { headerMode: 'minimal' });
    expect(result).toContain('🧩 构成: H(');
    expect(result).toContain('🧩 构成: I(');
    expect(result).not.toContain('🧪 校验:');
    expect(result).toContain('c=');
    expect(result).toContain('sys=');
    expect(result).toContain('sk=');
    expect(result).toContain('T(schema=');
    expect(result).toContain('text=');
    expect(result).toContain('Σ=');
  });

  it('shows detailed layout lines in dev mode', () => {
    const data: SessionProgressData = {
      agentId: 'finger-system-agent',
      status: 'running',
      currentTask: '处理中',
      elapsedMs: 12_000,
      toolCallHistory: [],
      contextUsagePercent: 20,
      maxInputTokens: 262144,
      contextBreakdownMode: 'dev',
      contextBreakdown: {
        historyContextTokens: 10_000,
        historyCurrentTokens: 8_000,
        systemPromptTokens: 2_000,
        developerPromptTokens: 1_500,
        userInstructionsTokens: 600,
        environmentContextTokens: 400,
        turnContextTokens: 220,
        skillsTokens: 900,
        mailboxTokens: 300,
        projectTokens: 1_000,
        inputTextTokens: 180,
        inputMediaTokens: 40,
        inputTotalTokens: 220,
        toolsSchemaTokens: 2_400,
        toolExecutionTokens: 160,
        contextLedgerConfigTokens: 120,
        responsesConfigTokens: 110,
        totalKnownTokens: 27_930,
      },
    };

    const result = buildCompactSummary(data, formatElapsed, { headerMode: 'minimal' });
    expect(result).toContain('🧩 构成: H(');
    expect(result).toContain('🧩 构成: I(');
    expect(result).toContain('🧩 构成: E(');
    expect(result).toContain('Σ=');
    expect(result).not.toContain('🧪 校验:');
  });

  it('keeps tracked-only layout even when context usage is higher than known modules', () => {
    const data: SessionProgressData = {
      agentId: 'finger-system-agent',
      status: 'running',
      currentTask: '处理中',
      elapsedMs: 12_000,
      toolCallHistory: [],
      contextUsagePercent: 45,
      estimatedTokensInContextWindow: 120_000,
      maxInputTokens: 262144,
      contextBreakdownMode: 'dev',
      contextBreakdown: {
        historyContextTokens: 0,
        historyCurrentTokens: 27_200,
        systemPromptTokens: 7_000,
        developerPromptTokens: 12_700,
        skillsTokens: 1_200,
        mailboxTokens: 69,
        projectTokens: 5_500,
        inputTextTokens: 291,
        inputMediaTokens: 0,
        inputTotalTokens: 291,
        toolsSchemaTokens: 4_400,
        toolExecutionTokens: 40,
        contextLedgerConfigTokens: 43,
        responsesConfigTokens: 42,
        totalKnownTokens: 90_800,
      },
    };

    const result = buildCompactSummary(data, formatElapsed, { headerMode: 'minimal' });
    expect(result).toContain('🧩 构成: E(');
    expect(result).toContain('Σ=');
    expect(result).not.toContain('runtime_overhead');
    expect(result).not.toContain('构成[overhead说明]');
  });

  it('shows waiting hint when breakdown is unavailable', () => {
    const data: SessionProgressData = {
      agentId: 'finger-system-agent',
      status: 'running',
      currentTask: '处理中',
      elapsedMs: 8_000,
      toolCallHistory: [],
      contextUsagePercent: 12,
      maxInputTokens: 262144,
      contextBreakdownMode: 'release',
    };

    const result = buildCompactSummary(data, formatElapsed, { headerMode: 'minimal' });
    expect(result).toContain('🧩 构成统计: 等待模型回传模块占用');
  });

  it('shows control tags/hooks in dev mode when available', () => {
    const data: SessionProgressData = {
      agentId: 'finger-system-agent',
      status: 'running',
      currentTask: '处理中',
      elapsedMs: 3_000,
      toolCallHistory: [],
      contextUsagePercent: 10,
      maxInputTokens: 262144,
      contextBreakdownMode: 'dev',
      controlTags: ['debug', 'weibo', 'push'],
      controlHookNames: ['hook.project.memory.update', 'hook.context.review'],
      controlBlockValid: true,
      controlIssues: [],
    };
    const result = buildCompactSummary(data, formatElapsed, { headerMode: 'minimal' });
    expect(result).toContain('🏷 控制:');
    expect(result).toContain('tags=debug,weibo,push');
    expect(result).toContain('hooks=hook.project.memory.update,hook.context.review');
    expect(result).toContain('valid=true');
  });
});
