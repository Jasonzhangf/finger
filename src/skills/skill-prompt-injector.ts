/**
 * Skill Prompt Injector
 *
 * 在Agent启动时自动加载Skills并注入到系统提示词中
 */

import { SkillsManager } from './skill-manager.js';
import { logger } from '../core/logger.js';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';

const clog = createConsoleLikeLogger('SkillPromptInjector');

const log = logger.module('SkillPromptInjector');

const skillsManager = new SkillsManager();

/**
 * 格式化Skills列表为提示词文本
 */
export async function formatSkillsAsPrompt(): Promise<string> {
  try {
    const skills = await skillsManager.listSkills();

    if (skills.length === 0) {
      return '';
    }

    let prompt = '\n\n## Available Skills\n\n';
    prompt += 'You have access to the following predefined skills:\n\n';

    for (const skill of skills) {
      prompt += `### ${skill.name}\n`;
      prompt += `**Description**: ${skill.description}\n\n`;
    }

    return prompt;
  } catch (error) {
    clog.error('[SkillPromptInjector] Failed to load skills:', error);
    return '';
  }
}

/**
 * 将Skills注入到系统提示词中
 * @param systemPrompt 原始系统提示词
 * @returns 包含Skills信息的系统提示词
 */
export async function injectSkillsIntoPrompt(systemPrompt: string): Promise<string> {
  const skillsSection = await formatSkillsAsPrompt();

  if (!skillsSection) {
    return systemPrompt;
  }

  // 将Skills部分追加到系统提示词的末尾
  return systemPrompt + skillsSection;
}

/**
 * Synchronously format Skills list as prompt text (using cached skills)
 */
export function formatSkillsAsPromptSync(): string {
  try {
    const skills = skillsManager.listSkillsSync();

    if (skills.length === 0) {
      return '';
    }

    let prompt = '\n\n## Available Skills\n\n';
    prompt += 'You have access to the following predefined skills:\n\n';

    for (const skill of skills) {
      prompt += `### ${skill.name}\n`;
      prompt += `**Description**: ${skill.description}\n\n`;
    }

    return prompt;
  } catch (error) {
    clog.error('[SkillPromptInjector] Failed to load skills sync:', error);
    return '';
  }
}

/**
 * Synchronously inject Skills into system prompt (using cached skills)
 * @param systemPrompt 原始系统提示词
 * @returns 包含Skills信息的系统提示词
 */
export function injectSkillsIntoPromptSync(systemPrompt: string): string {
  const skillsSection = formatSkillsAsPromptSync();

  if (!skillsSection) {
    return systemPrompt;
  }

  // 将Skills部分追加到系统提示词的末尾
  return systemPrompt + skillsSection;
}
