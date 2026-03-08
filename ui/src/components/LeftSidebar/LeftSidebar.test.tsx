import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LeftSidebar } from './LeftSidebar.js';

vi.mock('../../api/client.js', () => ({
  listProviders: vi.fn().mockResolvedValue([]),
  selectProvider: vi.fn().mockResolvedValue({ success: true }),
  testProvider: vi.fn().mockResolvedValue({ success: true }),
  upsertProvider: vi.fn().mockResolvedValue({ success: true }),
  deleteProjectSessions: vi.fn().mockResolvedValue({ success: true }),
  pickProjectDirectory: vi.fn().mockResolvedValue({ canceled: true, path: null }),
}));

describe('LeftSidebar project running state', () => {
  const baseSessions = [
    {
      id: 'session-orch',
      name: 'Orchestrator Session',
      projectPath: '/workspace/a',
      createdAt: '2026-02-28T00:00:00.000Z',
      updatedAt: '2026-02-28T00:00:00.000Z',
      lastAccessedAt: '2026-02-28T00:00:00.000Z',
      messageCount: 2,
      activeWorkflows: ['wf-1'],
    },
    {
      id: 'session-idle',
      name: 'Idle Session',
      projectPath: '/workspace/b',
      createdAt: '2026-02-28T00:00:00.000Z',
      updatedAt: '2026-02-28T00:00:00.000Z',
      lastAccessedAt: '2026-02-28T00:00:00.000Z',
      messageCount: 0,
      activeWorkflows: [],
    },
  ];

  it('shows project in running bucket when session has activeWorkflows', () => {
    render(
      <LeftSidebar
        sessions={baseSessions}
        currentSession={baseSessions[0]}
        isLoadingSessions={false}
        onCreateSession={vi.fn().mockResolvedValue(baseSessions[0])}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onRenameSession={vi.fn().mockResolvedValue(baseSessions[0])}
        onSwitchSession={vi.fn().mockResolvedValue(undefined)}
        onRefreshSessions={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByText('Project'));
    expect(screen.queryByText('暂无运行项目')).toBeNull();
    expect(screen.getByText('a')).toBeTruthy();
  });

  it('shows empty running bucket when no session has activeWorkflows', () => {
    const idleOnly = baseSessions.map((item) => ({ ...item, activeWorkflows: [] }));

    render(
      <LeftSidebar
        sessions={idleOnly}
        currentSession={idleOnly[0]}
        isLoadingSessions={false}
        onCreateSession={vi.fn().mockResolvedValue(idleOnly[0])}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onRenameSession={vi.fn().mockResolvedValue(idleOnly[0])}
        onSwitchSession={vi.fn().mockResolvedValue(undefined)}
        onRefreshSessions={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByText('Project'));
    expect(screen.getByText('暂无运行项目')).toBeTruthy();
  });

  it('runtime session list follows focused runtime instance instead of selected agent config', () => {
    render(
      <LeftSidebar
        sessions={baseSessions}
        currentSession={baseSessions[0]}
        isLoadingSessions={false}
        runtimeInstances={[
          {
            id: 'runtime-executor-1',
            agentId: 'finger-executor',
            name: 'Executor',
            type: 'executor',
            status: 'running',
            sessionId: 'session-executor-1',
            totalDeployments: 1,
          },
          {
            id: 'runtime-reviewer-1',
            agentId: 'finger-reviewer',
            name: 'Reviewer',
            type: 'reviewer',
            status: 'idle',
            sessionId: 'session-reviewer-1',
            totalDeployments: 1,
          },
        ]}
        focusedRuntimeInstanceId="runtime-executor-1"
        activeRuntimeSessionId="session-executor-1"
        onSwitchRuntimeInstance={vi.fn()}
        onCreateSession={vi.fn().mockResolvedValue(baseSessions[0])}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onRenameSession={vi.fn().mockResolvedValue(baseSessions[0])}
        onSwitchSession={vi.fn().mockResolvedValue(undefined)}
        onRefreshSessions={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByText('Project'));
    expect(screen.getByText('Agent Sessions (1)')).toBeTruthy();
    expect(screen.getByText('finger-executor')).toBeTruthy();
    expect(screen.queryByText('Reviewer')).toBeNull();
  });

  it('runtime session list uses config display name and exposes agentId/sessionId separately', () => {
    render(
      <LeftSidebar
        sessions={baseSessions}
        currentSession={baseSessions[0]}
        isLoadingSessions={false}
        runtimeInstances={[
          {
            id: 'runtime-orch-1',
            agentId: 'finger-orchestrator',
            name: 'runtime-orch-1',
            type: 'orchestrator',
            status: 'running',
            sessionId: 'runtime-session-1',
            totalDeployments: 1,
          },
        ]}
        runtimeAgents={[
          {
            id: 'finger-orchestrator',
            name: 'finger-orchestrator',
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
        runtimeConfigs={[
          {
            id: 'finger-orchestrator',
            name: 'Orchestrator',
            role: 'orchestrator',
            filePath: '/tmp/finger-orchestrator/agent.json',
            enabled: true,
            capabilities: [],
            defaultQuota: 1,
            quotaPolicy: { workflowQuota: {} },
          },
        ]}
        focusedRuntimeInstanceId="runtime-orch-1"
        activeRuntimeSessionId="runtime-session-1"
        onSwitchRuntimeInstance={vi.fn()}
        onCreateSession={vi.fn().mockResolvedValue(baseSessions[0])}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onRenameSession={vi.fn().mockResolvedValue(baseSessions[0])}
        onSwitchSession={vi.fn().mockResolvedValue(undefined)}
        onRefreshSessions={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByText('Project'));
    expect(screen.getByText('Orchestrator')).toBeTruthy();
    expect(screen.getByText('运行中 · agent finger-orchestrator')).toBeTruthy();
    expect(screen.getByText('session runtime-session-1')).toBeTruthy();
    expect(screen.queryByText('finger-orchestrator')).toBeNull();
  });
});
