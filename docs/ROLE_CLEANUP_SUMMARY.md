# Finger 角色清理总结

## 清理动作

### 已删除的文件

1. **agents-prompts-md/** - 8 个角色 prompt 文件
   - coder.md, executor.md, orchestrator.md, planner.md
   - reviewer.md, router.md, understanding.md, verifier.md

2. **dev-prompts/** - 4 个角色 prompt 文件
   - executor.md, orchestrator.md, reviewer.md, searcher.md

## 当前架构

统一为两种 Agent：
- **system-agent**: 系统级调度
- **project-agent**: 项目级执行

## 代码清理建议

以下文件仍包含旧角色引用，建议逐步清理：

- `src/blocks/orchestrator-block.ts` (orchestrator)
- `src/blocks/agent-runtime-block.ts` (executor)
- `src/agents/chat-codex/agent-role-config.ts` (system/project 两种)

## 完成状态

✅ Prompt 文件清理完成
⏳ 代码引用清理待后续执行
