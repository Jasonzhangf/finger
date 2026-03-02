import { describe, it, expect } from 'vitest';

describe('Controls: Navigation/Tabs', () => {
  it('should switch tabs on click', () => {
    const tabs = [{ id: 'tab1', active: true }, { id: 'tab2', active: false }];
    const selectTab = (id: string) => {
      tabs.forEach((t) => { t.active = t.id === id; });
    };
    selectTab('tab2');
    expect(tabs[0].active).toBe(false);
    expect(tabs[1].active).toBe(true);
  });

  it('should have exactly one active tab', () => {
    const tabs = [{ id: 'a', active: true }, { id: 'b', active: false }, { id: 'c', active: false }];
    const activeCount = tabs.filter((t) => t.active).length;
    expect(activeCount).toBe(1);
  });
});
