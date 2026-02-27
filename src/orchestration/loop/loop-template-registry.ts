export type LoopTemplateType =
  | 'epic_planning'
  | 'parallel_execution'
  | 'review_retry'
  | 'search_evidence';

export interface LoopTemplateTaskInput {
  id?: string;
  description: string;
  blockedBy?: string[];
}

export interface LoopTemplateSuggestionInput {
  task?: string;
  tasks?: LoopTemplateTaskInput[];
  contextConsumption?: 'low' | 'medium' | 'high';
  requiresEvidence?: boolean;
}

export interface LoopTemplateTaskSuggestion {
  id: string;
  description: string;
  blocking: 'blocking' | 'non_blocking';
  contextIsolationRequired: boolean;
  template: LoopTemplateType;
  reasons: string[];
}

export interface LoopTemplateSuggestionResult {
  primaryTemplate: LoopTemplateType;
  templatesUsed: LoopTemplateType[];
  taskSuggestions: LoopTemplateTaskSuggestion[];
  blockingTaskIds: string[];
  nonBlockingTaskIds: string[];
  summary: string;
}

function normalizeTasks(input: LoopTemplateSuggestionInput): LoopTemplateTaskInput[] {
  if (Array.isArray(input.tasks) && input.tasks.length > 0) {
    return input.tasks
      .filter((item) => item && typeof item.description === 'string' && item.description.trim().length > 0)
      .map((item, index) => ({
        id: typeof item.id === 'string' && item.id.trim().length > 0 ? item.id.trim() : `task-${index + 1}`,
        description: item.description.trim(),
        blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.filter((d) => typeof d === 'string' && d.trim().length > 0) : [],
      }));
  }
  const single = typeof input.task === 'string' ? input.task.trim() : '';
  if (!single) return [];
  return [{ id: 'task-1', description: single, blockedBy: [] }];
}

function hasAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function inferTemplate(task: LoopTemplateTaskInput, contextConsumption?: 'low' | 'medium' | 'high', globalRequiresEvidence?: boolean): {
  template: LoopTemplateType;
  blocking: 'blocking' | 'non_blocking';
  contextIsolationRequired: boolean;
  reasons: string[];
} {
  const text = task.description.toLowerCase();
  const reasons: string[] = [];
  const hasBlockers = Array.isArray(task.blockedBy) && task.blockedBy.length > 0;
  const evidenceRequired = globalRequiresEvidence === true
    || hasAnyKeyword(text, ['search', 'research', 'evidence', 'source', 'citation', '检索', '调研', '证据', '来源']);
  const reviewRequired = hasAnyKeyword(text, ['review', 'verify', 'validation', 'qa', 'test', '审核', '评审', '验证', '测试']);
  const parallelFriendly = hasAnyKeyword(text, ['parallel', 'batch', '并行', '批量', 'fanout']) || !hasBlockers;
  const contextIsolationRequired = contextConsumption === 'high'
    || hasAnyKeyword(text, ['multi-file', 'cross-module', 'refactor', 'architecture', '大规模', '跨模块', '重构', '架构']);

  const blocking: 'blocking' | 'non_blocking' = hasBlockers ? 'blocking' : 'non_blocking';
  if (hasBlockers) reasons.push('task has blockers');
  if (evidenceRequired) reasons.push('task requires evidence collection');
  if (reviewRequired) reasons.push('task requires review/verification gate');
  if (contextIsolationRequired) reasons.push('task has high context cost');

  if (evidenceRequired) {
    return { template: 'search_evidence', blocking, contextIsolationRequired, reasons };
  }
  if (reviewRequired) {
    return { template: 'review_retry', blocking, contextIsolationRequired, reasons };
  }
  if (parallelFriendly && blocking === 'non_blocking') {
    return { template: 'parallel_execution', blocking, contextIsolationRequired, reasons };
  }
  return { template: 'epic_planning', blocking, contextIsolationRequired, reasons };
}

function pickPrimaryTemplate(taskSuggestions: LoopTemplateTaskSuggestion[]): LoopTemplateType {
  if (taskSuggestions.length === 0) return 'epic_planning';
  if (taskSuggestions.length === 1) return taskSuggestions[0].template;

  const counts = new Map<LoopTemplateType, number>();
  for (const item of taskSuggestions) {
    counts.set(item.template, (counts.get(item.template) ?? 0) + 1);
  }
  const priority: LoopTemplateType[] = ['epic_planning', 'parallel_execution', 'review_retry', 'search_evidence'];
  let best: LoopTemplateType = 'epic_planning';
  let bestCount = -1;
  for (const key of priority) {
    const count = counts.get(key) ?? 0;
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

export function recommendLoopTemplates(input: LoopTemplateSuggestionInput): LoopTemplateSuggestionResult {
  const tasks = normalizeTasks(input);
  const taskSuggestions: LoopTemplateTaskSuggestion[] = tasks.map((task, index) => {
    const inferred = inferTemplate(task, input.contextConsumption, input.requiresEvidence);
    return {
      id: task.id ?? `task-${index + 1}`,
      description: task.description,
      blocking: inferred.blocking,
      contextIsolationRequired: inferred.contextIsolationRequired,
      template: inferred.template,
      reasons: inferred.reasons,
    };
  });
  const blockingTaskIds = taskSuggestions.filter((item) => item.blocking === 'blocking').map((item) => item.id);
  const nonBlockingTaskIds = taskSuggestions.filter((item) => item.blocking === 'non_blocking').map((item) => item.id);
  const templatesUsed = Array.from(new Set(taskSuggestions.map((item) => item.template)));
  const primaryTemplate = pickPrimaryTemplate(taskSuggestions);

  const summaryParts = [
    `primary=${primaryTemplate}`,
    `tasks=${taskSuggestions.length}`,
    `blocking=${blockingTaskIds.length}`,
    `non_blocking=${nonBlockingTaskIds.length}`,
    `templates=${templatesUsed.join(',') || 'none'}`,
  ];

  return {
    primaryTemplate,
    templatesUsed,
    taskSuggestions,
    blockingTaskIds,
    nonBlockingTaskIds,
    summary: summaryParts.join(' | '),
  };
}
