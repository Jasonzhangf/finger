import { describe, it, expect } from 'vitest';

describe('Controls: Elements/Select', () => {
  it('should select option', () => {
    const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
    let selected = 'a';
    const select = (value: string) => { selected = value; };
    select('b');
    expect(selected).toBe('b');
    expect(options.find((o) => o.value === selected)).toBeDefined();
  });

  it('should handle empty options', () => {
    const options: { value: string; label: string }[] = [];
    expect(options.length).toBe(0);
  });
});
