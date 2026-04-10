import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveOrchestrationConfig } from '../../../src/orchestration/orchestration-config.js';
import {
  buildAgentEnvelope,
  prefixAgentResponse,
} from '../../../src/server/routes/message-helpers.js';

function withTempFingerHome(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'finger-message-helper-name-'));
  const previousHome = process.env.FINGER_HOME;
  process.env.FINGER_HOME = dir;
  try {
    run(dir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.FINGER_HOME;
    } else {
      process.env.FINGER_HOME = previousHome;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('message-helpers agent naming', () => {
  it('uses configured system agent name in envelope and response prefix', () => {
    withTempFingerHome(() => {
      saveOrchestrationConfig({
        version: 1,
        activeProfileId: 'default',
        profiles: [
          {
            id: 'default',
            name: 'Default',
            agents: [
              { targetAgentId: 'finger-system-agent', role: 'system', enabled: true },
              { targetAgentId: 'finger-project-agent', role: 'project', enabled: true },
            ],
          },
        ],
        runtime: {
          systemAgent: {
            id: 'finger-system-agent',
            name: 'Mirror',
            maxInstances: 1,
          },
          projectWorkers: {
            maxWorkers: 2,
            autoNameOnFirstAssign: true,
            nameCandidates: ['Alex', 'Lisa'],
            workers: [{ id: 'finger-project-agent', name: 'Alex', enabled: true }],
          },
          reviewers: {
            maxInstances: 1,
            reviewerName: 'Sentinel',
            agents: [{ id: 'finger-reviewer', name: 'Sentinel-A', enabled: true }],
          },
        },
      });

      const envelope = buildAgentEnvelope('finger-system-agent');
      expect(envelope.name).toBe('Mirror');
      expect(envelope.role).toBe('system');
      expect(prefixAgentResponse('finger-system-agent', 'ready')).toBe('Mirror: ready');
    });
  });

  it('uses configured worker name for project agent response prefix', () => {
    withTempFingerHome(() => {
      saveOrchestrationConfig({
        version: 1,
        activeProfileId: 'default',
        profiles: [
          {
            id: 'default',
            name: 'Default',
            agents: [
              { targetAgentId: 'finger-system-agent', role: 'system', enabled: true },
              { targetAgentId: 'finger-project-agent', role: 'project', enabled: true },
              { targetAgentId: 'finger-reviewer', role: 'project', enabled: true },
            ],
          },
        ],
        runtime: {
          systemAgent: {
            id: 'finger-system-agent',
            name: 'Mirror',
            maxInstances: 1,
          },
          projectWorkers: {
            maxWorkers: 3,
            autoNameOnFirstAssign: true,
            nameCandidates: ['Lisa', 'Robert', 'Kelvin'],
            workers: [{ id: 'finger-project-agent', name: 'Lisa', enabled: true }],
          },
          reviewers: {
            maxInstances: 2,
            reviewerName: 'Sentinel',
            agents: [{ id: 'finger-reviewer', name: 'Sentinel-A', enabled: true }],
          },
        },
      });

      const envelope = buildAgentEnvelope('finger-project-agent');
      expect(envelope.name).toBe('Lisa');
      expect(envelope.role).toBe('project');
      expect(prefixAgentResponse('finger-project-agent', 'done')).toBe('Lisa: done');
    });
  });
});
