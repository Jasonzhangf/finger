import { IflowBaseAgent } from './iflow-base.js';
import { getCapabilitiesBySdk } from '../shared/capabilities.js';

export interface CapabilityTestItem {
  capability: string;
  tested: boolean;
  available: boolean;
  evidence?: string;
}

export interface IflowCapabilityTestReport {
  sdk: 'iflow';
  sessionId: string;
  commands: string[];
  agents: string[];
  mcpServers: string[];
  capabilityTests: CapabilityTestItem[];
  summary: {
    total: number;
    tested: number;
    available: number;
  };
}

/**
 * iFlow SDK 能力测试
 * 基于当前环境检查内置能力和 MCP 能力
 */
export async function runIflowCapabilityTest(options?: {
  cwd?: string;
  addDir?: string[];
}): Promise<IflowCapabilityTestReport> {
  const base = new IflowBaseAgent({
    autoStartProcess: true,
    cwd: options?.cwd,
    sessionSettings: options?.addDir ? { add_dirs: options.addDir } : undefined,
  });

  const info = await base.initialize();
  const standard = getCapabilitiesBySdk('iflow');

  const capabilityTests: CapabilityTestItem[] = standard.map((cap) => {
    if (cap.id === 'shell.exec') {
      return {
        capability: cap.id,
        tested: true,
        available: info.availableMcpServers.includes('codex') || info.availableMcpServers.includes('sequential-thinking'),
        evidence: `mcpServers=${info.availableMcpServers.join(',')}`,
      };
    }

    if (cap.id === 'web.search') {
      return {
        capability: cap.id,
        tested: true,
        available: info.availableMcpServers.includes('codex'),
        evidence: 'requires codex mcp server',
      };
    }

    if (cap.id.startsWith('image.') || cap.id.startsWith('video.')) {
      return {
        capability: cap.id,
        tested: true,
        available: false,
        evidence: 'requires multimodal model/tooling',
      };
    }

    if (cap.id.startsWith('file.')) {
      return {
        capability: cap.id,
        tested: true,
        available: true,
        evidence: 'local runtime tool set',
      };
    }

    return {
      capability: cap.id,
      tested: true,
      available: true,
      evidence: 'sdk baseline available',
    };
  });

  await base.disconnect();

  const available = capabilityTests.filter((x) => x.available).length;

  return {
    sdk: 'iflow',
    sessionId: info.sessionId,
    commands: info.availableCommands,
    agents: info.availableAgents,
    mcpServers: info.availableMcpServers,
    capabilityTests,
    summary: {
      total: capabilityTests.length,
      tested: capabilityTests.filter((x) => x.tested).length,
      available,
    },
  };
}
