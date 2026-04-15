export interface FoldableToolLineItem {
  icon: string;
  cat: string;
  resolvedName: string;
  file: string;
  detail: string;
  line: string;
}

const FOLDABLE_READ_COMMANDS = new Set(['cat', 'head', 'less', 'more', 'tail', 'ls', 'wc']);

function truncateInline(text: string, max = 60): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '\u2026' : trimmed;
}

function truncateVerbatim(text: string, max = 80): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '\u2026' : trimmed;
}

function humanizeMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return `${ms}ms`;
  if (ms % 3600000 === 0) return `${ms / 3600000}h`;
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  return `${Math.floor(ms)}ms`;
}

function detectSleepDuration(rawCommand: string): string | undefined {
  const match = rawCommand.match(/\bsleep\s+([0-9]*\.?[0-9]+)\s*([smhd]?)(?=\s|$|;|&&|\|\|)/i);
  if (!match) return undefined;
  const value = match[1];
  const unit = (match[2] || 's').toLowerCase();
  return `${value}${unit}`;
}

function unwrapShellWrapper(raw: string): string {
  const trimmed = raw.trim();
  const wrapped = trimmed.match(/^(?:\/bin\/)?(?:bash|sh|zsh)\s+-[a-zA-Z]+\s+(.+)$/);
  if (!wrapped || !wrapped[1]) return trimmed;
  const inner = wrapped[1].trim();
  const quote = inner[0];
  if ((quote === '"' || quote === '\'') && inner.endsWith(quote)) {
    return inner.slice(1, -1).trim();
  }
  return inner;
}

function extractReadablePath(command: string): string {
  const tokens = command.match(/[^\s|;'"<>]+/g) || [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (!t || t.startsWith('-') || t === '&&' || t === '||') continue;
    if (t.includes('/') || /\.[a-zA-Z0-9]{1,8}$/.test(t)) return t;
  }
  return '';
}

function extractSearchPattern(command: string): string {
  const quoted = command.match(/["']([^"']{1,80})["']/);
  if (quoted && quoted[1]) return quoted[1].trim();
  const tokens = command.trim().split(/\s+/);
  if (tokens.length <= 1) return '';
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.startsWith('-') || token.startsWith('/')) continue;
    if (token.includes('*') || token.includes('(') || token.includes(')')) continue;
    if (token.includes('/')) continue;
    return token.trim();
  }
  return '';
}

function extractKeywordHints(details: string[]): string[] {
  const keywords: string[] = [];
  for (const detail of details) {
    const m = detail.match(/「([^」]+)」/);
    if (!m || !m[1]) continue;
    const keyword = m[1].trim();
    if (keyword.length > 0 && !keywords.includes(keyword)) keywords.push(keyword);
  }
  return keywords.slice(-2);
}

function isFoldable(item: FoldableToolLineItem): boolean {
  if (item.cat === '搜索') return true;
  if (/^(rg|grep|ag|find|fd|fzf)$/i.test(item.resolvedName)) return true;
  if (/^\s*🔍\s/.test(item.detail)) return true;
  if (FOLDABLE_READ_COMMANDS.has(item.resolvedName)) return true;
  return false;
}

export function foldToolLines(items: FoldableToolLineItem[]): string[] {
  if (items.length <= 1) return items.map((item) => item.line);

  type Group = {
    key: string;
    item: FoldableToolLineItem;
    count: number;
    details: string[];
  };

  const groups: Group[] = [];
  const makeKey = (item: FoldableToolLineItem): string => [
    item.icon,
    item.cat,
    item.resolvedName,
  ].join('|');

  for (const item of items) {
    const key = makeKey(item);
    const prev = groups[groups.length - 1];
    const canFold = !!prev && isFoldable(item) && isFoldable(prev.item) && prev.key === key;
    if (canFold) {
      prev.count += 1;
      if (item.detail) prev.details.push(item.detail);
      continue;
    }
    groups.push({
      key,
      item,
      count: 1,
      details: item.detail ? [item.detail] : [],
    });
  }

  return groups.map((group) => {
    if (group.count <= 1) return group.item.line;
    const filePart = group.item.file ? ` | ${group.item.file}` : '';
    const keywordHints = extractKeywordHints(group.details);
    const keywordPart = keywordHints.length > 0
      ? ` · 最近关键词: ${keywordHints.join(' / ')}`
      : '';
    return `${group.item.icon} [${group.item.cat}] ${group.item.resolvedName}${filePart} ×${group.count}${keywordPart}`;
  });
}

export function formatWriteStdinDetail(payload: Record<string, unknown>): string {
  const chars = typeof payload.chars === 'string' ? payload.chars : '';
  if (chars.trim().length > 0) {
    const visual = chars.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
    if (visual.length <= 320) {
      return `\u270d stdin(${visual.length}): ${visual}`;
    }
    const head = visual.slice(0, 220);
    const tail = visual.slice(-80);
    return `\u270d stdin(${visual.length}): ${head} … ${tail}`;
  }
  const yieldMs = typeof payload.yield_time_ms === 'number' && Number.isFinite(payload.yield_time_ms)
    ? Math.max(0, Math.floor(payload.yield_time_ms))
    : undefined;
  if (typeof yieldMs === 'number' && yieldMs > 0) return `\u23f1 等待输出 ${humanizeMs(yieldMs)}`;
  const maxOutputTokens = typeof payload.max_output_tokens === 'number' && Number.isFinite(payload.max_output_tokens)
    ? Math.max(0, Math.floor(payload.max_output_tokens))
    : undefined;
  if (typeof maxOutputTokens === 'number' && maxOutputTokens > 0) return `\u23f1 轮询输出 max=${maxOutputTokens}`;
  if (typeof payload.chars === 'string') return '\u23f1 轮询输出';
  return '';
}

