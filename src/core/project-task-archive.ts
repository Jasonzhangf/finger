import { appendFileSync } from 'fs';
import { logger } from './logger.js';
import type { ProjectTaskState } from '../common/project-task-state.js';

const log = logger.module('ProjectTaskArchive');
const lastArchiveKeyByPath = new Map<string, string>();

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

export function appendClosedProjectTaskArchive(
  projectPath: string,
  state: ProjectTaskState,
): void {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) return;
  if (!state || state.status !== 'closed' || state.active !== false) return;
  const normalizedProjectPath = projectPath.replace(/\/+$/, '');
  const archivePath = `${normalizedProjectPath}/TASK_ARCHIVE.md`;
  const key = [
    state.taskId ?? '',
    state.taskName ?? '',
    state.dispatchId ?? '',
    state.updatedAt,
    state.status,
    state.note ?? '',
  ].join('|');
  if (lastArchiveKeyByPath.get(archivePath) === key) return;

  const lines = [
    '',
    `## ${new Date().toISOString()} · closed`,
    `- taskId: ${state.taskId ?? 'N/A'}`,
    `- taskName: ${state.taskName ?? 'N/A'}`,
    `- dispatchId: ${state.dispatchId ?? 'N/A'}`,
    `- source: ${state.sourceAgentId}`,
    `- target: ${state.targetAgentId}`,
    `- note: ${normalizeText(state.note) || 'N/A'}`,
    `- summary: ${normalizeText(state.summary) || 'N/A'}`,
    `- updatedAt: ${state.updatedAt}`,
  ];
  try {
    appendFileSync(archivePath, lines.join('\n') + '\n', 'utf8');
    lastArchiveKeyByPath.set(archivePath, key);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return;
    log.warn('[ProjectTaskArchive] Failed to append TASK_ARCHIVE.md', {
      archivePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
