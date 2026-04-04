import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeMock = vi.fn(async () => ({ success: true, output: 'ok' }));
const parseCommandsMock = vi.fn((input: string) => ({
  commands: input.trim().length > 0 ? [{ raw: input }] : [],
}));

vi.mock('../../../src/blocks/command-hub/index.js', () => ({
  parseCommands: parseCommandsMock,
  getCommandHub: () => ({
    execute: executeMock,
  }),
}));

import { registerAgentRuntimeTools } from '../../../src/server/modules/agent-runtime.js';

interface RegisteredTool {
  name: string;
  inputSchema?: Record<string, unknown>;
  handler: (input: unknown, context?: Record<string, unknown>) => Promise<unknown>;
}

describe('agent-runtime command.exec tool', () => {
  beforeEach(() => {
    executeMock.mockClear();
    parseCommandsMock.mockClear();
  });

  it('normalizes wrapped/aliased command.exec input shape', async () => {
    const tools = new Map<string, RegisteredTool>();
    const runtime = {
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      }),
      getCurrentSession: vi.fn(() => ({ id: 'session-main' })),
    };

    registerAgentRuntimeTools({
      runtime,
      askManager: { open: vi.fn() },
      eventBus: { emit: vi.fn(async () => undefined) },
      broadcast: vi.fn(),
      sessionManager: { getSession: vi.fn(() => null) },
      agentRuntimeBlock: { execute: vi.fn(async () => ({})) },
      primaryOrchestratorAgentId: 'finger-system-agent',
    } as any);

    const tool = tools.get('command.exec');
    if (!tool) throw new Error('command.exec tool missing');

    const result = await tool.handler({
      payload: {
        cmd: '<##display:\"progress:on\"##>',
      },
    });

    expect(parseCommandsMock).toHaveBeenCalledWith('<##display:"progress:on"##>');
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, output: 'ok' });
  });
});
