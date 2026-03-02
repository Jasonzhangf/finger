import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import './AppLayout.css';

interface AppLayoutProps {
  leftSidebar: ReactNode;
  canvas: ReactNode;
  rightPanel: ReactNode;
  bottomPanel: ReactNode;
}

type DragTarget = 'left' | 'right' | 'bottom';

interface DragState {
  target: DragTarget;
  startX: number;
  startY: number;
  startLeft: number;
  startRight: number;
  startBottom: number;
  rightCollapsed: boolean;
  bottomCollapsed: boolean;
}

const COLLAPSED_PANEL_SIZE = 44;
const LEFT_MIN = 260;
const RIGHT_MIN = 360;
const BOTTOM_MIN = 180;
const CANVAS_MIN_WIDTH = 320;
const MAIN_MIN_HEIGHT = 220;

const LEFT_WIDTH_KEY = 'finger-ui-layout-left-width';
const RIGHT_WIDTH_KEY = 'finger-ui-layout-right-width';
const BOTTOM_HEIGHT_KEY = 'finger-ui-layout-bottom-height';
const RIGHT_COLLAPSED_KEY = 'finger-ui-layout-right-collapsed';
const BOTTOM_COLLAPSED_KEY = 'finger-ui-layout-bottom-collapsed';

const DEFAULT_LEFT_WIDTH = 292;
const DEFAULT_RIGHT_WIDTH = 520;
const DEFAULT_BOTTOM_HEIGHT = 340;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.floor(parsed);
  } catch {
    return fallback;
  }
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return raw === '1' || raw === 'true';
  } catch {
    return fallback;
  }
}

function persistLayoutNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(Math.floor(value)));
  } catch {
    // ignore persistence failures
  }
}

function persistLayoutBoolean(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // ignore persistence failures
  }
}

