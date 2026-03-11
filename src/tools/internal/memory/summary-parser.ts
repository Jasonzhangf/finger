/**
 * Summary Parser - 解析 agent 输出中的 <memory_summary> 块
 *
 * 格式:
 * <memory_summary>
 * [type]: fact|decision|discovery|error|preference|instruction|task
 * [title]: 简短标题
 * [content]:
 * 内容...
 * [tags]: tag1, tag2
 * </memory_summary>
 */

export interface ParsedSummary {
  type: 'fact' | 'decision' | 'discovery' | 'error' | 'preference' | 'instruction' | 'task' | 'summary';
  title: string;
  content: string;
  tags: string[];
}

const SUMMARY_REGEX = /<memory_summary>\s*\n([\s\S]*?)\n?\s*<\/memory_summary>/g;

const TYPE_REGEX = /^\[type\]:\s*(\w+)/m;
const TITLE_REGEX = /^\[title\]:\s*(.+)$/m;
const CONTENT_REGEX = /^\[content\]:\s*\n([\s\S]*?)(?=\n\[tags\]:|$)/m;
const TAGS_REGEX = /^\[tags\]:\s*(.+)$/m;

const VALID_TYPES = ['fact', 'decision', 'discovery', 'error', 'preference', 'instruction', 'task', 'summary'] as const;

export function parseSummaryBlocks(text: string): ParsedSummary[] {
  const results: ParsedSummary[] = [];
  let match;

  while ((match = SUMMARY_REGEX.exec(text)) !== null) {
    const block = match[1];

    const typeMatch = block.match(TYPE_REGEX);
    const titleMatch = block.match(TITLE_REGEX);
    const contentMatch = block.match(CONTENT_REGEX);
    const tagsMatch = block.match(TAGS_REGEX);

    if (!typeMatch || !titleMatch || !contentMatch) {
      continue;
    }

    const type = typeMatch[1].toLowerCase();
    if (!VALID_TYPES.includes(type as any)) {
      continue;
    }

    const title = titleMatch[1].trim();
    const content = contentMatch[1].trim();
    const tags = tagsMatch
      ? tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean)
      : [];

    results.push({
      type: type as ParsedSummary['type'],
      title: title.length > 100 ? title.slice(0, 100) : title,
      content,
      tags,
    });
  }

  return results;
}

export function hasSummaryBlock(text: string): boolean {
  return SUMMARY_REGEX.test(text);
}

export function stripSummaryBlocks(text: string): string {
  return text.replace(SUMMARY_REGEX, '').replace(/\n{3,}/g, '\n\n').trim();
}
/**
 * 格式化显示摘要（剥离标签）
 */
export function formatSummaryForDisplay(summary: ParsedSummary): string {
  const typeEmoji: Record<string, string> = {
    fact: '📌',
    decision: '🎯',
    discovery: '💡',
    error: '❌',
    preference: '⭐',
    instruction: '📋',
    task: '✅',
    summary: '📝',
  };

  const emoji = typeEmoji[summary.type] || '📝';
  const tags = summary.tags.length > 0 ? ` [${summary.tags.join(', ')}]` : '';

  return `${emoji} **${summary.title}**${tags}\n${summary.content}`;
}

/**
 * 从响应文本中提取并格式化摘要用于显示
 */
export function extractAndFormatSummaries(text: string): { display: string; cleaned: string; summaries: ParsedSummary[] } {
  const summaries = parseSummaryBlocks(text);
  const cleaned = stripSummaryBlocks(text);

  if (summaries.length === 0) {
    return { display: '', cleaned, summaries: [] };
  }

  const display = summaries.map(formatSummaryForDisplay).join('\n\n---\n\n');
  return { display, cleaned, summaries };
}
