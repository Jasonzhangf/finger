import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';

export function resolveFingerHome(): string {
  const override = process.env.FINGER_HOME;
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim();
  }
  return join(homedir(), '.finger');
}

export function getFingerPaths(homeOverride?: string) {
  const home = homeOverride && homeOverride.trim().length > 0 ? homeOverride.trim() : resolveFingerHome();
  return {
    home,
    config: {
      dir: join(home, 'config'),
      file: {
        main: join(home, 'config', 'config.json'),
        legacyConfigYaml: join(home, 'config', 'config.yaml'),
        inputs: join(home, 'config', 'inputs.yaml'),
        outputs: join(home, 'config', 'outputs.yaml'),
        routes: join(home, 'config', 'routes.yaml'),
        routerConfig: join(home, 'config', 'router-config.json'),
        resourcePool: join(home, 'config', 'resource-pool.json'),
        agents: join(home, 'config', 'agents.json'),
        sessionControlPlane: join(home, 'config', 'session-control-plane.json'),
        iflowSessionMap: join(home, 'config', 'iflow-session-map.json'),
        orchestrationConfig: join(home, 'config', 'orchestration.json'),
      },
      promptsDir: join(home, 'config', 'prompts'),
    },
    runtime: {
      dir: join(home, 'runtime'),
      agentsDir: join(home, 'runtime', 'agents'),
      autostartDir: join(home, 'runtime', 'autostart'),
      capabilitiesDir: join(home, 'runtime', 'capabilities'),
      capabilitiesCliDir: join(home, 'runtime', 'capabilities', 'cli'),
      capabilitiesToolsDir: join(home, 'runtime', 'capabilities', 'tools'),
      pluginsDir: join(home, 'runtime', 'plugins'),
      pluginsCliDir: join(home, 'runtime', 'plugins', 'cli'),
      gatewaysDir: join(home, 'runtime', 'gateways'),
      clockDir: join(home, 'runtime', 'clock'),
      eventsDir: join(home, 'runtime', 'events'),
      workflowsDir: join(home, 'runtime', 'workflows'),
      daemonPid: join(home, 'runtime', 'daemon.pid'),
    },
    logs: {
      dir: join(home, 'logs'),
      daemonLog: join(home, 'logs', 'daemon.log'),
      errorsamplesDir: join(home, 'logs', 'errorsamples'),
      agentHistory: join(home, 'logs', 'agent-history.json'),
    },
    sessions: {
      dir: join(home, 'sessions'),
    },
    tmp: {
      dir: join(home, 'tmp'),
      legacyDir: join(home, 'tmp', 'legacy'),
    },
  } as const;
}

export const FINGER_HOME = resolveFingerHome();
export const FINGER_PATHS = getFingerPaths(FINGER_HOME);

let legacyMigrationDone = false;
let lastMigrationHome: string | null = null;

export function ensureDir(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
  return path;
}

export function ensureFingerLayout(): void {
  const resolvedHome = resolveFingerHome();
  const paths = resolvedHome === FINGER_PATHS.home ? FINGER_PATHS : getFingerPaths(resolvedHome);

  ensureDir(paths.home);
  ensureDir(paths.config.dir);
  ensureDir(paths.config.promptsDir);
  ensureDir(paths.runtime.dir);
  ensureDir(paths.logs.dir);
  ensureDir(paths.sessions.dir);
  ensureDir(paths.tmp.dir);
  migrateLegacyFingerHome(paths);
}

export function normalizeSessionDirName(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) return 'session-unknown';
  return normalized.startsWith('session-') ? normalized : `session-${normalized}`;
}

