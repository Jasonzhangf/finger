import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyAgentJsonConfigs,
  loadAgentJsonConfigs,
  parseAgentJsonConfig,
} from '../../../src/runtime/agent-json-config.js';
import type { RuntimeFacade } from '../../../src/runtime/runtime-facade.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('agent json config', () => {
  it('parses valid config', () => {
    const parsed = parseAgentJsonConfig(
      {
        id: 'reviewer-1',
        role: 'reviewer',
        provider: {
          type: 'iflow',
          model: 'gpt-5.3-codex',
        },
        session: {
          bindingScope: 'finger+agent',
          resume: true,
          provider: 'iflow',
          agentId: 'reviewer',
        },
        governance: {
          iflow: {
            allowedTools: ['read_file'],
            disallowedTools: ['network'],
            approvalMode: 'default',
            injectCapabilities: true,
            capabilityIds: ['bd'],
            commandNamespace: 'cap_',
          },
        },
        tools: {
          whitelist: ['file.read'],
          blacklist: ['file.write'],
          authorizationRequired: ['shell.exec'],
        },
      },
      '/tmp/reviewer/agent.json',
    );
    expect(parsed.id).toBe('reviewer-1');
    expect(parsed.tools?.whitelist).toEqual(['file.read']);
    expect(parsed.provider?.type).toBe('iflow');
    expect(parsed.session?.bindingScope).toBe('finger+agent');
    expect(parsed.governance?.iflow?.approvalMode).toBe('default');
  });

  it('parses multi-implementation definitions', () => {
    const parsed = parseAgentJsonConfig(
      {
        id: 'executor-1',
        implementations: [
          { id: 'iflow-main', kind: 'iflow', provider: 'iflow', enabled: true },
          { id: 'native-main', kind: 'native', moduleId: 'executor-loop', enabled: true },
        ],
      },
      '/tmp/executor/agent.json',
    );

    expect(parsed.implementations).toEqual([
      { id: 'iflow-main', kind: 'iflow', provider: 'iflow', enabled: true },
      { id: 'native-main', kind: 'native', moduleId: 'executor-loop', enabled: true },
    ]);
  });

  it('loads *.agent.json and */agent.json from directory', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'finger-agent-json-'));
    tmpDirs.push(dir);

    writeFileSync(
      path.join(dir, 'executor.agent.json'),
      JSON.stringify({ id: 'executor-1', tools: { whitelist: ['shell.exec'] } }, null, 2),
      'utf-8',
    );

    const reviewerDir = path.join(dir, 'reviewer-1');
    mkdirSync(reviewerDir);
    writeFileSync(
      path.join(reviewerDir, 'agent.json'),
      JSON.stringify({ id: 'reviewer-1', tools: { whitelist: ['file.read'], blacklist: ['file.write'] } }, null, 2),
      'utf-8',
    );

    const result = loadAgentJsonConfigs(dir);
    expect(result.loaded).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.loaded.map((item) => item.config.id).sort()).toEqual(['executor-1', 'reviewer-1']);
  });

  it('applies agent tool policies to runtime facade', () => {
    const runtime = {
      clearAgentToolPolicy: vi.fn(),
      clearAgentRuntimeConfig: vi.fn(),
      applyAgentRoleToolPolicy: vi.fn(),
      setAgentToolWhitelist: vi.fn(),
      setAgentToolBlacklist: vi.fn(),
      setToolAuthorizationRequired: vi.fn(),
      setAgentRuntimeConfig: vi.fn(),
    };

    applyAgentJsonConfigs(runtime as unknown as RuntimeFacade, [
      {
        id: 'reviewer-1',
        role: 'reviewer',
        provider: {
          type: 'iflow',
          model: 'gpt-5.3-codex',
        },
        session: {
          bindingScope: 'finger+agent',
          resume: true,
          provider: 'iflow',
          agentId: 'reviewer',
        },
        governance: {
          iflow: {
            allowedTools: ['read_file'],
            disallowedTools: ['network'],
            approvalMode: 'default',
            injectCapabilities: true,
            capabilityIds: ['bd'],
            commandNamespace: 'cap_',
          },
        },
        runtime: {
          maxTurns: 8,
        },
        tools: {
          whitelist: ['file.read'],
          blacklist: ['file.write'],
          authorizationRequired: ['shell.exec'],
        },
      },
    ]);

    expect(runtime.clearAgentToolPolicy).toHaveBeenCalledWith('reviewer-1');
    expect(runtime.clearAgentRuntimeConfig).toHaveBeenCalledWith('reviewer-1');
    expect(runtime.applyAgentRoleToolPolicy).toHaveBeenCalledWith('reviewer-1', 'reviewer');
    expect(runtime.setAgentToolWhitelist).toHaveBeenCalledWith('reviewer-1', ['file.read']);
    expect(runtime.setAgentToolBlacklist).toHaveBeenCalledWith('reviewer-1', ['file.write']);
    expect(runtime.setToolAuthorizationRequired).toHaveBeenCalledWith('shell.exec', true);
    expect(runtime.setAgentRuntimeConfig).toHaveBeenCalledWith(
      'reviewer-1',
      expect.objectContaining({
        id: 'reviewer-1',
        role: 'reviewer',
        provider: {
          type: 'iflow',
          model: 'gpt-5.3-codex',
        },
        session: {
          bindingScope: 'finger+agent',
          resume: true,
          provider: 'iflow',
          agentId: 'reviewer',
        },
        runtime: {
          maxTurns: 8,
        },
      }),
    );
  });
});
