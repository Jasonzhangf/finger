/**
 * System Agent Prompt Loader
 *
 * 参考OpenClaw的设计，支持从Markdown文件加载提示词
 * 优先级: ~/.finger/system/roles/*.md > docs/reference/templates/system-agent/roles/*.md
 */

import { promises as fs } from 'fs';
import path from 'path';
import { FINGER_PATHS, FINGER_PACKAGE_ROOT } from '../../core/finger-paths.js';

const DIST_TEMPLATES_PATH = path.join(FINGER_PACKAGE_ROOT, 'docs', 'reference', 'templates', 'system-agent');
const promptCache = new Map<string, Promise<string>>();

/**
 * 去除 Markdown 文件的 YAML front matter
 */
function stripFrontMatter(content: string): string {
  if (!content.startsWith('---')) {
    return content;
  }
  const endIndex = content.indexOf('\n---', 3);
  if (endIndex === -1) {
    return content;
  }
  const start = endIndex + '\n---'.length;
  let trimmed = content.slice(start);
  trimmed = trimmed.replace(/^\s+/, '');
  return trimmed;
}

/**
 * 加载提示词（优先级：用户版本 > dist 模板）
 * @param name 文件名（如 'system-prompt.md'）
 * @param role 角色路径（如 'roles'）
 * @returns 提示词内容（去除 front matter）
 */
export async function loadPrompt(name: string, role?: string): Promise<string> {
  const cacheKey = role ? `${role}/${name}` : name;

  const cached = promptCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    // 1. 尝试用户版本（优先级最高）
    const userPath = role
      ? path.join(FINGER_PATHS.home, 'system', role, name)
      : path.join(FINGER_PATHS.home, 'system', name);

    try {
      const content = await fs.readFile(userPath, 'utf-8');
      return stripFrontMatter(content);
    } catch {
      // 用户版本不存在，继续尝试 dist 模板
    }

    // 2. 从 dist 模板初始化
    const templatePath = role
      ? path.join(DIST_TEMPLATES_PATH, role, name)
      : path.join(DIST_TEMPLATES_PATH, name);

    try {
      const template = await fs.readFile(templatePath, 'utf-8');

      // 写入用户目录（初始化）
      await fs.mkdir(path.dirname(userPath), { recursive: true });
      await fs.writeFile(userPath, template, 'utf-8');

      return stripFrontMatter(template);
    } catch (error) {
      throw new Error(
        `Missing prompt: ${name} (tried user path: ${userPath} and dist template: ${templatePath})`
      );
    }
  })();

  promptCache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    promptCache.delete(cacheKey);
    throw error;
  }
}

/**
 * 清除提示词缓存（用于调试或热更新）
 */
export function clearPromptCache(): void {
  promptCache.clear();
}

/**
 * 重新加载提示词（清除缓存后重新加载）
 */
export async function reloadPrompt(name: string, role?: string): Promise<string> {
  const cacheKey = role ? `${role}/${name}` : name;
  promptCache.delete(cacheKey);
  return loadPrompt(name, role);
}