function moveToLegacy(sourcePath: string, paths: ReturnType<typeof getFingerPaths> = FINGER_PATHS): void {
  if (!existsSync(sourcePath)) return;
  const legacyRoot = ensureDir(paths.tmp.legacyDir);
  const name = basename(sourcePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const legacyPath = join(legacyRoot, `${name}-${timestamp}`);
  try {
    renameSync(sourcePath, legacyPath);
  } catch {
    try {
      copyFileSync(sourcePath, legacyPath);
      unlinkSync(sourcePath);
    } catch {
      // Keep source if unable to move.
    }
  }
}

function moveLegacyFile(
  sourcePath: string,
  targetPath: string,
  paths: ReturnType<typeof getFingerPaths> = FINGER_PATHS,
): void {
  if (!existsSync(sourcePath)) return;
  ensureDir(dirname(targetPath));
  if (existsSync(targetPath)) {
    moveToLegacy(sourcePath, paths);
    return;
  }
  try {
    renameSync(sourcePath, targetPath);
  } catch {
    try {
      copyFileSync(sourcePath, targetPath);
      unlinkSync(sourcePath);
    } catch {
      moveToLegacy(sourcePath, paths);
    }
  }
}

function moveLegacyDir(
  sourcePath: string,
  targetPath: string,
  paths: ReturnType<typeof getFingerPaths> = FINGER_PATHS,
): void {
  if (!existsSync(sourcePath)) return;
  const stat = statSync(sourcePath);
  if (!stat.isDirectory()) {
    moveLegacyFile(sourcePath, targetPath, paths);
    return;
  }

  if (!existsSync(targetPath)) {
    try {
      renameSync(sourcePath, targetPath);
      return;
    } catch {
      ensureDir(targetPath);
    }
  } else {
    ensureDir(targetPath);
  }

  const entries = readdirSync(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    const sourceEntry = join(sourcePath, entry.name);
    const targetEntry = join(targetPath, entry.name);
    if (entry.isDirectory()) {
      moveLegacyDir(sourceEntry, targetEntry, paths);
    } else {
      moveLegacyFile(sourceEntry, targetEntry, paths);
    }
  }

  try {
    if (readdirSync(sourcePath).length === 0) {
      rmSync(sourcePath, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup failures.
  }
}

function removeLegacyDir(dirPath: string): void {
  if (!existsSync(dirPath)) return;
  try {
    rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

export function migrateLegacyFingerHome(paths: ReturnType<typeof getFingerPaths> = FINGER_PATHS): void {
  if (legacyMigrationDone && lastMigrationHome === paths.home) return;
  legacyMigrationDone = true;
  lastMigrationHome = paths.home;

  const fileMoves: Array<{ from: string; to: string }> = [
    { from: join(paths.home, 'config.json'), to: paths.config.file.main },
    { from: join(paths.home, 'config.yaml'), to: paths.config.file.legacyConfigYaml },
    { from: join(paths.home, 'inputs.yaml'), to: paths.config.file.inputs },
    { from: join(paths.home, 'outputs.yaml'), to: paths.config.file.outputs },
    { from: join(paths.home, 'routes.yaml'), to: paths.config.file.routes },
    { from: join(paths.home, 'router-config.json'), to: paths.config.file.routerConfig },
    { from: join(paths.home, 'resource-pool.json'), to: paths.config.file.resourcePool },
    { from: join(paths.home, 'agents.json'), to: paths.config.file.agents },
    { from: join(paths.home, 'session-control-plane.json'), to: paths.config.file.sessionControlPlane },
    { from: join(paths.home, 'iflow-session-map.json'), to: paths.config.file.iflowSessionMap },
    { from: join(paths.home, 'orchestration.json'), to: paths.config.file.orchestrationConfig },
    { from: join(paths.home, 'daemon.pid'), to: paths.runtime.daemonPid },
    { from: join(paths.home, 'daemon.log'), to: paths.logs.daemonLog },
    { from: join(paths.home, 'agent-history.json'), to: paths.logs.agentHistory },
  ];

  for (const move of fileMoves) {
    moveLegacyFile(move.from, move.to, paths);
  }

  const dirMoves: Array<{ from: string; to: string }> = [
    { from: join(paths.home, 'autostart'), to: paths.runtime.autostartDir },
    { from: join(paths.home, 'agents'), to: paths.runtime.agentsDir },
    { from: join(paths.home, 'plugins'), to: paths.runtime.pluginsDir },
    { from: join(paths.home, 'capabilities'), to: paths.runtime.capabilitiesDir },
    { from: join(paths.home, 'gateways'), to: paths.runtime.gatewaysDir },
    { from: join(paths.home, 'clock'), to: paths.runtime.clockDir },
    { from: join(paths.home, 'events'), to: paths.runtime.eventsDir },
    { from: join(paths.home, 'workflows'), to: paths.runtime.workflowsDir },
    { from: join(paths.home, 'errorsamples'), to: paths.logs.errorsamplesDir },
    { from: join(paths.home, 'prompts'), to: paths.config.promptsDir },
  ];

  for (const move of dirMoves) {
    moveLegacyDir(move.from, move.to, paths);
  }

  const legacyDirsToRemove = [
    join(paths.home, 'session'),
    join(paths.home, 'session-state'),
    join(paths.home, 'session-states'),
    join(paths.home, 'session_state'),
    join(paths.home, 'session_states'),
  ];

  for (const legacyDir of legacyDirsToRemove) {
    removeLegacyDir(legacyDir);
  }
}
