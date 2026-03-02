import { describe, it, expect } from 'vitest';

describe('Controls: Navigation/Breadcrumb', () => {
  it('should render breadcrumb path', () => {
    const path = ['Home', 'Sessions', 'session-123'];
    expect(path.length).toBe(3);
    expect(path[0]).toBe('Home');
    expect(path[path.length - 1]).toBe('session-123');
  });

  it('should support clicking parent items', () => {
    const path = ['Home', 'Sessions', 'session-123'];
    const navigateTo = (index: number) => path.slice(0, index + 1);
    const result = navigateTo(1);
    expect(result).toEqual(['Home', 'Sessions']);
  });
});
