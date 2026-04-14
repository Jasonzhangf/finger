/**
 * Tests for context-history-compact entity extraction
 */

import { describe, it, expect } from 'vitest';

// 测试实体提取正则规则（复制 context-history-compact.ts 中的逻辑）
function extractEntitiesFromContent(content: string): string[] {
  const keyEntities: string[] = [];
  
  // Phase 1: 路径/URL 提取
  const pathPatterns = [
    /\/[\w\-./]+/g,           // 绝对路径
    /https?:\/\/[^\s]+/g,     // URL
    /~\/[\w\-./]+/g,          // 用户目录路径
  ];
  for (const pattern of pathPatterns) {
    const matches = content.match(pattern);
    if (matches) keyEntities.push(...matches.slice(0, 5));
  }
  
  // Phase 2: 代码符号提取
  const codeSymbolPatterns: Array<{ pattern: RegExp; maxCount: number }> = [
    { pattern: /function\s+(\w+)/g, maxCount: 3 },
    { pattern: /const\s+(\w+)/g, maxCount: 3 },
    { pattern: /let\s+(\w+)/g, maxCount: 2 },
    { pattern: /class\s+(\w+)/g, maxCount: 2 },
    { pattern: /interface\s+(\w+)/g, maxCount: 2 },
    { pattern: /type\s+(\w+)/g, maxCount: 2 },
    { pattern: /def\s+(\w+)/g, maxCount: 3 },
    { pattern: /fn\s+(\w+)/g, maxCount: 2 },
  ];
  for (const { pattern, maxCount } of codeSymbolPatterns) {
    let match: RegExpExecArray | null;
    let count = 0;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(content)) !== null && count < maxCount) {
      keyEntities.push(match[1]);
      count++;
    }
  }
  
  // Phase 3: 去重 + 限制总量
  return [...new Set(keyEntities)].slice(0, 15);
}

describe('Entity Extraction from Content', () => {
  it('extracts function names', () => {
    const content = 'function calculateTotal() { return 0; } function processPayment() { }';
    const entities = extractEntitiesFromContent(content);
    expect(entities).toContain('calculateTotal');
    expect(entities).toContain('processPayment');
  });

  it('extracts class names', () => {
    const content = 'class UserService { } class PaymentHandler { }';
    const entities = extractEntitiesFromContent(content);
    expect(entities).toContain('UserService');
    expect(entities).toContain('PaymentHandler');
  });

  it('extracts variable declarations', () => {
    const content = 'const maxRetryCount = 3; let currentUser = null;';
    const entities = extractEntitiesFromContent(content);
    expect(entities).toContain('maxRetryCount');
    expect(entities).toContain('currentUser');
  });

  it('extracts Python def functions', () => {
    const content = 'def fetch_data(): pass def process_result(): pass';
    const entities = extractEntitiesFromContent(content);
    expect(entities).toContain('fetch_data');
    expect(entities).toContain('process_result');
  });

  it('extracts Rust fn functions', () => {
    const content = 'fn main() { } fn calculate_sum() { }';
    const entities = extractEntitiesFromContent(content);
    expect(entities).toContain('main');
    expect(entities).toContain('calculate_sum');
  });

  it('extracts absolute file paths', () => {
    const content = 'Edit /Volumes/extension/code/finger/src/runtime/context.ts';
    const entities = extractEntitiesFromContent(content);
    expect(entities.some(e => e.includes('/Volumes'))).toBe(true);
  });

  it('extracts URLs', () => {
    const content = '参考 https://example.com/docs/api 和 http://test.org/path';
    const entities = extractEntitiesFromContent(content);
    expect(entities.some(e => e.startsWith('https://'))).toBe(true);
    expect(entities.some(e => e.startsWith('http://'))).toBe(true);
  });

  it('extracts home directory paths', () => {
    const content = '修改 ~/.finger/config/settings.json';
    const entities = extractEntitiesFromContent(content);
    expect(entities.some(e => e.startsWith('~/.finger'))).toBe(true);
  });

  it('limits entity count to 15', () => {
    const content = 'function a() {} function b() {} function c() {} function d() {} ' +
      'const e = 1; const f = 2; const g = 3; const h = 4; ' +
      'class I {} class J {} class K {} ' +
      '/path1 /path2 /path3 /path4 /path5 /path6';
    const entities = extractEntitiesFromContent(content);
    expect(entities.length).toBeLessThanOrEqual(15);
  });

  it('deduplicates entities', () => {
    const content = 'function foo() {} function foo() {} function foo() {}';
    const entities = extractEntitiesFromContent(content);
    expect(entities.filter(e => e === 'foo').length).toBe(1);
  });

  it('handles mixed content with function and path', () => {
    const content = '在 function calculateTotal() 中修改了 /src/utils/helper.ts 的 const config';
    const entities = extractEntitiesFromContent(content);
    expect(entities).toContain('calculateTotal');
    expect(entities).toContain('config');
  });

  it('returns empty array for content without entities', () => {
    const content = '这是一段普通文字，没有任何代码符号或路径';
    const entities = extractEntitiesFromContent(content);
    expect(entities).toEqual([]);
  });

  it('extracts interface and type names', () => {
    const content = 'interface UserConfig { } type PaymentStatus = string;';
    const entities = extractEntitiesFromContent(content);
    expect(entities).toContain('UserConfig');
    expect(entities).toContain('PaymentStatus');
  });
});
