# 2026-03-07 agent prompt editor modal

## Goal
为 Agent 配置抽屉补齐适合长提示词的编辑体验：支持全屏编辑、Markdown 预览，并保持读取默认 prompt / 保存到 `~/.finger` 覆盖路径的链路清晰可见。

## Changes
- 新增 `ui/src/components/AgentConfigDrawer/PromptEditorModal.tsx` 与 `ui/src/components/AgentConfigDrawer/PromptEditorModal.css`。
- `AgentConfigDrawer` 中为 system/developer prompt 增加 `全屏编辑` 入口，复用现有保存逻辑。
- 模态框显示 `role/source/读取路径/写入路径` 元信息。
- Markdown 预览使用轻量自实现解析，支持标题、段落、引用、列表、代码块、行内 code、粗体、斜体。
- 提示词加载请求接入 `AbortController`，在组件卸载/切换时中止请求，避免测试和 UI teardown 噪音。

## Validation
- `cd ui && pnpm vitest run src/components/AgentConfigDrawer/AgentConfigDrawer.test.tsx`
- `cd ui && pnpm build`

## Notes
- 当前组件测试虽通过，但 happy-dom/vitest 环境里仍可能打印若干外部 socket reset 噪音；本次新增的 prompt 请求 teardown 中止已收敛组件自身 AbortError 噪音。
