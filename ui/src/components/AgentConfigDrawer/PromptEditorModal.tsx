import { useEffect, useMemo, useState } from 'react';
import './PromptEditorModal.css';

export interface PromptEditorMeta {
  title: string;
  role: string;
  source: string;
  path: string;
  editablePath: string;
}

interface PromptEditorModalProps {
  isOpen: boolean;
  meta: PromptEditorMeta | null;
  value: string;
  isSaving?: boolean;
  onClose: () => void;
  onChange: (value: string) => void;
  onSave: () => void;
}

interface MarkdownBlock {
  type: 'heading' | 'paragraph' | 'blockquote' | 'list' | 'code';
  level?: number;
  lines: string[];
  language?: string;
  ordered?: boolean;
}

function inlineMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }
    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push({ type: 'code', lines: codeLines, ...(language ? { language } : {}) });
      i += 1;
      continue;
    }
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, lines: [headingMatch[2]] });
      i += 1;
      continue;
    }
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('>')) {
        quoteLines.push((lines[i] ?? '').trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'blockquote', lines: quoteLines });
      continue;
    }
    const ordered = /^\d+\.\s+/.test(trimmed);
    const unordered = /^[-*+]\s+/.test(trimmed);
    if (ordered || unordered) {
      const listLines: string[] = [];
      while (i < lines.length) {
        const current = (lines[i] ?? '').trim();
        if (!(ordered ? /^\d+\.\s+/.test(current) : /^[-*+]\s+/.test(current))) break;
        listLines.push(current.replace(ordered ? /^\d+\.\s+/ : /^[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'list', lines: listLines, ordered });
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      const currentTrimmed = current.trim();
      if (!currentTrimmed) break;
      if (/^(#{1,6})\s+/.test(currentTrimmed) || currentTrimmed.startsWith('```') || currentTrimmed.startsWith('>') || /^[-*+]\s+/.test(currentTrimmed) || /^\d+\.\s+/.test(currentTrimmed)) {
        break;
      }
      paragraph.push(currentTrimmed);
      i += 1;
    }
    blocks.push({ type: 'paragraph', lines: [paragraph.join(' ')] });
  }
  return blocks;
}

function MarkdownPreview({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  if (blocks.length === 0) {
    return <div className="prompt-preview-empty">暂无内容</div>;
  }
  return (
    <div className="prompt-preview-markdown">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const Tag = `h${Math.min(6, Math.max(1, block.level ?? 1))}` as keyof JSX.IntrinsicElements;
          return <Tag key={`${block.type}-${index}`} dangerouslySetInnerHTML={{ __html: inlineMarkdown(block.lines[0] ?? '') }} />;
        }
        if (block.type === 'blockquote') {
          return (
            <blockquote key={`${block.type}-${index}`}>
              {block.lines.map((line, lineIndex) => (
                <p key={`${index}-${lineIndex}`} dangerouslySetInnerHTML={{ __html: inlineMarkdown(line) }} />
              ))}
            </blockquote>
          );
        }
        if (block.type === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul';
          return (
            <Tag key={`${block.type}-${index}`}>
              {block.lines.map((line, lineIndex) => (
                <li key={`${index}-${lineIndex}`} dangerouslySetInnerHTML={{ __html: inlineMarkdown(line) }} />
              ))}
            </Tag>
          );
        }
        if (block.type === 'code') {
          return (
            <div key={`${block.type}-${index}`} className="prompt-preview-code-wrap">
              {block.language && <div className="prompt-preview-code-lang">{block.language}</div>}
              <pre><code>{block.lines.join('\n')}</code></pre>
            </div>
          );
        }
        return <p key={`${block.type}-${index}`} dangerouslySetInnerHTML={{ __html: inlineMarkdown(block.lines[0] ?? '') }} />;
      })}
    </div>
  );
}

export function PromptEditorModal({
  isOpen,
  meta,
  value,
  isSaving = false,
  onClose,
  onChange,
  onSave,
}: PromptEditorModalProps) {
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    setTab('edit');
  }, [isOpen, meta?.title]);

  if (!isOpen || !meta) return null;

  return (
    <div className="prompt-modal-overlay" onClick={onClose}>
      <div className="prompt-modal" onClick={(event) => event.stopPropagation()}>
        <div className="prompt-modal-header">
          <div>
            <h2>{meta.title}</h2>
            <div className="prompt-modal-meta">role: {meta.role} · 来源: {meta.source}</div>
            <div className="prompt-modal-path">读取: {meta.path || 'inline'} · 写入: {meta.editablePath || '未初始化'}</div>
          </div>
          <div className="prompt-modal-actions">
            <button type="button" className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>编辑</button>
            <button type="button" className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>预览</button>
            <button type="button" className="primary" onClick={onSave} disabled={isSaving}>{isSaving ? '保存中...' : '保存'}</button>
            <button type="button" onClick={onClose}>关闭</button>
          </div>
        </div>
        <div className="prompt-modal-body">
          {tab === 'edit' ? (
            <textarea
              className="prompt-modal-editor"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              spellCheck={false}
            />
          ) : (
            <MarkdownPreview source={value} />
          )}
        </div>
      </div>
    </div>
  );
}

export default PromptEditorModal;
