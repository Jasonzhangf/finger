/**
 * HEARTBEAT.md Parser - YAML front matter and checklist parsing
 *
 * Supports routecodex format with Heartbeat-Stop-When and Heartbeat-Until fields
 */

import { promises as fs } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { logger } from '../../core/logger.js';

const log = logger.module('HeartbeatMdParser');

/**
 * Routecodex format front matter fields
 */
export interface HeartbeatFrontMatter {
  title?: string;
  version?: string;
  updated_at?: string;
  /** Stop heartbeat when condition is met (e.g., 'no-open-tasks') */
  'Heartbeat-Stop-When'?: 'no-open-tasks' | string;
  /** Stop heartbeat after this ISO timestamp */
  'Heartbeat-Until'?: string;
  /** Custom fields */
  [key: string]: unknown;
}

/**
 * Parsed HEARTBEAT.md content
 */
export interface ParsedHeartbeatMd {
  ok: boolean;
  frontMatter?: HeartbeatFrontMatter;
  body?: string;
  checklistItems?: ChecklistItem[];
  error?: string;
  errorType?: 'parse-error' | 'invalid-format' | 'file-not-found';
}

/**
 * Checklist item parsed from markdown body
 */
export interface ChecklistItem {
  text: string;
  checked: boolean;
  line: number;
}

/**
 * Result of should-stop-heartbeat check
 */
export interface ShouldStopResult {
  shouldStop: boolean;
  reason?: string;
  frontMatter?: HeartbeatFrontMatter;
  checklistStats?: {
    total: number;
    checked: number;
    unchecked: number;
  };
}

/**
 * Validation result for HEARTBEAT.md
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  canAutoRepair: boolean;
}

const YAML_FRONTMATTER_DELIMITER = '---';

/**
 * Parse HEARTBEAT.md file with YAML front matter
 */
export async function parseHeartbeatMd(filePath: string): Promise<ParsedHeartbeatMd> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return parseHeartbeatMdContent(content);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return {
        ok: false,
        error: `HEARTBEAT.md not found: ${filePath}`,
        errorType: 'file-not-found',
      };
    }
    return {
      ok: false,
      error: `Failed to read HEARTBEAT.md: ${err.message}`,
      errorType: 'parse-error',
    };
  }
}

/**
 * Parse HEARTBEAT.md content string
 */
export function parseHeartbeatMdContent(content: string): ParsedHeartbeatMd {
  const trimmed = content.trim();

  // Check for YAML front matter
  if (!trimmed.startsWith(YAML_FRONTMATTER_DELIMITER)) {
    return {
      ok: false,
      error: 'Missing YAML front matter (must start with ---)',
      errorType: 'invalid-format',
    };
  }

  // Find the closing delimiter
  const lines = trimmed.split('\n');
  let endDelimiterIndex = -1;
  let foundStart = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === YAML_FRONTMATTER_DELIMITER) {
      if (!foundStart) {
        foundStart = true;
      } else {
        endDelimiterIndex = i;
        break;
      }
    }
  }

  if (endDelimiterIndex === -1) {
    return {
      ok: false,
      error: 'Unclosed YAML front matter (missing closing ---)',
      errorType: 'invalid-format',
    };
  }

  // Extract YAML content
  const yamlLines = lines.slice(1, endDelimiterIndex);
  const yamlContent = yamlLines.join('\n');

  // Parse YAML
  let frontMatter: HeartbeatFrontMatter;
  try {
    const parsed = parseYaml(yamlContent);
    if (typeof parsed !== 'object' || parsed === null) {
      return {
        ok: false,
        error: 'YAML front matter must be an object',
        errorType: 'invalid-format',
      };
    }
    frontMatter = parsed as HeartbeatFrontMatter;
  } catch (error) {
    const err = error as Error;
    return {
      ok: false,
      error: `YAML parse error: ${err.message}`,
      errorType: 'parse-error',
    };
  }

  // Extract body
  const bodyLines = lines.slice(endDelimiterIndex + 1);
  const body = bodyLines.join('\n').trim();

  // Parse checklist items
  const checklistItems = parseChecklistItems(body);

  return {
    ok: true,
    frontMatter,
    body,
    checklistItems,
  };
}

