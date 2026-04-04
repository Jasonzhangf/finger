/**
 * Skills Manager - 管理 Finger 项目的 Skills
 *
 * 提供列出、读取和执行 Skills 的功能
 */

import { promises as fs } from 'fs';
import { existsSync, mkdirSync, readFileSync, readdirSync, watch, type FSWatcher } from 'fs';
import path from 'path';
import { logger } from '../core/logger.js';
import { FINGER_PATHS } from '../core/finger-paths.js';

const log = logger.module('SkillsManager');

function describeWatcherError(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { message: error.message, ...(code ? { code } : {}) };
  }
  return { message: String(error) };
}

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  exists: boolean;
}

export interface SkillsManagerStatus {
  skillsDir: string;
  watcherActive: boolean;
  cacheSize: number;
  cachedSkillNames: string[];
  lastReloadAt?: string;
  lastReloadReason?: string;
}

export interface SkillsScopeOptions {
  cwd?: string;
  projectPath?: string;
  includeProjectSkills?: boolean;
}

function parseSkillMetadataFromContent(content: string, fallbackName: string): SkillMetadata {
  let name = fallbackName;
  let description = '';
  let exists = false;

  const frontMatterMatch = content.match(/^---\s*[\r\n]+([\s\S]*?)\r?\n---/);
  if (!frontMatterMatch) {
    return { name, description, path: '', exists };
  }

  const frontMatter = frontMatterMatch[1];
  const lines = frontMatter.split(/\r?\n/);
  let nameFound = false;
  let descriptionFound = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('name:')) {
      name = trimmed.replace(/^name:\s*/, '').trim();
      nameFound = name.length > 0;
    }
    if (trimmed.startsWith('description:')) {
      description = trimmed.replace(/^description:\s*/, '').trim();
      descriptionFound = description.length > 0;
    }
  }

  exists = nameFound && descriptionFound;
  return { name, description, path: '', exists };
}

/**
 * Skills Manager
 *
 * 管理项目的 Skills，提供查询和执行接口
 */
export class SkillsManager {
  private skillsDir: string;
  private skillsCache: Map<string, SkillMetadata>;
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private lastReloadAt: string | null = null;
  private lastReloadReason: string | null = null;

  constructor() {
    this.skillsDir = path.join(FINGER_PATHS.home, 'skills');
    this.skillsCache = new Map();
    this.startWatching();
    // Pre-load cache
    this.listSkills().catch(err => {
      log.warn('[SkillsManager] Failed to pre-load cache:', err);
    });
  }

