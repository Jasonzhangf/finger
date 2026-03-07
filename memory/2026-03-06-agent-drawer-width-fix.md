# 2026-03-06 Agent Drawer Width Fix

- AgentConfigDrawer 默认宽度升级为 720px，最小宽度 520px，最大宽度 1080px。
- 宽度持久化 key 升级为 `finger.agentConfigDrawer.width.v2`，避免旧的 520px 偏好把新默认值锁死。
- 兼容读取旧 key `finger.agentConfigDrawer.width`，仅当旧值大于等于新默认值时继承；否则回退到新默认值。
- 真实浏览器验证：drawer 初始宽度 720px，拖拽后宽度可变为 860px，且写回 localStorage。
- 证据截图：`/tmp/finger-ui-drawer-wide.png`、`/tmp/finger-ui-drawer-resized.png`。

## 2026-03-07 Left Sidebar Width
- AppLayout 左侧主侧栏默认宽度升级为 `380px`，最小宽度升级为 `320px`。
- 左侧主侧栏宽度持久化 key 升级为 `finger-ui-layout-left-width.v2`，旧 key 为 `finger-ui-layout-left-width`。
- 若旧值小于新默认值，不再继承旧窄值，直接回退到新默认宽度。
- 真实浏览器验证：左侧主栏默认宽度 `380px`，拖拽后变为 `500px`，并写回 localStorage。
- 证据截图：`/tmp/finger-ui-left-sidebar-wide.png`。