/**
 * Parse checklist items from markdown body
 */
export function parseChecklistItems(body: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match markdown checklist: - [ ] or - [x] or * [ ] or * [x]
    const match = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (match) {
      const checked = match[1].toLowerCase() === 'x';
      const text = match[2].trim();
      items.push({
        text,
        checked,
        line: i + 1,
      });
    }
  }

  return items;
}

/**
 * Check if heartbeat should stop based on front matter and checklist
 */
export async function shouldStopHeartbeat(filePath: string): Promise<ShouldStopResult> {
  const parsed = await parseHeartbeatMd(filePath);

  if (!parsed.ok) {
    return {
      shouldStop: false,
      reason: `Failed to parse HEARTBEAT.md: ${parsed.error}`,
    };
  }

  const { frontMatter, checklistItems } = parsed;

  if (!frontMatter) {
    return { shouldStop: false };
  }

  // Check Heartbeat-Until
  if (typeof frontMatter['Heartbeat-Until'] === 'string' && frontMatter['Heartbeat-Until'].trim() !== '') {
    try {
      const untilDate = new Date(frontMatter['Heartbeat-Until']);
      if (isNaN(untilDate.getTime())) {
        log.warn(`Invalid Heartbeat-Until date: ${frontMatter['Heartbeat-Until']}`);
      } else if (new Date() >= untilDate) {
        return {
          shouldStop: true,
          reason: `Heartbeat-Until date reached: ${frontMatter['Heartbeat-Until']}`,
          frontMatter,
          checklistStats: getChecklistStats(checklistItems || []),
        };
      }
    } catch (error) {
      log.warn(`Failed to parse Heartbeat-Until: ${frontMatter['Heartbeat-Until']}`);
    }
  }

  // Check Heartbeat-Stop-When
  if (typeof frontMatter['Heartbeat-Stop-When'] === 'string' && frontMatter['Heartbeat-Stop-When'].trim() !== '') {
    if (frontMatter['Heartbeat-Stop-When'] !== 'no-open-tasks') {
      return {
        shouldStop: false,
        reason: `Unknown Heartbeat-Stop-When value: ${frontMatter['Heartbeat-Stop-When']}`,
        frontMatter,
        checklistStats: getChecklistStats(checklistItems || []),
      };
    }
    const stats = getChecklistStats(checklistItems || []);
    if (stats.total > 0 && stats.unchecked === 0) {
      return {
        shouldStop: true,
        reason: 'All tasks completed (Heartbeat-Stop-When: no-open-tasks)',
        frontMatter,
        checklistStats: stats,
      };
    }
  }

  return {
    shouldStop: false,
    frontMatter,
    checklistStats: getChecklistStats(checklistItems || []),
  };
}

/**
 * Get checklist statistics
 */
function getChecklistStats(items: ChecklistItem[]): { total: number; checked: number; unchecked: number } {
  return {
    total: items.length,
    checked: items.filter(i => i.checked).length,
    unchecked: items.filter(i => !i.checked).length,
  };
}

/**
 * Validate HEARTBEAT.md format
 */
