import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ensureDir, FINGER_PATHS } from '../core/finger-paths.js';

export interface ProjectState {
  projectPath: string;
  enabledAgents: string[];
  lastOpenedAt: string;
  version: string;
}

const PROJECT_STATE_VERSION = '1';

function getProjectStatePath(projectPath: string): string {
  const hash = crypto.createHash('sha256').update(projectPath).digest('hex');
  return path.join(path.join(FINGER_PATHS.runtime.dir, "state"), `${hash}.json`);
}

export function readProjectState(projectPath: string): ProjectState | null {
  const statePath = getProjectStatePath(projectPath);
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    const content = readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    return {
      projectPath: parsed.projectPath ?? projectPath,
      enabledAgents: Array.isArray(parsed.enabledAgents) ? parsed.enabledAgents : [],
      lastOpenedAt: parsed.lastOpenedAt ?? new Date().toISOString(),
      version: parsed.version ?? PROJECT_STATE_VERSION,
    };
  } catch {
    return null;
  }
}

export function writeProjectState(state: ProjectState): void {
  const statePath = getProjectStatePath(state.projectPath);
  ensureDir(path.dirname(statePath));
  const content = JSON.stringify({
    ...state,
    version: PROJECT_STATE_VERSION,
    lastOpenedAt: new Date().toISOString(),
  }, null, 2);
  writeFileSync(statePath, content, 'utf-8');
}

export function updateProjectStateEnabledAgents(
  projectPath: string,
  enabledAgents: string[],
): ProjectState {
  const existing = readProjectState(projectPath);
  const newState: ProjectState = {
    projectPath,
    enabledAgents,
    lastOpenedAt: new Date().toISOString(),
    version: PROJECT_STATE_VERSION,
  };
  writeProjectState(newState);
  return newState;
}

export function getDefaultEnabledAgents(): string[] {
  return ['finger-project-agent'];
}
