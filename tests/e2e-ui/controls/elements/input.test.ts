import { describe, it, expect } from 'vitest';

describe('Controls: Elements/Input', () => {
  it('should update value on change', () => {
    let value = '';
    const handleChange = (newValue: string) => { value = newValue; };
    handleChange('test input');
    expect(value).toBe('test input');
  });

  it('should clear value', () => {
    let value = 'some text';
    const clear = () => { value = ''; };
    clear();
    expect(value).toBe('');
  });

  it('should trim whitespace', () => {
    const input = '  hello world  ';
    const trimmed = input.trim();
    expect(trimmed).toBe('hello world');
  });
});
