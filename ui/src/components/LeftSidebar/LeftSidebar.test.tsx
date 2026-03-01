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
});

