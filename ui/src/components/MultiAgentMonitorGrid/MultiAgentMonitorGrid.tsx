import { type FC, useMemo, useState, useCallback, useEffect } from 'react';
import { AgentSessionPanel } from '../AgentSessionPanel/AgentSessionPanel.js';
import './MultiAgentMonitorGrid.css';

export interface Session {
  id: string;
  name: string;
}

export interface ScheduledTask {
  id: string;
  title: string;
  status: 'active' | 'pending' | 'completed' | 'failed';
}

export interface MonitorPanel {
  id: string;
  projectPath: string;
  sessions: Session[];
  scheduledTasks: ScheduledTask[];
  selectedSessionId?: string;
  onOpenProject?: () => void;
  onSelectSession?: (sessionId: string) => void;
}

export interface MultiAgentMonitorGridProps {
  panels?: MonitorPanel[];
  chatAgents?: Array<{ id: string; name: string; status: string }>;
  inputCapability?: { acceptText: boolean; acceptImages: boolean; acceptFiles: boolean; acceptedFileMimePrefixes?: string[] };
}

const DEFAULT_PANELS = 4;

type LayoutMode = 'single' | 'split-vertical' | 'split-horizontal' | 'grid';

interface PaneLayout {
  mode: LayoutMode;
  splitSize?: number;
}

interface ResizingState {
  paneIndex: number;
  direction: 'vertical' | 'horizontal';
  startX: number;
  startY: number;
  initialSize: number;
}

