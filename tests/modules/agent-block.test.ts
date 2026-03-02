import { describe, it, expect } from 'vitest';
import { AgentBlock } from '../../src/blocks/agent-block/index.js';

describe('AgentBlock', () => {
  it('spawns and lists agents', async () => {
    const block = new AgentBlock('agent-test');
    const agent = await block.execute('spawn', { role: 'executor', sdk: 'codex' });
    expect(agent).toMatchObject({ role: 'executor', sdk: 'codex', status: 'idle' });

    const list = await block.execute('list', {});
    expect((list as Array<{ id: string }>).some(a => a.id === (agent as { id: string }).id)).toBe(true);
  });

  it('returns status and heartbeat', async () => {
    const block = new AgentBlock('agent-test');
    const agent = await block.execute('spawn', { role: 'reviewer', sdk: 'codex' });
    const id = (agent as { id: string }).id;

    const status = await block.execute('status', { agentId: id });
    expect(status).toMatchObject({ id, role: 'reviewer' });

    const hb = await block.execute('heartbeat', { agentId: id });
    expect(hb).toEqual({ alive: true });
  });

  it('kill returns killed true', async () => {
    const block = new AgentBlock('agent-test');
    const agent = await block.execute('spawn', { role: 'executor', sdk: 'codex' });
    const id = (agent as { id: string }).id;

    const killed = await block.execute('kill', { agentId: id });
    expect(killed).toEqual({ killed: true });
  });
});
