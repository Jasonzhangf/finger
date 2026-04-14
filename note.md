# 探索笔记

## 任务
实现 team 状态可观测功能：
1. progress 里面要更新 team 的状态
2. 重启后 system agent 要检查 team 的状态并且汇报项目进度和计划行为

## 执行计划（用户已确认）

### 修改 1：ProgressMonitor 报告包含 team.status
- 文件：`src/server/modules/progress-monitor-types.ts`（添加 teamStatus 字段）
- 文件：`src/server/index.ts`（在 progressReport 中包含 team.status）

### 修改 2：System Agent 启动汇报
- 文件：`src/serverx/modules/system-agent-manager.impl.ts`
- 在 start() 方法中添加汇报逻辑

## 全局唯一真源
1. ProgressMonitor 报告格式定义：`src/server/modules/progress-monitor-types.ts`
2. System Agent 启动入口：`src/serverx/modules/system-agent-manager.impl.ts`
