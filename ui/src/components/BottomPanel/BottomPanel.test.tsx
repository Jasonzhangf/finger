import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { BottomPanel } from './BottomPanel.js';

describe('BottomPanel', () => {
  it('renders running/queued/quota/last-event metrics on agent card', () => {
    render(
      <BottomPanel
        agents={[
          {
            id: 'executor-debug-loop',
            name: 'Executor Debug Loop',
            type: 'executor',
            status: 'running',
            source: 'deployment',
            instanceCount: 1,
            deployedCount: 1,
            availableCount: 0,
            runningCount: 2,
            queuedCount: 1,
            enabled: true,
            runtimeCapabilities: [],
            defaultQuota: 1,
            quotaPolicy: { workflowQuota: {} },
            quota: { effective: 3, source: 'project' },
            lastEvent: {
              type: 'dispatch',
              status: 'queued',
              summary: 'Dispatch queued (queue #1)',
              timestamp: '2026-02-27T00:00:00.000Z',
            },
            debugAssertions: [],
          },
        ]}
        instances={[]}
        configs={[]}
      />,
    );

    expect(screen.getByText('Executor Debug Loop')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Queued')).toBeTruthy();
    expect(screen.getByText('3 (project)')).toBeTruthy();
    expect(screen.getByText('Last Event: Dispatch queued (queue #1)')).toBeTruthy();
  });

  it('renders agent-runtime connection lines in agents tab', () => {
    render(
      <BottomPanel
        agents={[
          {
            id: 'finger-orchestrator',
            name: 'Finger Orchestrator',
            type: 'orchestrator',
            status: 'running',
            source: 'deployment',
            instanceCount: 1,
            deployedCount: 1,
            availableCount: 0,
            runningCount: 1,
            queuedCount: 0,
            enabled: true,
            runtimeCapabilities: [],
            defaultQuota: 1,
            quotaPolicy: { workflowQuota: {} },
            quota: { effective: 1, source: 'default' },
            debugAssertions: [],
          },
        ]}
        instances={[
          {
            id: 'runtime-orch-1',
            agentId: 'finger-orchestrator',
            name: 'runtime-orch-1',
            type: 'orchestrator',
            status: 'running',
            totalDeployments: 1,
            sessionId: 'session-1',
          },
        ]}
        configs={[]}
      />,
    );

    expect(screen.getByLabelText('agent-runtime-connections')).toBeTruthy();
    expect(screen.getAllByText('Finger Orchestrator').length).toBeGreaterThan(0);
    expect(screen.getAllByText('runtime-orch-1').length).toBeGreaterThan(0);
  });

  it('fires instance selection callback in instances tab', () => {
    const onSelectInstance = vi.fn();
    render(
      <BottomPanel
        agents={[]}
        instances={[
          {
            id: 'inst-1',
            agentId: 'executor-debug-loop',
            name: 'inst-1',
            type: 'executor',
            status: 'running',
            sessionId: 'runtime-session',
            totalDeployments: 1,
          },
        ]}
        configs={[]}
        onSelectInstance={onSelectInstance}
        currentSessionId="orch-session"
      />,
    );

    fireEvent.click(screen.getByText('Instance'));
    fireEvent.click(screen.getByText('切换会话'));
    expect(onSelectInstance).toHaveBeenCalledTimes(1);
  });

  it('supports startup panel debug toggle and template launch', async () => {
    const onSetDebugMode = vi.fn().mockResolvedValue(undefined);
    const onStartTemplate = vi.fn().mockResolvedValue(undefined);
    render(
      <BottomPanel
        agents={[]}
        instances={[]}
        configs={[]}
        debugMode={false}
        startupTemplates={[
          {
            id: 'orchestrator-loop',
            name: 'Orchestrator',
            role: 'orchestrator',
            defaultImplementationId: 'native:orchestrator-loop',
            defaultModuleId: 'orchestrator-loop',
            defaultInstanceCount: 1,
            launchMode: 'orchestrator',
          },
        ]}
        onSetDebugMode={onSetDebugMode}
        onStartTemplate={onStartTemplate}
      />,
    );

    fireEvent.click(screen.getByText('Startup'));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Debug mode'));
    });
    expect(onSetDebugMode).toHaveBeenCalledWith(true);

    await act(async () => {
      fireEvent.click(screen.getByText('启动模板'));
    });
    expect(onStartTemplate).toHaveBeenCalledWith('orchestrator-loop');
  });

  it('supports orchestration profile switch and config save in startup panel', async () => {
    const onSwitchOrchestrationProfile = vi.fn().mockResolvedValue(undefined);
    const onSaveOrchestrationConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <BottomPanel
        agents={[]}
        instances={[]}
        configs={[]}
        startupTemplates={[]}
        orchestrationConfig={{
          version: 1,
          activeProfileId: 'default',
          profiles: [
            {
              id: 'default',
              name: 'Default',
              agents: [{ targetAgentId: 'orchestrator-loop', role: 'orchestrator', enabled: true, instanceCount: 1, launchMode: 'orchestrator' }],
            },
            {
              id: 'mock',
              name: 'Mock',
              agents: [{ targetAgentId: 'orchestrator-loop', role: 'orchestrator', enabled: true, instanceCount: 1, launchMode: 'orchestrator' }],
            },
          ],
        }}
        onSwitchOrchestrationProfile={onSwitchOrchestrationProfile}
        onSaveOrchestrationConfig={onSaveOrchestrationConfig}
      />,
    );

    fireEvent.click(screen.getByText('Startup'));
    const select = screen.getByLabelText('Orchestration profile');
    await act(async () => {
      fireEvent.change(select, { target: { value: 'mock' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('快速切换'));
    });
    expect(onSwitchOrchestrationProfile).toHaveBeenCalledWith('mock');

    await act(async () => {
      fireEvent.click(screen.getByText('保存并应用配置'));
    });
    expect(onSaveOrchestrationConfig).toHaveBeenCalledTimes(1);
  });

  it('writes review policy stages to selected profile before save', async () => {
    const onSaveOrchestrationConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <BottomPanel
        agents={[]}
        instances={[]}
        configs={[]}
        startupTemplates={[]}
        orchestrationConfig={{
          version: 1,
          activeProfileId: 'default',
          profiles: [
            {
              id: 'default',
              name: 'Default',
              agents: [{ targetAgentId: 'orchestrator-loop', role: 'orchestrator', enabled: true, instanceCount: 1, launchMode: 'orchestrator' }],
            },
            {
              id: 'mock',
              name: 'Mock',
              agents: [{ targetAgentId: 'orchestrator-loop', role: 'orchestrator', enabled: true, instanceCount: 1, launchMode: 'orchestrator' }],
            },
          ],
        }}
        onSaveOrchestrationConfig={onSaveOrchestrationConfig}
      />,
    );

    fireEvent.click(screen.getByText('Startup'));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Orchestration profile'), { target: { value: 'mock' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('启用 profile review policy'));
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('执行前'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Review strictness'), { target: { value: 'strict' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('保存并应用配置'));
    });

    expect(onSaveOrchestrationConfig).toHaveBeenCalledTimes(1);
    const payload = onSaveOrchestrationConfig.mock.calls[0][0] as {
      profiles?: Array<{ id?: string; reviewPolicy?: { enabled?: boolean; stages?: string[]; strictness?: string } }>;
    };
    const mockProfile = payload.profiles?.find((profile) => profile.id === 'mock');
    expect(mockProfile?.reviewPolicy?.enabled).toBe(true);
    expect(mockProfile?.reviewPolicy?.stages).toEqual(['execution_pre', 'execution_post']);
    expect(mockProfile?.reviewPolicy?.strictness).toBe('strict');
  });

  it('supports full_mock quick launch via profile switch', async () => {
    const onSwitchOrchestrationProfile = vi.fn().mockResolvedValue(undefined);
    render(
      <BottomPanel
        agents={[]}
        instances={[]}
        configs={[]}
        startupTemplates={[]}
        orchestrationConfig={{
          version: 1,
          activeProfileId: 'default',
          profiles: [
            {
              id: 'default',
              name: 'Default',
              agents: [{ targetAgentId: 'orchestrator-loop', role: 'orchestrator', enabled: true, instanceCount: 1, launchMode: 'orchestrator' }],
            },
            {
              id: 'full_mock',
              name: 'Full Mock',
              agents: [{ targetAgentId: 'orchestrator-loop', role: 'orchestrator', enabled: true, instanceCount: 1, launchMode: 'orchestrator' }],
            },
          ],
        }}
        onSwitchOrchestrationProfile={onSwitchOrchestrationProfile}
      />,
    );

    fireEvent.click(screen.getByText('Startup'));
    await act(async () => {
      fireEvent.click(screen.getByText('启动 Full Mock'));
    });
    expect(onSwitchOrchestrationProfile).toHaveBeenCalledWith('full_mock');
  });
});
