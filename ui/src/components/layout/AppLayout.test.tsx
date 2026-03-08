import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AppLayout } from './AppLayout.js';

describe('AppLayout', () => {
  const setViewport = (): void => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 1200 });
  };

  it('uses widened default left sidebar width when no stored preference exists', () => {
    setViewport();
    window.localStorage.removeItem('finger-ui-layout-left-width.v2');
    window.localStorage.removeItem('finger-ui-layout-left-width');

    const { container } = render(
      <AppLayout
        leftSidebar={<div>left</div>}
        canvas={<div>canvas</div>}
        rightPanel={<div>right</div>}
        bottomPanel={<div>bottom</div>}
      />,
    );

    const leftSidebar = container.querySelector('.left-sidebar') as HTMLElement | null;
    expect(leftSidebar?.style.width).toBe('380px');
  });

  it('falls back to widened default when legacy left width is narrower than new default', () => {
    setViewport();
    window.localStorage.removeItem('finger-ui-layout-left-width.v2');
    window.localStorage.setItem('finger-ui-layout-left-width', '292');

    const { container } = render(
      <AppLayout
        leftSidebar={<div>left</div>}
        canvas={<div>canvas</div>}
        rightPanel={<div>right</div>}
        bottomPanel={<div>bottom</div>}
      />,
    );

    const leftSidebar = container.querySelector('.left-sidebar') as HTMLElement | null;
    expect(leftSidebar?.style.width).toBe('380px');
  });

  it('restores stored v2 left width preference', () => {
    setViewport();
    window.localStorage.setItem('finger-ui-layout-left-width.v2', '460');

    const { container } = render(
      <AppLayout
        leftSidebar={<div>left</div>}
        canvas={<div>canvas</div>}
        rightPanel={<div>right</div>}
        bottomPanel={<div>bottom</div>}
      />,
    );

    const leftSidebar = container.querySelector('.left-sidebar') as HTMLElement | null;
    expect(leftSidebar?.style.width).toBe('460px');
  });

  it('keeps right and bottom panels clipped so nested content does not overflow viewport', () => {
    setViewport();

    const { container } = render(
      <AppLayout
        leftSidebar={<div>left</div>}
        canvas={<div>canvas</div>}
        rightPanel={<div>right</div>}
        bottomPanel={<div>bottom</div>}
      />,
    );

    const rightPanel = container.querySelector('.right-panel') as HTMLElement | null;
    const bottomPanel = container.querySelector('.bottom-panel') as HTMLElement | null;

    expect(rightPanel?.classList.contains('right-panel')).toBe(true);
    expect(bottomPanel?.classList.contains('bottom-panel')).toBe(true);
  });
});
