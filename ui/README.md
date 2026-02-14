# Finger UI Planning

## UI Tasks (bd managed)

### P0 - Core Components

| ID | Task | Description | Deps |
|---|---|---|---|
| finger-10 | AppLayout | LeftSidebar(240px) + Canvas + RightPanel(640px) + BottomPanel(450px) | - |
| finger-3 | LeftSidebar | Tab: Project / AI Provider / Settings. Session management. | finger-10 |
| finger-4 | RightPanel | Chat + BD status panel + Input. Width 640px | finger-10 |
| finger-5 | BottomPanel | Tab: Task Stats / Agent Mgmt / Load Monitor. Height 450px | finger-10 |
| finger-9 | ReactFlow Canvas | Orchestration nodes showing role/name/status | finger-10 |

### P1 - Features

| ID | Task | Description | Deps |
|---|---|---|---|
| finger-6 | AI Provider Config | OpenAI/Anthropic/Local config + Fetch Models + Test | finger-3 |
| finger-7 | Session Management | Path to sessionID, store in ~/.finger/sessions/ | finger-3 |
| finger-8 | Backend API | GET /api/blocks + POST exec + WebSocket | finger-4, finger-5 |

## Implementation Order

1. finger-10: AppLayout - Overall layout framework
2. finger-3: LeftSidebar - Navigation and project management
3. finger-4: RightPanel - Chat and task status
4. finger-5: BottomPanel - Agent dashboard
5. finger-9: ReactFlow Canvas - Orchestration visualization
6. finger-6/7/8: Feature integration

## Layout Dimensions

LeftSidebar: 240px
Canvas: flex-1
RightPanel: 640px
BottomPanel: 450px

## Tech Stack

- React 18 + TypeScript
- ReactFlow (Canvas orchestration)
- CSS Grid / Flexbox (layout)
- WebSocket (real-time updates)

## Acceptance Criteria

- All components independently testable
- Responsive panel collapse
- API integration passing
- Static layout matches design