export const MultiAgentMonitorGrid: FC<MultiAgentMonitorGridProps> = ({ panels: propPanels, chatAgents = [], inputCapability }) => {
  const panels = propPanels ?? Array.from({ length: DEFAULT_PANELS }, (_, index) => ({
    id: `panel-placeholder-${index + 1}`,
    projectPath: `/projects/placeholder-${index + 1}`,
    sessions: [],
    scheduledTasks: [],
    selectedSessionId: undefined,
    onOpenProject: undefined,
  }));

  const visibleCount = Math.min(Math.max(panels.length, 1), 4);

  const [paneLayouts, setPaneLayouts] = useState<Record<string, PaneLayout>>(() => {
    const layouts: Record<string, PaneLayout> = {};
    for (let i = 0; i < 4; i++) {
      layouts[`pane-${i}`] = { mode: 'single' };
    }
    return layouts;
  });

  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    paneIndex: number;
  }>({ visible: false, x: 0, y: 0, paneIndex: 0 });

  const [resizing, setResizing] = useState<ResizingState | null>(null);

  const visiblePanels = useMemo(() => panels.slice(0, visibleCount), [panels, visibleCount]);

  const updatePaneLayout = useCallback((paneIndex: number, newMode: LayoutMode, splitSize?: number) => {
    const paneId = `pane-${paneIndex}`;
    setPaneLayouts(prev => ({
      ...prev,
      [paneId]: { mode: newMode, splitSize }
    }));
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, paneIndex: number) => {
    e.preventDefault();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      paneIndex,
    });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(prev => ({ ...prev, visible: false }));
  }, []);

  const handleMenuClick = useCallback((mode: LayoutMode) => {
    updatePaneLayout(contextMenu.paneIndex, mode, 50);
    closeContextMenu();
  }, [contextMenu.paneIndex, updatePaneLayout, closeContextMenu]);

  const renderContextMenu = () => {
    if (!contextMenu.visible) return null;

    const currentLayout = paneLayouts[`pane-${contextMenu.paneIndex}`];

    return (
      <div
        className="pane-context-menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          className={`pane-context-menu-item ${currentLayout?.mode === 'single' ? 'disabled' : ''}`}
          onClick={() => handleMenuClick('single')}
        >
          单窗
        </div>
        <div
          className={`pane-context-menu-item ${currentLayout?.mode === 'split-vertical' ? 'disabled' : ''}`}
          onClick={() => handleMenuClick('split-vertical')}
        >
          左右分
        </div>
        <div
          className={`pane-context-menu-item ${currentLayout?.mode === 'split-horizontal' ? 'disabled' : ''}`}
          onClick={() => handleMenuClick('split-horizontal')}
        >
          上下分
        </div>
        <div
          className={`pane-context-menu-item ${currentLayout?.mode === 'grid' ? 'disabled' : ''}`}
          onClick={() => handleMenuClick('grid')}
        >
          2x2 网格
        </div>
      </div>
    );
  };

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.target as HTMLElement;
    const parent = target.closest('.monitor-grid-item');
    if (!parent) return;

    const parentElement = parent.parentElement;
    if (!parentElement) return;

    const paneIndex = Array.from(parentElement.children).indexOf(parent);
    if (paneIndex === -1) return;

    const currentLayout = paneLayouts[`pane-${paneIndex}`];
    const direction = currentLayout.mode === 'split-vertical' ? 'vertical' : 'horizontal';

    setResizing({
      paneIndex,
      direction,
      startX: e.clientX,
      startY: e.clientY,
      initialSize: currentLayout.splitSize ?? 50,
    });
  }, [paneLayouts]);

  useEffect(() => {
    if (!resizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const { paneIndex, direction, startX, startY, initialSize } = resizing;

      if (direction === 'vertical') {
        const deltaX = e.clientX - startX;
        const containerWidth = window.innerWidth * 0.6;
        const newWidthPercent = Math.max(20, Math.min(80, initialSize + (deltaX / containerWidth) * 100));
        setPaneLayouts(prev => {
          const current = prev[`pane-${paneIndex}`];
          return {
            ...prev,
            [`pane-${paneIndex}`]: { mode: current?.mode ?? 'split-vertical', splitSize: newWidthPercent }
          };
        });
      } else {
        const deltaY = e.clientY - startY;
        const containerHeight = window.innerHeight * 0.6;
        const newHeightPercent = Math.max(20, Math.min(80, initialSize + (deltaY / containerHeight) * 100));
        setPaneLayouts(prev => {
          const current = prev[`pane-${paneIndex}`];
          return {
            ...prev,
            [`pane-${paneIndex}`]: { mode: current?.mode ?? 'split-horizontal', splitSize: newHeightPercent }
          };
        });
      }
    };

    const handleMouseUp = () => {
      setResizing(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizing]);

  const renderPane = useCallback((panel: MonitorPanel, paneIndex: number) => {
    const layout = paneLayouts[`pane-${paneIndex}`] || { mode: 'single' };

    if (layout.mode === 'single') {
      return (
        <div
          key={panel.id}
          className="monitor-grid-item"
          onContextMenu={(e) => handleContextMenu(e, paneIndex)}
        >
          <AgentSessionPanel
            projectPath={panel.projectPath}
            sessionId={panel.selectedSessionId ?? panel.sessions[0]?.id ?? panel.id}
            sessions={panel.sessions}
            scheduledTasks={panel.scheduledTasks}
            selectedSessionId={panel.selectedSessionId ?? panel.sessions[0]?.id}
            onOpenProject={panel.onOpenProject}
            onSelectSession={panel.onSelectSession}
            chatAgents={chatAgents}
            inputCapability={inputCapability}
          />
        </div>
      );
    }

    if (layout.mode === 'split-vertical') {
      const leftWidth = layout.splitSize ?? 50;
      return (
        <div
          key={panel.id}
          className="monitor-grid-item"
          style={{ display: 'flex', flexDirection: 'row' }}
          onContextMenu={(e) => handleContextMenu(e, paneIndex)}
        >
          <div className="monitor-pane-split" style={{ width: `${leftWidth}%`, height: '100%', display: 'flex' }}>
            <AgentSessionPanel
              projectPath={panel.projectPath}
              sessionId={panel.selectedSessionId ?? panel.sessions[0]?.id ?? panel.id}
              sessions={panel.sessions}
              scheduledTasks={panel.scheduledTasks}
              selectedSessionId={panel.selectedSessionId ?? panel.sessions[0]?.id}
              onOpenProject={panel.onOpenProject}
              onSelectSession={panel.onSelectSession}
              chatAgents={chatAgents}
              inputCapability={inputCapability}
            />
          </div>
          <div
            className="monitor-pane-resize-handle"
            style={{ cursor: 'col-resize' }}
            onMouseDown={startResize}
          />
          <div className="monitor-pane-split" style={{ flex: 1, height: '100%', display: 'flex' }}>
            <AgentSessionPanel
              projectPath={panel.projectPath}
              sessionId={panel.selectedSessionId ?? panel.sessions[0]?.id ?? panel.id}
              sessions={panel.sessions}
              scheduledTasks={panel.scheduledTasks}
              selectedSessionId={panel.selectedSessionId ?? panel.sessions[0]?.id}
              onOpenProject={panel.onOpenProject}
              onSelectSession={panel.onSelectSession}
              chatAgents={chatAgents}
              inputCapability={inputCapability}
            />
          </div>
        </div>
      );
    }

    if (layout.mode === 'split-horizontal') {
      const topHeight = layout.splitSize ?? 50;
      return (
        <div
          key={panel.id}
          className="monitor-grid-item"
          style={{ display: 'flex', flexDirection: 'column' }}
          onContextMenu={(e) => handleContextMenu(e, paneIndex)}
        >
          <div className="monitor-pane-split" style={{ height: `${topHeight}%`, width: '100%', display: 'flex' }}>
            <AgentSessionPanel
              projectPath={panel.projectPath}
              sessionId={panel.selectedSessionId ?? panel.sessions[0]?.id ?? panel.id}
              sessions={panel.sessions}
              scheduledTasks={panel.scheduledTasks}
              selectedSessionId={panel.selectedSessionId ?? panel.sessions[0]?.id}
              onOpenProject={panel.onOpenProject}
              onSelectSession={panel.onSelectSession}
              chatAgents={chatAgents}
              inputCapability={inputCapability}
            />
          </div>
          <div
            className="monitor-pane-resize-handle"
            style={{ cursor: 'row-resize' }}
            onMouseDown={startResize}
          />
          <div className="monitor-pane-split" style={{ flex: 1, width: '100%', display: 'flex' }}>
            <AgentSessionPanel
              projectPath={panel.projectPath}
              sessionId={panel.selectedSessionId ?? panel.sessions[0]?.id ?? panel.id}
              sessions={panel.sessions}
              scheduledTasks={panel.scheduledTasks}
              selectedSessionId={panel.selectedSessionId ?? panel.sessions[0]?.id}
              onOpenProject={panel.onOpenProject}
              chatAgents={chatAgents}
              inputCapability={inputCapability}
            />
          </div>
        </div>
      );
    }

    if (layout.mode === 'grid') {
      return (
        <div
          key={panel.id}
          className="monitor-grid-item"
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '4px' }}
          onContextMenu={(e) => handleContextMenu(e, paneIndex)}
        >
          {[0, 1, 2, 3].map((i) => (
            <div key={`grid-${i}`} className="monitor-pane-split" style={{ display: 'flex', overflow: 'hidden' }}>
              <AgentSessionPanel
                projectPath={panel.projectPath}
                sessionId={panel.selectedSessionId ?? panel.sessions[0]?.id ?? panel.id}
                sessions={panel.sessions}
                scheduledTasks={panel.scheduledTasks}
                selectedSessionId={panel.selectedSessionId ?? panel.sessions[0]?.id}
                onOpenProject={panel.onOpenProject}
                onSelectSession={panel.onSelectSession}
                chatAgents={chatAgents}
                inputCapability={inputCapability}
              />
            </div>
          ))}
        </div>
      );
    }

    return null;
  }, [paneLayouts, handleContextMenu, startResize, chatAgents, inputCapability]);

  useEffect(() => {
    const handleClick = () => closeContextMenu();
    if (contextMenu.visible) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu.visible, closeContextMenu]);

  return (
    <div className="multi-agent-monitor-grid" style={{ ['--pane-count' as any]: visibleCount }}>
      <div className="multi-agent-monitor-grid-content">
        {visiblePanels.map((panel, index) => renderPane(panel, index))}
      </div>
      {renderContextMenu()}
    </div>
  );
};