export function describeExecCommand(rawCommand: string): string {
  const raw = unwrapShellWrapper(rawCommand);
  const lower = raw.toLowerCase();

  const sleepDuration = detectSleepDuration(raw);
  if (sleepDuration) return `\u23f1 sleep ${sleepDuration}`;

  const cdMatch = raw.match(/^\s*cd\s+(.+)$/i);
  if (cdMatch && cdMatch[1]) return `\ud83d\udcc1 切换目录 ${truncateInline(cdMatch[1].trim(), 60)}`;
  if (/^\s*tail\b/.test(lower) && (/\s-f(\s|$)/.test(lower) || /--follow\b/.test(lower))) {
    const path = extractReadablePath(raw);
    return path ? `\ud83d\udcdc 跟踪日志 ${truncateInline(path, 64)}` : '\ud83d\udcdc 跟踪日志输出';
  }
  if (/^\s*(cat|head|less|more)\b/.test(lower)) {
    const path = extractReadablePath(raw);
    return path ? `\ud83d\udcd6 读取 ${truncateInline(path, 64)}` : '\ud83d\udcd6 读取文件';
  }
  if (/^\s*tail\b/.test(lower)) {
    const path = extractReadablePath(raw);
    return path ? `\ud83d\udcd6 读取尾部 ${truncateInline(path, 64)}` : '\ud83d\udcd6 读取文件尾部';
  }
  if (/^\s*(rg|grep|ag)\b/.test(lower)) {
    const pattern = extractSearchPattern(raw);
    const path = extractReadablePath(raw);
    const patternPart = pattern ? `「${truncateInline(pattern, 36)}」` : '';
    if (path && patternPart) return `\ud83d\udd0d 搜索${patternPart} @ ${truncateInline(path, 40)}`;
    if (patternPart) return `\ud83d\udd0d 搜索${patternPart}`;
    if (path) return `\ud83d\udd0d 搜索 @ ${truncateInline(path, 40)}`;
    return '\ud83d\udd0d 搜索文本';
  }
  if (/^\s*find\b/.test(lower)) {
    const path = extractReadablePath(raw);
    const pattern = extractSearchPattern(raw);
    if (path && pattern) return `\ud83d\udd0d 查找 ${truncateInline(path, 40)} (${truncateInline(pattern, 28)})`;
    if (path) return `\ud83d\udd0d 查找 ${truncateInline(path, 40)}`;
    return '\ud83d\udd0d 查找文件';
  }
  if (/^\s*ls\b/.test(lower)) {
    const path = extractReadablePath(raw);
    return path ? `\ud83d\udcc2 列目录 ${truncateInline(path, 64)}` : '\ud83d\udcc2 列目录';
  }
  if (/^\s*wc\b/.test(lower)) {
    const path = extractReadablePath(raw);
    return path ? `\ud83d\udccf 统计 ${truncateInline(path, 64)}` : '\ud83d\udccf 统计内容';
  }
  if (/^\s*git\s+status\b/.test(lower)) return '\ud83e\udded 检查 Git 状态';
  if (/^\s*git\s+diff\b/.test(lower)) return '\ud83e\udded 查看 Git 差异';
  if (/^\s*(pnpm|npm|yarn)\s+test\b/.test(lower)) return '\ud83e\uddea 运行测试';
  if (/^\s*(pnpm|npm|yarn)\s+build\b/.test(lower)) return '\ud83d\udee0\ufe0f 执行构建';
  if (/^\s*patch\b/.test(lower)) return '🧩 应用补丁';
  if (/^\s*(python|python3|node|tsx|ts-node)\b/.test(lower)) {
    const path = extractReadablePath(raw);
    return path ? `▶ 运行脚本 ${truncateInline(path, 64)}` : '▶ 运行脚本';
  }
  if (/^\s*mkdir\b/.test(lower)) {
    const path = extractReadablePath(raw);
    return path ? `📁 创建目录 ${truncateInline(path, 64)}` : '📁 创建目录';
  }
  if (/^\s*touch\b/.test(lower)) {
    const path = extractReadablePath(raw);
    return path ? `📝 创建文件 ${truncateInline(path, 64)}` : '📝 创建文件';
  }
  if (/^\s*(mv|cp)\b/.test(lower)) {
    const path = extractReadablePath(raw);
    return path ? `🧱 更新文件 ${truncateInline(path, 64)}` : '🧱 更新文件';
  }
  if (/^\s*rm\b/.test(lower)) {
    const path = extractReadablePath(raw);
    return path ? `🗑️ 删除 ${truncateInline(path, 64)}` : '🗑️ 删除文件';
  }
  if (/^\s*echo\b/.test(lower) || /^\s*printf\b/.test(lower) || /\btee\b/.test(lower)) {
    const path = extractReadablePath(raw);
    return path ? `📝 输出到 ${truncateInline(path, 64)}` : '📝 输出文本';
  }
  return '🛠️ 执行命令';
}
