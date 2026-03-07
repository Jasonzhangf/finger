import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentConfigDrawer } from './AgentConfigDrawer.js';

describe('AgentConfigDrawer', () => {
  it('uses widened default width when no stored preference exists', () => {
    window.localStorage.removeItem('finger.agentConfigDrawer.width.v2');
    window.localStorage.removeItem('finger.agentConfigDrawer.width');

    const { container } = render(
      <AgentConfigDrawer
        isOpen
        agent={{
          id: 'orchestrator-loop',
          name: 'Orchestrator',
          type: 'orchestrator',
          status: 'idle',
          source: 'runtime-config',
          instanceCount: 0,
          deployedCount: 0,
          availableCount: 0,
          runningCount: 0,
          queuedCount: 0,
          enabled: true,
          runtimeCapabilities: [],
          defaultQuota: 1,
          quotaPolicy: { workflowQuota: {} },
          quota: { effective: 1, source: 'default' },
          debugAssertions: [],
        }}
        capabilities={null}
        config={null}
        instances={[]}
        currentSessionId={null}
        onClose={vi.fn()}
      />,
    );

    const drawer = container.querySelector('.agent-drawer') as HTMLElement | null;
    expect(drawer?.style.width).toBe('720px');
  });

  it('restores stored width preference on open', () => {
    window.localStorage.removeItem('finger.agentConfigDrawer.width');
    window.localStorage.setItem('finger.agentConfigDrawer.width.v2', '860');

    const { container } = render(
      <AgentConfigDrawer
        isOpen
        agent={{
          id: 'orchestrator-loop',
          name: 'Orchestrator',
          type: 'orchestrator',
          status: 'idle',
          source: 'runtime-config',
          instanceCount: 0,
          deployedCount: 0,
          availableCount: 0,
          runningCount: 0,
          queuedCount: 0,
          enabled: true,
          runtimeCapabilities: [],
          defaultQuota: 1,
          quotaPolicy: { workflowQuota: {} },
          quota: { effective: 1, source: 'default' },
          debugAssertions: [],
        }}
        capabilities={null}
        config={null}
        instances={[]}
        currentSessionId={null}
        onClose={vi.fn()}
      />,
    );

    const drawer = container.querySelector('.agent-drawer') as HTMLElement | null;
    expect(drawer?.style.width).toBe('860px');
  });

  it('closes on Escape key press', () => {
    const onClose = vi.fn();
    render(
      <AgentConfigDrawer
        isOpen
        agent={{
          id: 'orchestrator-loop',
          name: 'Orchestrator',
          type: 'orchestrator',
          status: 'idle',
          source: 'runtime-config',
          instanceCount: 0,
          deployedCount: 0,
          availableCount: 0,
          runningCount: 0,
          queuedCount: 0,
          enabled: true,
          runtimeCapabilities: [],
          defaultQuota: 1,
          quotaPolicy: { workflowQuota: {} },
          quota: { effective: 1, source: 'default' },
          debugAssertions: [],
        }}
        capabilities={null}
        config={null}
        instances={[]}
        currentSessionId={null}
        onClose={onClose}
      />,
    );

    expect(screen.getByText('Orchestrator')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens fullscreen prompt editor modal and renders markdown preview', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/prompts')) {
        return new Response(JSON.stringify({
          prompts: {
            system: {
              role: 'orchestrator',
              source: 'file',
              path: '/tmp/system.md',
              editablePath: '/tmp/system.md',
              content: '# Title\n\n- item\n\n```ts\nconst x = 1;\n```',
            },
            developer: {
              role: 'orchestrator',
              source: 'file',
              path: '/tmp/dev.md',
              editablePath: '/tmp/dev.md',
              content: 'dev content',
            },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ filePath: '/tmp/agent.json', config: { id: 'orchestrator-loop' } }), { status: 200 });
    }) as unknown as typeof fetch;

    render(
      <AgentConfigDrawer
        isOpen
        agent={{
          id: 'orchestrator-loop',
          name: 'Orchestrator',
          type: 'orchestrator',
          status: 'idle',
          source: 'runtime-config',
          instanceCount: 0,
          deployedCount: 0,
          availableCount: 0,
          runningCount: 0,
          queuedCount: 0,
          enabled: true,
          runtimeCapabilities: [],
          defaultQuota: 1,
          quotaPolicy: { workflowQuota: {} },
          quota: { effective: 1, source: 'default' },
          debugAssertions: [],
        }}
        capabilities={null}
        config={null}
        instances={[]}
        currentSessionId={null}
        onClose={vi.fn()}
      />,
    );

    const buttons = await screen.findAllByText('全屏编辑');
    fireEvent.click(buttons[0]);
    expect(await screen.findByText('System Prompt')).toBeTruthy();
    fireEvent.click(screen.getByText('预览'));
    expect(await screen.findByText('Title')).toBeTruthy();
    expect(screen.getByText('item')).toBeTruthy();
    expect(screen.getByText('ts')).toBeTruthy();
    expect(screen.getByText('const x = 1;')).toBeTruthy();
  });
});