export async function validateHeartbeatMd(filePath: string): Promise<ValidationResult> {
  const parsed = await parseHeartbeatMd(filePath);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!parsed.ok) {
    // File not found is a special case - can auto-repair by creating default
    if (parsed.errorType === 'file-not-found') {
      return {
        valid: false,
        errors: [parsed.error!],
        warnings: [],
        canAutoRepair: true,
      };
    }

    return {
      valid: false,
      errors: [parsed.error!],
      warnings: [],
      canAutoRepair: parsed.errorType === 'invalid-format',
    };
  }

  const { frontMatter, checklistItems } = parsed;

  // Validate front matter
  if (!frontMatter?.title) {
    warnings.push('Missing title in front matter');
  }

  if (!frontMatter?.version) {
    warnings.push('Missing version in front matter');
  }

  if (!frontMatter?.updated_at) {
    warnings.push('Missing updated_at in front matter');
  }

  // Validate Heartbeat-Until if present
  if (typeof frontMatter?.['Heartbeat-Until'] === 'string' && frontMatter['Heartbeat-Until'].trim() !== '') {
    const date = new Date(frontMatter['Heartbeat-Until']);
    if (isNaN(date.getTime())) {
      errors.push(`Invalid Heartbeat-Until date: ${frontMatter['Heartbeat-Until']}`);
    }
  }

  // Validate Heartbeat-Stop-When if present
  if (typeof frontMatter?.['Heartbeat-Stop-When'] === 'string' && frontMatter['Heartbeat-Stop-When'].trim() !== '') {
    const validValues = ['no-open-tasks'];
    if (!validValues.includes(frontMatter['Heartbeat-Stop-When'])) {
      warnings.push(`Unknown Heartbeat-Stop-When value: ${frontMatter['Heartbeat-Stop-When']}`);
    }
  }

  // Warn if no checklist items found
  if (!checklistItems || checklistItems.length === 0) {
    warnings.push('No checklist items found in HEARTBEAT.md');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    canAutoRepair: errors.length > 0,
  };
}

/**
 * Generate default HEARTBEAT.md content in routecodex format
 */
export function generateDefaultHeartbeatMd(title: string = 'Heartbeat Tasks'): string {
  const now = new Date().toISOString();
  return `---
title: "${title}"
version: "1.0.0"
updated_at: "${now}"
---

# HEARTBEAT.md - Periodic Task List

## Tasks

- [ ] Add your periodic tasks here
`;
}

/**
 * Resolve HEARTBEAT.md path for a project
 * For system agent (projectId === 'finger-system-agent'), uses ~/.finger/system/HEARTBEAT.md
 * For project agents, uses <projectPath>/HEARTBEAT.md
 */
export function resolveHeartbeatMdPath(projectId: string | undefined, projectPath: string | undefined, fingerHome: string): string | null {
  if (!projectId) {
    return path.join(fingerHome, 'system', 'HEARTBEAT.md');
  }

  if (projectId === 'finger-system-agent' || !projectPath) {
    return path.join(fingerHome, 'system', 'HEARTBEAT.md');
  }

  return path.join(projectPath, 'HEARTBEAT.md');
}

/**
 * Truncate old heartbeat records, keeping only the most recent N sections
 * Sections are identified by '### ' prefix (markdown h3)
 */
export async function truncateHeartbeatRecords(filePath: string, maxRecords: number = 10): Promise<{ truncated: boolean; before: number; after: number }> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parts = content.split('### ');

    if (parts.length <= maxRecords + 1) {
      // No need to truncate
      return { truncated: false, before: parts.length - 1, after: parts.length - 1 };
    }

    // Keep frontmatter + header (parts[0]) and last N sections
    const header = parts[0];
    const sections = parts.slice(1);
    const truncated = header + '### ' + sections.slice(-maxRecords).join('### ');

    await fs.writeFile(filePath, truncated, 'utf-8');
    log.info(`[HeartbeatMdParser] Truncated ${filePath}: ${sections.length} -> ${maxRecords} sections`);

    return { truncated: true, before: sections.length, after: maxRecords };
  } catch (error) {
    log.error('[HeartbeatMdParser] Failed to truncate records', error instanceof Error ? error : undefined);
    return { truncated: false, before: 0, after: 0 };
  }
 }

/**
 * Check if HEARTBEAT.md needs truncation (has more than maxRecords sections)
 */
export async function checkHeartbeatNeedsTruncation(filePath: string, maxRecords: number = 20): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const sectionCount = (content.match(/^### /gm) || []).length;
    return sectionCount > maxRecords;
  } catch {
    return false;
  }
 }