  private startWatching(): void {
    try {
      if (!existsSync(this.skillsDir)) {
        log.info(`[SkillsManager] Skills directory does not exist, creating: ${this.skillsDir}`);
        mkdirSync(this.skillsDir, { recursive: true });
      }

      this.watcher = watch(this.skillsDir, { recursive: true }, (eventType, filename) => {
        const normalized = typeof filename === 'string' ? filename.replace(/\\/g, '/') : '';
        const shouldReload = normalized.length === 0
          || normalized.endsWith('SKILL.md')
          || normalized.endsWith('.md')
          || !normalized.includes('.');
        if (!shouldReload) return;

        this.scheduleReload(`${eventType}:${normalized || '(unknown)'}`);
      });
      this.watcher.on('error', (error) => {
        const detail = describeWatcherError(error);
        log.warn('[SkillsManager] Skills watcher error, disabling watcher', detail);
        this.stopWatching();
      });

      log.info(`[SkillsManager] Watching skills directory: ${this.skillsDir}`);
    } catch (error) {
      log.error('[SkillsManager] Failed to start watching:', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * 列出所有可用的 Skills
   */
  async listSkills(): Promise<SkillMetadata[]> {
    try {
      const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
      const skills: SkillMetadata[] = [];
      const skippedSkills: Array<{ path: string; error: string }> = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = path.join(this.skillsDir, entry.name);
        const skilMdPath = path.join(skillPath, 'SKILL.md');

        try {
          const content = await fs.readFile(skilMdPath, 'utf-8');
          const parsed = parseSkillMetadataFromContent(content, entry.name);
          skills.push({
            name: parsed.name,
            description: parsed.description,
            path: skillPath,
            exists: parsed.exists,
          });
          continue;
        } catch (err) {
          skippedSkills.push({
            path: skillPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        skills.push({
          name: entry.name,
          description: '',
          path: skillPath,
          exists: false,
        });
      }

      this.skillsCache.clear();
      for (const skill of skills) {
        this.skillsCache.set(skill.name, skill);
      }
      if (skippedSkills.length > 0) {
        log.warn('[SkillsManager] SKILL.md unreadable, skipped without affecting runtime', {
          count: skippedSkills.length,
          samples: skippedSkills.slice(0, 5).map((item) => `${item.path}: ${item.error}`),
        });
      }
      this.markReload('listSkills');

      return skills;
    } catch (error) {
      log.error('[SkillsManager] Failed to list skills:', error instanceof Error ? error : new Error(String(error)));
      return [];
    }
  }

  /**
   * 获取指定 Skill 的元数据
   */
  async getSkill(name: string): Promise<SkillMetadata | null> {
    if (this.skillsCache.size === 0) {
      await this.listSkills();
    }

    return this.skillsCache.get(name) || null;
  }

  /**
   * 读取 Skill 的内容
   */
  async readSkill(name: string): Promise<string | null> {
    const skill = await this.getSkill(name);
    if (!skill || !skill.exists) {
      return null;
    }

    const skilMdPath = path.join(skill.path, 'SKILL.md');
    try {
      return await fs.readFile(skilMdPath, 'utf-8');
    } catch (error) {
      log.error(`[SkillsManager] Failed to read skill ${name}:`, error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  /**
   * 检查 Skill 是否可用
   */
  async isSkillAvailable(name: string): Promise<boolean> {
    const skill = await this.getSkill(name);
    return skill !== null && skill.exists;
  }

  /**
   * Synchronously get skills from cache
   * Returns empty array if cache is not initialized
   */
  listSkillsSync(): SkillMetadata[] {
    // Always refresh from disk so newly installed skills are visible
    // on the very next turn even if fs.watch missed the install event.
    this.loadSkillsFromDiskSync();
    return Array.from(this.skillsCache.values());
  }

  listSkillsScopedSync(options?: SkillsScopeOptions): SkillMetadata[] {
    const globalSkills = this.listSkillsSync();
    if (!options?.includeProjectSkills) {
      return globalSkills;
    }

    const scopedDirs = resolveScopedSkillDirs(options, this.skillsDir);
    if (scopedDirs.length === 0) {
      return globalSkills;
    }

    const scopedSkills = this.loadScopedSkillsFromDirsSync(scopedDirs);
    if (scopedSkills.length === 0) {
      return globalSkills;
    }

    // Scoped (project-local) skills have precedence over global skills
    const mergedByName = new Map<string, SkillMetadata>();
    for (const skill of scopedSkills) {
      mergedByName.set(skill.name, skill);
    }
    for (const skill of globalSkills) {
      if (!mergedByName.has(skill.name)) {
        mergedByName.set(skill.name, skill);
      }
    }

    return Array.from(mergedByName.values());
  }

  getStatus(): SkillsManagerStatus {
    return {
      skillsDir: this.skillsDir,
      watcherActive: this.watcher !== null,
      cacheSize: this.skillsCache.size,
      cachedSkillNames: Array.from(this.skillsCache.keys()).sort(),
      ...(this.lastReloadAt ? { lastReloadAt: this.lastReloadAt } : {}),
      ...(this.lastReloadReason ? { lastReloadReason: this.lastReloadReason } : {}),
    };
  }

  /**
   * Stop watching skills directory
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      log.info('[SkillsManager] Stopped watching skills directory');
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  private scheduleReload(reason: string): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      log.info(`[SkillsManager] Skills changed (${reason}), reloading cache`);
      this.lastReloadReason = reason;
      this.listSkills().catch(err => {
        log.warn('[SkillsManager] Failed to reload cache after change:', err);
      });
    }, 100);
  }

  private markReload(reason: string): void {
    this.lastReloadAt = new Date().toISOString();
    this.lastReloadReason = reason;
  }

  private loadSkillsFromDiskSync(): void {
    try {
      const entries = readdirSync(this.skillsDir, { withFileTypes: true });
      const skills: SkillMetadata[] = [];
      const skippedSkills: Array<{ path: string; error: string }> = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = path.join(this.skillsDir, entry.name);
        const skilMdPath = path.join(skillPath, 'SKILL.md');

        try {
          const content = readFileSync(skilMdPath, 'utf-8');
          const parsed = parseSkillMetadataFromContent(content, entry.name);
          skills.push({
            name: parsed.name,
            description: parsed.description,
            path: skillPath,
            exists: parsed.exists,
          });
          continue;
        } catch (err) {
          skippedSkills.push({
            path: skillPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        skills.push({
          name: entry.name,
          description: '',
          path: skillPath,
          exists: false,
        });
      }

      this.skillsCache.clear();
      for (const skill of skills) {
        this.skillsCache.set(skill.name, skill);
      }
      if (skippedSkills.length > 0) {
        log.warn('[SkillsManager] SKILL.md unreadable, skipped without affecting runtime', {
          count: skippedSkills.length,
          samples: skippedSkills.slice(0, 5).map((item) => `${item.path}: ${item.error}`),
        });
      }
      this.markReload('loadSkillsFromDiskSync');
    } catch (error) {
      log.error('[SkillsManager] Failed to load skills sync:', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private loadScopedSkillsFromDirsSync(dirs: string[]): SkillMetadata[] {
    const skills: SkillMetadata[] = [];
    const seenSkillNames = new Set<string>();
    const skippedScopedSkills: Array<{ path: string; error: string }> = [];

    for (const dir of dirs) {
      try {
        if (!existsSync(dir)) continue;
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillPath = path.join(dir, entry.name);
          const skillMdPath = path.join(skillPath, 'SKILL.md');
          if (!existsSync(skillMdPath)) continue;

          try {
            const content = readFileSync(skillMdPath, 'utf-8');
            const parsed = parseSkillMetadataFromContent(content, entry.name);
            const normalizedName = parsed.name.trim().length > 0 ? parsed.name.trim() : entry.name;
            if (seenSkillNames.has(normalizedName)) continue;
            seenSkillNames.add(normalizedName);
            skills.push({
              name: normalizedName,
              description: parsed.description,
              path: skillPath,
              exists: true,
            });
          } catch (err) {
            skippedScopedSkills.push({
              path: skillPath,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        log.warn('[SkillsManager] Ignore invalid scoped skill directory', {
          dir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (skippedScopedSkills.length > 0) {
      log.warn('[SkillsManager] Scoped SKILL.md unreadable, skipped without affecting runtime', {
        count: skippedScopedSkills.length,
        samples: skippedScopedSkills.slice(0, 5).map((item) => `${item.path}: ${item.error}`),
      });
    }

    return skills;
  }
}

function normalizeDir(rawPath: string | undefined): string | undefined {
  if (typeof rawPath !== 'string') return undefined;
  const trimmed = rawPath.trim();
  if (!trimmed) return undefined;
  return path.resolve(trimmed);
}

function isSameOrSubPath(candidate: string, root: string): boolean {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = path.resolve(root);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function resolveScopedSkillDirs(options: SkillsScopeOptions, globalSkillsDir: string): string[] {
  const resolvedGlobal = path.resolve(globalSkillsDir);
  const resolvedProject = normalizeDir(options.projectPath);
  const resolvedCwd = normalizeDir(options.cwd) ?? resolvedProject;
  if (!resolvedCwd && !resolvedProject) return [];

  const dirs: string[] = [];
  const pushDir = (dir: string) => {
    const resolved = path.resolve(dir);
    if (resolved === resolvedGlobal) return;
    if (!dirs.includes(resolved)) dirs.push(resolved);
  };

  const upperBound = resolvedProject && resolvedCwd && isSameOrSubPath(resolvedCwd, resolvedProject)
    ? resolvedProject
    : undefined;

  let cursor = resolvedCwd;
  while (cursor) {
    pushDir(path.join(cursor, '.codex', 'skills'));
    pushDir(path.join(cursor, 'skills'));
    if (upperBound && cursor === upperBound) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  if (resolvedProject && (!resolvedCwd || !isSameOrSubPath(resolvedCwd, resolvedProject))) {
    pushDir(path.join(resolvedProject, '.codex', 'skills'));
    pushDir(path.join(resolvedProject, 'skills'));
  }

  return dirs;
}

let globalSkillsManager: SkillsManager | null = null;

export function getGlobalSkillsManager(): SkillsManager {
  if (!globalSkillsManager) {
    globalSkillsManager = new SkillsManager();
  }
  return globalSkillsManager;
}

export default SkillsManager;