export const AppLayout = ({
  leftSidebar,
  canvas,
  rightPanel,
  bottomPanel,
}: AppLayoutProps) => {
  const [leftPanelWidth, setLeftPanelWidth] = useState(() => readStoredNumber(LEFT_WIDTH_KEY, DEFAULT_LEFT_WIDTH));
  const [rightPanelWidth, setRightPanelWidth] = useState(() => readStoredNumber(RIGHT_WIDTH_KEY, DEFAULT_RIGHT_WIDTH));
  const [bottomPanelHeight, setBottomPanelHeight] = useState(() => readStoredNumber(BOTTOM_HEIGHT_KEY, DEFAULT_BOTTOM_HEIGHT));
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(() => readStoredBoolean(RIGHT_COLLAPSED_KEY, false));
  const [bottomPanelCollapsed, setBottomPanelCollapsed] = useState(() => readStoredBoolean(BOTTOM_COLLAPSED_KEY, false));

  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    persistLayoutNumber(LEFT_WIDTH_KEY, leftPanelWidth);
  }, [leftPanelWidth]);

  useEffect(() => {
    persistLayoutNumber(RIGHT_WIDTH_KEY, rightPanelWidth);
  }, [rightPanelWidth]);

  useEffect(() => {
    persistLayoutNumber(BOTTOM_HEIGHT_KEY, bottomPanelHeight);
  }, [bottomPanelHeight]);

  useEffect(() => {
    persistLayoutBoolean(RIGHT_COLLAPSED_KEY, rightPanelCollapsed);
  }, [rightPanelCollapsed]);

  useEffect(() => {
    persistLayoutBoolean(BOTTOM_COLLAPSED_KEY, bottomPanelCollapsed);
  }, [bottomPanelCollapsed]);

  useEffect(() => {
    const onResize = (): void => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const effectiveRight = rightPanelCollapsed ? COLLAPSED_PANEL_SIZE : rightPanelWidth;
      const leftMax = Math.max(LEFT_MIN, width - effectiveRight - CANVAS_MIN_WIDTH);
      const rightMax = Math.max(RIGHT_MIN, width - leftPanelWidth - CANVAS_MIN_WIDTH);
      const bottomMax = Math.max(BOTTOM_MIN, height - MAIN_MIN_HEIGHT);

      setLeftPanelWidth((prev) => clamp(prev, LEFT_MIN, leftMax));
      setRightPanelWidth((prev) => clamp(prev, RIGHT_MIN, rightMax));
      setBottomPanelHeight((prev) => clamp(prev, BOTTOM_MIN, bottomMax));
    };

    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [bottomPanelHeight, leftPanelWidth, rightPanelCollapsed, rightPanelWidth]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;

      if (drag.target === 'left') {
        const delta = event.clientX - drag.startX;
        const effectiveRight = drag.rightCollapsed ? COLLAPSED_PANEL_SIZE : drag.startRight;
        const maxLeft = Math.max(LEFT_MIN, window.innerWidth - effectiveRight - CANVAS_MIN_WIDTH);
        setLeftPanelWidth(clamp(drag.startLeft + delta, LEFT_MIN, maxLeft));
        return;
      }

      if (drag.target === 'right') {
        if (drag.rightCollapsed) return;
        const delta = event.clientX - drag.startX;
        const maxRight = Math.max(RIGHT_MIN, window.innerWidth - drag.startLeft - CANVAS_MIN_WIDTH);
        setRightPanelWidth(clamp(drag.startRight - delta, RIGHT_MIN, maxRight));
        return;
      }

      if (drag.bottomCollapsed) return;
      const delta = event.clientY - drag.startY;
      const maxBottom = Math.max(BOTTOM_MIN, window.innerHeight - MAIN_MIN_HEIGHT);
      setBottomPanelHeight(clamp(drag.startBottom - delta, BOTTOM_MIN, maxBottom));
    };

    const onMouseUp = (): void => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.classList.remove('layout-resizing');
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.classList.remove('layout-resizing');
    };
  }, []);

  const beginResize = useCallback((target: DragTarget, event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    dragRef.current = {
      target,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: leftPanelWidth,
      startRight: rightPanelWidth,
      startBottom: bottomPanelHeight,
      rightCollapsed: rightPanelCollapsed,
      bottomCollapsed: bottomPanelCollapsed,
    };
    document.body.classList.add('layout-resizing');
  }, [bottomPanelCollapsed, bottomPanelHeight, leftPanelWidth, rightPanelCollapsed, rightPanelWidth]);

  const rightWidth = rightPanelCollapsed ? COLLAPSED_PANEL_SIZE : rightPanelWidth;
  const bottomHeight = bottomPanelCollapsed ? COLLAPSED_PANEL_SIZE : bottomPanelHeight;

  return (
    <div className="app-layout">
      <aside className="left-sidebar" style={{ width: leftPanelWidth }}>
        {leftSidebar}
      </aside>
      <div
        className="panel-resizer panel-resizer-vertical left-resizer"
        role="separator"
        aria-label="resize-left-panel"
        onMouseDown={(event) => beginResize('left', event)}
      />

      <div className="main-area">
        <div className="middle-row">
          <main className="canvas-container">
            {canvas}
          </main>

          {!rightPanelCollapsed && (
            <div
              className="panel-resizer panel-resizer-vertical right-resizer"
              role="separator"
              aria-label="resize-right-panel"
              onMouseDown={(event) => beginResize('right', event)}
            />
          )}

          <aside
            className={`right-panel ${rightPanelCollapsed ? 'collapsed' : ''}`}
            style={{ width: rightWidth }}
          >
            <button
              className="panel-toggle"
              onClick={() => setRightPanelCollapsed((prev) => !prev)}
            >
              {rightPanelCollapsed ? '◀' : '▶'}
            </button>
            {!rightPanelCollapsed && rightPanel}
          </aside>
        </div>

        {!bottomPanelCollapsed && (
          <div
            className="panel-resizer panel-resizer-horizontal bottom-resizer"
            role="separator"
            aria-label="resize-bottom-panel"
            onMouseDown={(event) => beginResize('bottom', event)}
          />
        )}

        <div
          className={`bottom-panel ${bottomPanelCollapsed ? 'collapsed' : ''}`}
          style={{ height: bottomHeight }}
        >
          <button
            className="panel-toggle-bottom"
            onClick={() => setBottomPanelCollapsed((prev) => !prev)}
          >
            {bottomPanelCollapsed ? '▲' : '▼'}
          </button>
          {!bottomPanelCollapsed && bottomPanel}
        </div>
      </div>
    </div>
  );
};
