/**
 * Skills Manager - 管理 Finger 项目的 Skills
 *
 * 提供列出、读取和执行 Skills 的功能
 */

import { promises as fs } from 'fs';
import { existsSync, readFileSync, readdirSync, watch, type FSWatcher } from 'fs';
import path from 'path';
import { logger } from '../core/logger.js';
import { FINGER_PATHS } from '../core/finger-paths.js';

const log = logger.module('SkillsManager');

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  exists: boolean;
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
        fs.mkdir(this.skillsDir, { recursive: true }).catch(err => {
          log.warn('[SkillsManager] Failed to create skills directory:', err);
        });
      }

      this.watcher = watch(this.skillsDir, { recursive: true }, (eventType, filename) => {
        if (filename && filename.endsWith('SKILL.md')) {
          log.info(`[SkillsManager] Skills changed: ${filename}, reloading cache`);
          this.listSkills().catch(err => {
            log.warn('[SkillsManager] Failed to reload cache after change:', err);
          });
        }
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
        } catch {
          // SKILL.md 不存在或读取失败
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
    if (this.skillsCache.size === 0) {
      this.loadSkillsFromDiskSync();
    }
    return Array.from(this.skillsCache.values());
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
  }

  private loadSkillsFromDiskSync(): void {
    try {
      const entries = readdirSync(this.skillsDir, { withFileTypes: true });
      const skills: SkillMetadata[] = [];

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
        } catch {
          // SKILL.md 不存在或读取失败
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
    } catch (error) {
      log.error('[SkillsManager] Failed to load skills sync:', error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export default SkillsManager;
