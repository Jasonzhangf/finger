import { describe, it, expect } from 'vitest';
import { classifyToolCall, extractTargetFile, buildCompactSummary, buildReportKey, resolveToolDisplayName } from '../../../src/server/modules/progress-monitor-utils.js';
import type { SessionProgressData } from '../../../src/server/modules/progress-monitor-utils.js';

describe('progress-monitor-utils', () => {
  describe('classifyToolCall', () => {
    it('classifies shell.exec with cat as 读写', () => {
      expect(classifyToolCall('shell.exec', { cmd: 'cat src/index.ts' })).toBe('读写');
    });

    it('classifies shell.exec with rg as 搜索', () => {
      expect(classifyToolCall('shell.exec', { cmd: 'rg "pattern" src/' })).toBe('搜索');
    });

    it('classifies shell.exec with grep as 搜索', () => {
      expect(classifyToolCall('shell.exec', { cmd: 'grep -r "foo" .' })).toBe('搜索');
    });

    it('classifies shell.exec with git commit as 读写', () => {
      expect(classifyToolCall('shell.exec', { cmd: 'git commit -m "msg"' })).toBe('读写');
    });

    it('classifies shell.exec with pnpm install as 读写', () => {
      expect(classifyToolCall('shell.exec', { cmd: 'pnpm install' })).toBe('读写');
    });

    it('classifies web_search as 搜索', () => {
      expect(classifyToolCall('web_search')).toBe('搜索');
    });

    it('classifies apply_patch as 读写', () => {
      expect(classifyToolCall('apply_patch', { patch: '--- a/file.ts' })).toBe('读写');
    });

    it('classifies agent.* as 工具', () => {
      expect(classifyToolCall('agent.dispatch')).toBe('工具');
      expect(classifyToolCall('agent.deploy')).toBe('工具');
    });

    it('classifies context_ledger as 工具', () => {
      expect(classifyToolCall('context_ledger.read')).toBe('工具');
    });

    it('classifies update_plan as 工具', () => {
      expect(classifyToolCall('update_plan')).toBe('工具');
    });

    it('classifies unknown tool as 其他', () => {
      expect(classifyToolCall('unknown_tool')).toBe('其他');
    });

    it('handles JSON string input', () => {
      expect(classifyToolCall('shell.exec', JSON.stringify({ cmd: 'rg "test"' }))).toBe('搜索');
    });
  });

  describe('extractTargetFile', () => {
    it('extracts file from apply_patch', () => {
      expect(extractTargetFile('apply_patch', { patch: '--- a/src/server/index.ts' })).toBe('src/server/index.ts');
    });

    it('extracts file from cat command', () => {
      expect(extractTargetFile('shell.exec', { cmd: 'cat src/server/index.ts' })).toBe('src/server/index.ts');
    });

    it('extracts file from rg command', () => {
      expect(extractTargetFile('shell.exec', { cmd: 'rg "pattern" src/server/index.ts' })).toBe('src/server/index.ts');
    });

    it('returns empty for no file', () => {
      expect(extractTargetFile('update_plan', {})).toBe('');
    });

    it('extracts path from workdir', () => {
      expect(extractTargetFile('shell.exec', { workdir: '/tmp/project' })).toBe('/tmp/project');
    });
  });

  const formatElapsed = (ms: number) => `${Math.floor(ms / 60000)}m`;

  describe('buildCompactSummary', () => {
    

    it('builds summary with reasoning', () => {
      const data: SessionProgressData = {
        agentId: 'finger-system-agent',
        status: 'running',
        currentTask: '分析代码',
        elapsedMs: 120000,
        toolCallHistory: [],
        latestReasoning: '需要检查 event-forwarding.ts 的逻辑',
      };
      const result = buildCompactSummary(data, formatElapsed);
      expect(result).toContain('📊 finger-system-agent | 2m | 分析代码');
      expect(result).toContain('💭 需要检查 event-forwarding.ts 的逻辑');
    });

    it('builds summary with tool calls showing category and file', () => {
      const data: SessionProgressData = {
        agentId: 'finger-system-agent',
        status: 'running',
        elapsedMs: 60000,
        toolCallHistory: [
          { toolName: 'shell.exec', params: JSON.stringify({ cmd: 'cat src/index.ts' }), success: true },
          { toolName: 'apply_patch', params: JSON.stringify({ patch: '--- a/src/server/routes.ts' }), success: true },
          { toolName: 'shell.exec', params: JSON.stringify({ cmd: 'rg "test"' }), success: false },
        ],
      };
      const result = buildCompactSummary(data, formatElapsed);
      expect(result).toContain('✅ [读写] cat | src/index.ts');
      expect(result).toContain('✅ [读写] apply_patch | src/server/routes.ts');
      expect(result).toContain('❌ [搜索] rg'); // parsed from shell.exec cmd
    });

    it('does not include raw params or result JSON', () => {
      const data: SessionProgressData = {
        agentId: 'test',
        status: 'running',
        elapsedMs: 5000,
        toolCallHistory: [
          { toolName: 'shell.exec', params: '{"cmd":"ls -la"}', success: true },
        ],
      };
      const result = buildCompactSummary(data, formatElapsed);
      expect(result).not.toContain('{"cmd"');
      expect(result).not.toContain('{"ok"');
      expect(result).not.toContain('"stdout"');
    });

    it('shows 执行中 when no current task', () => {
      const data: SessionProgressData = {
        agentId: 'test',
        status: 'running',
        elapsedMs: 30000,
        toolCallHistory: [],
      };
      const result = buildCompactSummary(data, formatElapsed);
      expect(result).toContain('执行中');
    });

    it('supports minimal header and delta-only task/reasoning lines', () => {
      const data: SessionProgressData = {
        agentId: 'finger-system-agent',
        status: 'running',
        currentTask: '分析代码',
        elapsedMs: 120000,
        toolCallHistory: [],
        latestReasoning: '需要检查 event-forwarding.ts 的逻辑',
      };
      const result = buildCompactSummary(data, formatElapsed, {
        headerMode: 'minimal',
        includeTask: false,
        includeReasoning: false,
      });
      expect(result).toContain('📊 finger-system-agent | 2m');
      expect(result).not.toContain('分析代码');
      expect(result).not.toContain('需要检查 event-forwarding.ts 的逻辑');
    });
  });

  describe('buildReportKey', () => {
    it('produces same key for same state', () => {
      const data: SessionProgressData = {
        agentId: 'test',
        status: 'running',
        currentTask: 'task1',
        elapsedMs: 1000,
        toolCallHistory: [
          { toolName: 'shell.exec', params: '{"cmd":"ls"}', success: true },
        ],
      };
      const key1 = buildReportKey(data, 'step1');
      const key2 = buildReportKey(data, 'step1');
      expect(key1).toBe(key2);
    });

    it('produces different key for different reasoning', () => {
      const data: SessionProgressData = {
        agentId: 'test',
        status: 'running',
        elapsedMs: 1000,
        toolCallHistory: [],
      };
      const key1 = buildReportKey({ ...data, latestReasoning: 'thought1' }, undefined);
      const key2 = buildReportKey({ ...data, latestReasoning: 'thought2' }, undefined);
      expect(key1).not.toBe(key2);
    });
  });

  describe('resolveToolDisplayName', () => {
    it('parses shell.exec command verb', () => {
      expect(resolveToolDisplayName('shell.exec', { cmd: 'cat src/index.ts' })).toBe('cat');
    });

    it('parses JSON string input for shell.exec', () => {
      expect(resolveToolDisplayName('shell.exec', JSON.stringify({ cmd: 'rg "pattern" src' }))).toBe('rg');
    });

    it('keeps known command family with subcommand', () => {
      expect(resolveToolDisplayName('shell.exec', { cmd: 'git commit -m "x"' })).toBe('git commit');
      expect(resolveToolDisplayName('shell.exec', { cmd: 'pnpm test' })).toBe('pnpm test');
    });

    it('returns original tool name for non-shell tools', () => {
      expect(resolveToolDisplayName('update_plan')).toBe('update_plan');
    });
  });


  describe('extractToolDetail', () => {
    // extractToolDetail is internal, we test it through buildCompactSummary output

    it('update_plan shows in_progress step', () => {
      const data: SessionProgressData = {
        agentId: 'test',
        status: 'running',
        elapsedMs: 60000,
        toolCallHistory: [
          {
            toolName: 'update_plan',
            params: JSON.stringify({
              plan: [
                { step: 'Fix dispatch tags', status: 'completed' },
                { step: 'Build context builder', status: 'in_progress' },
                { step: 'Write tests', status: 'pending' },
              ],
            }),
            success: true,
          },
        ],
      };
      const result = buildCompactSummary(data, formatElapsed);
      expect(result).toContain('▶');
      expect(result).toContain('Build context builder');
    });

    it('update_plan shows completed step when no in_progress', () => {
      const data: SessionProgressData = {
        agentId: 'test',
        status: 'running',
        elapsedMs: 60000,
        toolCallHistory: [
          {
            toolName: 'update_plan',
            params: JSON.stringify({
              plan: [
                { step: 'First step done', status: 'completed' },
                { step: 'Second step done', status: 'completed' },
              ],
            }),
            success: true,
          },
        ],
      };
      const result = buildCompactSummary(data, formatElapsed);
      expect(result).toContain('✓');
      expect(result).toContain('Second step done');
    });

    it('web_search shows the search query', () => {
      const data: SessionProgressData = {
        agentId: 'test',
        status: 'running',
        elapsedMs: 30000,
        toolCallHistory: [
          {
            toolName: 'web_search',
            params: JSON.stringify({ query: 'openclaw-weixin npm plugin' }),
            success: true,
          },
        ],
      };
      const result = buildCompactSummary(data, formatElapsed);
      expect(result).toContain('「');
      expect(result).toContain('openclaw-weixin');
      expect(result).toContain('」');
    });

    it('web_search with q parameter shows query', () => {
      const data: SessionProgressData = {
        agentId: 'test',
        status: 'running',
        elapsedMs: 30000,
        toolCallHistory: [
          {
            toolName: 'web_search',
            params: JSON.stringify({ q: 'typescript context builder pattern' }),
            success: true,
          },
        ],
      };
      const result = buildCompactSummary(data, formatElapsed);
      expect(result).toContain('「typescript context builder pattern');
    });

    it('agent.dispatch shows target agent', () => {
      const data: SessionProgressData = {
        agentId: 'test',
        status: 'running',
        elapsedMs: 30000,
        toolCallHistory: [
          {
            toolName: 'agent.dispatch',
            params: JSON.stringify({ target_agent_id: 'finger-project-agent' }),
            success: true,
          },
        ],
      };
      const result = buildCompactSummary(data, formatElapsed);
      expect(result).toContain('→ finger-project-agent');
    });

    it('write_stdin shows the chars being written', () => {
      const data: SessionProgressData = {
        agentId: 'test',
        status: 'running',
        elapsedMs: 30000,
        toolCallHistory: [
          {
            toolName: 'write_stdin',
            params: JSON.stringify({ chars: 'sed -i "s/old/new/" file.ts' }),
            success: true,
          },
        ],
      };
      const result = buildCompactSummary(data, formatElapsed);
      expect(result).toContain('\u270d'); // ✍
      expect(result).toContain('sed -i');
    });
  });
});
