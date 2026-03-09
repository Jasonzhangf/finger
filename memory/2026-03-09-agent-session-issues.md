# 2026-03-09 Agent 会话相关问题

## 问题1: 空会话显示编排者实例

### 当前状态
- 空会话时 UI 显示有编排者实例
- 用户期望：空会话时默认有编排器实例化
- 下面的 agent 打开就启动
- 项目记住已打开的 agents

### 实现策略
1. **空会话默认启动编排器**:
   - 修改 session 创建逻辑
   - 自动启动 `finger-orchestrator` 实例
   - 空会话时默认有编排器

2. **Agent 打开即启动**:
   - 当 agent 被使能 (`enabled: true`) 时自动启动实例
   - 不需要手动部署

3. **项目级记住已打开的 agents**:
   - 在 `~/.finger/runtime/state/{project-hash}.json` 存储
   - 记录该项目已启用的 agent IDs
   - 下次打开项目时自动恢复

## 问题2: finger-general 处理

### 当前状态
- `finger-general` 出现在配置面板中
- 无法关闭/禁用
- 用户期望：
  - 配置面板隐藏 `finger-general`
  - 用它作为创建新 agent 的模板
  - UI 上 "+" 按钮创建新 agent 时以 `finger-general` 为模板

### 实现策略
1. **配置面板隐藏 finger-general**:
   - 在 `useAgentRuntimePanel.ts` 中过滤掉 `finger-general`
   - 不在 `configAgents` 中显示

2. **作为创建新 agent 的模板**:
   - 在 BottomPanel 的 "Static Agent" 标题旁边添加 "+" 按钮
   - 点击 "+" 使用 `finger-general` 的配置作为模板
   - 弹出创建对话框，预填充 `finger-general` 的配置
   - 允许用户修改后保存为新 agent

## 文件变更清单

### 后端变更
- `src/runtime/session-manager.ts` - 自动启动编排器逻辑
- `src/runtime/project-state.ts` (新建) - 项目级 agent 状态管理

### 前端变更
- `ui/src/hooks/useAgentRuntimePanel.ts` - 过滤 finger-general
- `ui/src/components/BottomPanel/BottomPanel.tsx` - 添加 "+" 按钮和创建逻辑
- `ui/src/components/BottomPanel/BottomPanel.css` - 添加按钮样式

Tags: agent, session, finger-general, instance-management, project-state
