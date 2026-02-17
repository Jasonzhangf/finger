import { useState, type ReactNode } from 'react';
import './AppLayout.css';

interface AppLayoutProps {
  leftSidebar: ReactNode;
  canvas: ReactNode;
  rightPanel: ReactNode;
  bottomPanel: ReactNode;
}

export const AppLayout = ({
  leftSidebar,
  canvas,
  rightPanel,
  bottomPanel,
}: AppLayoutProps) => {
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const [bottomPanelCollapsed, setBottomPanelCollapsed] = useState(false);
  const expandedRightPanelWidth = 'clamp(480px, 22vw, 640px)';
  const expandedBottomPanelHeight = 'clamp(280px, 32vh, 420px)';

  return (
    <div className="app-layout">
      {/* Left Sidebar - 240px fixed */}
      <aside className="left-sidebar">
        {leftSidebar}
      </aside>

      {/* Main Area */}
      <div className="main-area">
        {/* Top Row: Canvas + Right Panel */}
        <div className="middle-row">
          {/* Canvas - flex: 1 */}
          <main className="canvas-container">
            {canvas}
          </main>

          {/* Right Panel - optimized for 1920x1080+ */}
          <aside 
            className={`right-panel ${rightPanelCollapsed ? 'collapsed' : ''}`}
            style={{ width: rightPanelCollapsed ? 44 : expandedRightPanelWidth }}
          >
            <button 
              className="panel-toggle"
              onClick={() => setRightPanelCollapsed(!rightPanelCollapsed)}
            >
              {rightPanelCollapsed ? '◀' : '▶'}
            </button>
            {!rightPanelCollapsed && rightPanel}
          </aside>
        </div>

        {/* Bottom Panel - optimized for 1920x1080+ */}
        <div 
          className={`bottom-panel ${bottomPanelCollapsed ? 'collapsed' : ''}`}
          style={{ height: bottomPanelCollapsed ? 44 : expandedBottomPanelHeight }}
        >
          <button 
            className="panel-toggle-bottom"
            onClick={() => setBottomPanelCollapsed(!bottomPanelCollapsed)}
          >
            {bottomPanelCollapsed ? '▲' : '▼'}
          </button>
          {!bottomPanelCollapsed && bottomPanel}
        </div>
      </div>
    </div>
  );
};
