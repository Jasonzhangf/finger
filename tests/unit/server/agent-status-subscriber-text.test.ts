import { describe, it, expect } from 'vitest';

// 测试 stripControlBlockForChannel 中的 tool 语法过滤逻辑
function stripToolSyntax(text: string): string {
  return text
    .replace(/\[tool_use\s+id=[^\]]+\s+name=[^\]]+]/gi, '')
    .replace(/\[tool_result\s+id=[^\]]+]/gi, '')
    .replace(/\[function_call(?:_output)?\s+[^\]]+]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

describe('stripToolSyntax', () => {
  it('should remove tool_use syntax', () => {
    const input = '好的，我来执行。\n[tool_use id=call_xxx name=exec_command]\n{"cmd":"ls"}';
    const result = stripToolSyntax(input);
    // tool block 被去掉，留下空行
    expect(result).toContain('好的，我来执行。');
    expect(result).toContain('{"cmd":"ls"}');
    expect(result).not.toContain('[tool_use');
  });

  it('should remove tool_result syntax', () => {
    const input = '执行完成。\n[tool_result id=call_xxx]\noutput: done';
    const result = stripToolSyntax(input);
    expect(result).toContain('执行完成。');
    expect(result).toContain('output: done');
    expect(result).not.toContain('[tool_result');
  });

  it('should remove function_call syntax', () => {
    const input = '开始处理。\n[function_call call_id=abc123 name=read_file]\n完成。';
    const result = stripToolSyntax(input);
    expect(result).toContain('开始处理。');
    expect(result).toContain('完成。');
    expect(result).not.toContain('[function_call');
  });

  it('should handle multiple tool blocks', () => {
    const input = '正文1\n[tool_use id=a name=x]\n正文2\n[tool_result id=b]\n正文3';
    const result = stripToolSyntax(input);
    expect(result).toContain('正文1');
    expect(result).toContain('正文2');
    expect(result).toContain('正文3');
    expect(result).not.toContain('[tool_use');
    expect(result).not.toContain('[tool_result');
  });

  it('should preserve normal text', () => {
    const input = '这是普通文本，没有任何特殊语法。';
    expect(stripToolSyntax(input)).toBe(input);
  });

  it('should collapse excessive newlines', () => {
    const input = '段落1\n\n\n\n\n段落2';
    expect(stripToolSyntax(input)).toBe('段落1\n\n段落2');
  });
});
