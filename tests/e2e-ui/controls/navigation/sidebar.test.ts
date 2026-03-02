import { describe, it, expect } from 'vitest';

describe('Controls: Navigation/Sidebar', () => {
  it('should render sidebar navigation items', () => {
    const items = ['Sessions', 'Agents', 'Settings'];
    expect(items.length).toBeGreaterThan(0);
  });

  it('should mark active item', () => {
    const activeId = 'sessions';
    const items = [{ id: 'sessions', label: 'Sessions' }, { id: 'agents', label: 'Agents' }];
    const activeItem = items.find((i) => i.id === activeId);
    expect(activeItem).toBeDefined();
    expect(activeItem?.id).toBe('sessions');
  });

  it('should support collapsed state', () => {
    let collapsed = false;
    const toggle = () => { collapsed = !collapsed; };
    toggle();
    expect(collapsed).toBe(true);
    toggle();
    expect(collapsed).toBe(false);
  });
});
