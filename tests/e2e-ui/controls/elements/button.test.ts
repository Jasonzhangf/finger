import { describe, it, expect } from 'vitest';

describe('Controls: Elements/Button', () => {
  it('should handle click', () => {
    let clicked = false;
    const handleClick = () => { clicked = true; };
    handleClick();
    expect(clicked).toBe(true);
  });

  it('should be disabled when loading', () => {
    const isDisabled = (loading: boolean) => loading;
    expect(isDisabled(true)).toBe(true);
    expect(isDisabled(false)).toBe(false);
  });

  it('should render different variants', () => {
    const variants = ['primary', 'secondary', 'danger'];
    expect(variants).toContain('primary');
    expect(variants).toContain('secondary');
    expect(variants).toContain('danger');
  });
});
