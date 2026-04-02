import { promises as fs } from 'fs';
import path from 'path';
import { FINGER_PATHS } from './finger-paths.js';

export interface WriteProjectDreamMemoryInput {
  projectSlug: string;
  taskId: string;
  projectId: string;
  status: string;
  result: 'success' | 'failure';
  summary: string;
  deliveryArtifacts?: string;
  evidence?: string[] | string;
  generatedAt?: Date;
  memoryProjectsRoot?: string;
}

export interface WriteProjectDreamMemoryResult {
  projectRoot: string;
  memoryIndexPath: string;
  dreamStatePath: string;
  assetPath: string;
}

interface DreamStateFile {
  lastUpdatedAt: string;
  byRunId: Record<string, {
    status: string;
    result: 'success' | 'failure';
    assetPath: string;
    updatedAt: string;
  }>;
}

function normalizeSlug(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function stableHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeEvidence(evidence: string[] | string | undefined): string[] {
  if (Array.isArray(evidence)) return evidence.map((item) => item.trim()).filter((item) => item.length > 0);
  if (typeof evidence === 'string') {
    return evidence.split('\n').map((item) => item.trim()).filter((item) => item.length > 0);
  }
  return [];
}

async function readUtf8IfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return '';
    throw error;
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, filePath);
}

function buildAssetMarkdown(input: WriteProjectDreamMemoryInput & { generatedAt: Date; assetRelPath: string }): string {
  const evidenceList = normalizeEvidence(input.evidence);
  return [
    '# Project Dream Asset',
    '',
    `- generated_at: ${input.generatedAt.toISOString()}`,
    `- project_id: ${input.projectId}`,
    `- project_slug: ${input.projectSlug}`,
    `- task_id: ${input.taskId}`,
    `- status: ${input.status}`,
    `- result: ${input.result}`,
    `- asset_path: ${input.assetRelPath}`,
    '',
    '## Summary',
    input.summary || '(empty)',
    '',
    '## Delivery Artifacts',
    input.deliveryArtifacts?.trim().length ? input.deliveryArtifacts.trim() : '(none)',
    '',
    '## Evidence',
    evidenceList.length > 0 ? evidenceList.map((item) => `- ${item}`).join('\n') : '- (none)',
    '',
  ].join('\n');
}

function upsertIndexContent(current: string, params: {
  taskId: string;
  result: 'success' | 'failure';
  status: string;
  generatedAt: Date;
  assetRelPath: string;
  summary: string;
}): string {
  const markerStart = '## Nightly Dream Assets';
  const markerEnd = '## Rules Snapshot';
  const line = `- ${params.generatedAt.toISOString()} | taskId=${params.taskId} | status=${params.status} | result=${params.result} | file=${params.assetRelPath} | summary=${params.summary.replace(/\s+/g, ' ').slice(0, 120)}`;
  const rows = current.split('\n');
  const startIdx = rows.findIndex((item) => item.trim() === markerStart);
  if (startIdx < 0) {
    const base = [
      '# Project Memory Index',
      '',
      markerStart,
      line,
      '',
      markerEnd,
      '- (pending refresh)',
      '',
    ];
    return `${base.join('\n')}\n`;
  }

  const endIdx = rows.findIndex((item, idx) => idx > startIdx && item.trim() === markerEnd);
  const sectionEnd = endIdx >= 0 ? endIdx : rows.length;
  const section = rows.slice(startIdx + 1, sectionEnd)
    .filter((item) => item.trim().startsWith('-'))
    .filter((item) => !item.includes(`taskId=${params.taskId} |`));
  section.unshift(line);
  const nextRows = [
    ...rows.slice(0, startIdx + 1),
    ...section,
    '',
    ...rows.slice(sectionEnd),
  ];
  return `${nextRows.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export async function writeProjectDreamMemory(input: WriteProjectDreamMemoryInput): Promise<WriteProjectDreamMemoryResult> {
  const projectSlug = normalizeSlug(input.projectSlug);
  const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
  if (!projectSlug || !taskId) {
    throw new Error('projectSlug and taskId are required for project dream memory write');
  }
  const generatedAt = input.generatedAt instanceof Date ? input.generatedAt : new Date();
  const projectsRoot = typeof input.memoryProjectsRoot === 'string' && input.memoryProjectsRoot.trim().length > 0
    ? input.memoryProjectsRoot.trim()
    : path.join(FINGER_PATHS.home, 'memory', 'projects');
  const projectRoot = path.join(projectsRoot, projectSlug);
  const memoriesDir = path.join(projectRoot, 'memories');
  const assetFileName = `${localDateKey(generatedAt)}-${stableHash(taskId).slice(0, 8)}.md`;
  const assetPath = path.join(memoriesDir, assetFileName);
  const assetRelPath = path.join('memories', assetFileName);
  const memoryIndexPath = path.join(projectRoot, 'MEMORY.md');
  const dreamStatePath = path.join(projectRoot, '.dream.state.json');

  await fs.mkdir(memoriesDir, { recursive: true });
  const assetContent = buildAssetMarkdown({
    ...input,
    projectSlug,
    generatedAt,
    assetRelPath,
  });
  await writeFileAtomic(assetPath, assetContent);

  const currentIndex = await readUtf8IfExists(memoryIndexPath);
  const nextIndex = upsertIndexContent(currentIndex, {
    taskId,
    result: input.result,
    status: input.status,
    generatedAt,
    assetRelPath,
    summary: input.summary || '',
  });
  await writeFileAtomic(memoryIndexPath, nextIndex);

  const currentStateRaw = await readUtf8IfExists(dreamStatePath);
  const currentState = (() => {
    if (!currentStateRaw.trim()) return { lastUpdatedAt: generatedAt.toISOString(), byRunId: {} } satisfies DreamStateFile;
    try {
      const parsed = JSON.parse(currentStateRaw) as Partial<DreamStateFile>;
      return {
        lastUpdatedAt: typeof parsed.lastUpdatedAt === 'string' ? parsed.lastUpdatedAt : generatedAt.toISOString(),
        byRunId: parsed.byRunId && typeof parsed.byRunId === 'object' ? parsed.byRunId : {},
      } satisfies DreamStateFile;
    } catch {
      return { lastUpdatedAt: generatedAt.toISOString(), byRunId: {} } satisfies DreamStateFile;
    }
  })();
  currentState.lastUpdatedAt = generatedAt.toISOString();
  currentState.byRunId[taskId] = {
    status: input.status,
    result: input.result,
    assetPath: assetRelPath,
    updatedAt: generatedAt.toISOString(),
  };
  await writeFileAtomic(dreamStatePath, `${JSON.stringify(currentState, null, 2)}\n`);

  return {
    projectRoot,
    memoryIndexPath,
    dreamStatePath,
    assetPath,
  };
}
