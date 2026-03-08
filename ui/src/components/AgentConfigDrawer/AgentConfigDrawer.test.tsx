import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentConfigDrawer } from './AgentConfigDrawer.js';

function createDefaultFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/prompts')) {
      return new Response(JSON.stringify({
        prompts: {
          system: {
            role: 'orchestrator',
            source: 'file',
            path: '/tmp/system.md',
            editablePath: '/tmp/system.md',
            content: '# Default Title',
          },
          developer: {
            role: 'orchestrator',
            source: 'file',
            path: '/tmp/dev.md',
            editablePath: '/tmp/dev.md',
            content: 'default dev content',
          },
        },
      }), { status: 200 });
    }

    return new Response(JSON.stringify({
      filePath: '/tmp/agent.json',
      config: { id: 'orchestrator-loop', enabled: true, instanceCount: 1 },
    }), { status: 200 });
  });
}

function renderDrawer() {
  return render(
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
}

describe('AgentConfigDrawer', () => {
  beforeEach(() => {
    globalThis.fetch = createDefaultFetchMock() as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses widened default width when no stored preference exists', async () => {
    window.localStorage.removeItem('finger.agentConfigDrawer.width.v2');
    window.localStorage.removeItem('finger.agentConfigDrawer.width');

    const { container } = renderDrawer();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    const drawer = container.querySelector('.agent-drawer') as HTMLElement | null;
    expect(drawer?.style.width).toBe('720px');
  });

  it('restores stored width preference on open', async () => {
    window.localStorage.removeItem('finger.agentConfigDrawer.width');
    window.localStorage.setItem('finger.agentConfigDrawer.width.v2', '860');

    const { container } = renderDrawer();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    const drawer = container.querySelector('.agent-drawer') as HTMLElement | null;
    expect(drawer?.style.width).toBe('860px');
  });

  it('closes on Escape key press', async () => {
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
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

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

  it('closes only prompt modal on Escape and keeps drawer open', async () => {
    const onClose = vi.fn();
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
              content: '# Title',
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
        onClose={onClose}
      />,
    );

    const buttons = await screen.findAllByText('全屏编辑');
    fireEvent.click(buttons[0]);
    expect(await screen.findByText('System Prompt')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('dialog', { hidden: true }), { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByText('System Prompt')).toBeNull();
    });
    expect(screen.getByText('Orchestrator')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('edits prompt content through fullscreen modal', async () => {
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
              content: '# Before',
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
    const editor = (await screen.findAllByDisplayValue('# Before'))[0];
    fireEvent.change(editor, { target: { value: '# After' } });

    await waitFor(() => {
      expect(screen.getAllByDisplayValue('# After').length).toBeGreaterThan(0);
    });
  });

  it('preserves enabled toggle changes for the same agent', async () => {
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
              content: '# Title',
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
      return new Response(JSON.stringify({ filePath: '/tmp/agent.json', config: { id: 'orchestrator-loop', enabled: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    const { rerender } = render(
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
        config={{ id: 'orchestrator-loop', name: 'Orchestrator', filePath: '/tmp/agent.json', enabled: true }}
        instances={[]}
        currentSessionId={null}
        onClose={vi.fn()}
      />,
    );

    const checkbox = screen.getByRole('checkbox', { name: '启用' });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    await act(async () => {
      rerender(
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
          config={{ id: 'orchestrator-loop', name: 'Orchestrator', filePath: '/tmp/agent.json', enabled: true }}
          instances={[]}
          currentSessionId={null}
          onClose={vi.fn()}
        />,
      );
    });

    expect((screen.getByRole('checkbox', { name: '启用' }) as HTMLInputElement).checked).toBe(false);
  });

  it('saves runtime config into agent.json instead of deploy endpoint', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!init?.method && url.includes('/api/v1/agents/configs/orchestrator-loop/prompts')) {
        return new Response(JSON.stringify({
          prompts: {
            system: {
              role: 'orchestrator',
              source: 'file',
              path: '/tmp/system.md',
              editablePath: '/tmp/system.md',
              content: '# Title',
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
      if (!init?.method && url.includes('/api/v1/agents/configs/orchestrator-loop')) {
        return new Response(JSON.stringify({
          filePath: '/tmp/agent.json',
          config: { id: 'orchestrator-loop', enabled: true, instanceCount: 1 },
        }), { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const onSaveAgentConfig = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentConfigDrawer
        isOpen
        agent={{
          id: 'orchestrator-loop',
          name: 'Orchestrator',
          type: 'orchestrator',
          status: 'idle',
          source: 'runtime-config',
          instanceCount: 1,
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
        config={{ id: 'orchestrator-loop', name: 'Orchestrator', filePath: '/tmp/agent.json', enabled: true }}
        instances={[]}
        currentSessionId={null}
        onClose={vi.fn()}
        onSaveAgentConfig={onSaveAgentConfig}
      />,
    );

    expect(await screen.findByText('运行配置')).toBeTruthy();
    expect(screen.getByText('保存到 agent.json，下一次任务开始生效；不会立即部署实例。')).toBeTruthy();
    expect(screen.getByText('保存并应用')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText('保存并应用'));
    });

    expect(onSaveAgentConfig).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('应用并部署')).toBeNull();
    expect(screen.getByText('保存并应用')).toBeTruthy();
  });
});
