# 编排控制命令：STOP / START

## 概述

Finger 编排系统支持通过 `STOP` 和 `START` 命令控制任务派发流程，实现资源管理和人工干预。

## 命令定义

### STOP - 暂停编排

**作用**：暂停任务派发，等待执行中的任务完成。

**使用场景**：
- 资源不足，需要等待资源释放
- 需要人工审查当前进度
- 发现任务拆解问题，需要重新规划
- 执行者负载过高，需要限流

**参数**：
```json
{
  "action": "STOP",
  "params": {
    "reason": "等待资源释放 | 人工审查 | 重新规划 | 限流"
  }
}
```

**返回**：
```json
{
  "success": true,
  "observation": "编排已暂停：等待资源释放",
  "data": {
    "paused": true,
    "reason": "等待资源释放",
    "pendingTasks": 5
  }
}
```

### START - 恢复编排

**作用**：恢复任务派发，继续执行剩余任务。

**使用场景**：
- 资源已就绪
- 人工审查通过
- 重新规划完成
- 限流解除

**参数**：
```json
{
  "action": "START",
  "params": {}
}
```

**返回**：
```json
{
  "success": true,
  "observation": "编排已恢复，继续派发任务",
  "data": {
    "paused": false,
    "pendingTasks": 5
  }
}
```

## 并发控制

### 资源池管理

`PARALLEL_DISPATCH` 支持 `maxConcurrency` 参数，根据可用资源数量动态控制并发：

```json
{
  "action": "PARALLEL_DISPATCH",
  "params": {
    "taskIds": ["task-1", "task-2", "task-3", "task-4", "task-5"],
    "maxConcurrency": 3
  }
}
```

**行为**：
- 第一批派发 3 个任务（并发上限）
- 剩余 2 个任务等待下一轮派发
- 每轮完成后自动继续派发剩余任务

### 资源数量建议

| 资源类型 | 推荐并发数 | 说明 |
|---------|-----------|------|
| 本地 Executor | 1-2 | 避免本地资源竞争 |
| 远程 Executor | 3-5 | 网络延迟可掩盖并发开销 |
| 混合资源池 | 动态 | 根据最强资源动态调整 |

## 消息协议

### 编排者状态机

```
[running] ──STOP──> [paused] ──START──> [parallel_dispatch]
     │                                      │
     └───────────── 自动派发 ───────────────┘
```

### 消息格式

**编排者 → 执行者**：
```json
{
  "taskId": "task-1",
  "description": "搜索并收集 DeepSeek 官方发布的所有技术论文和产品信息",
  "bdTaskId": "finger-60.1"
}
```

**执行者 → 编排者（回调）**：
```json
{
  "taskId": "task-1",
  "success": true,
  "output": "搜索结果：找到 15 篇论文...",
  "error": null
}
```

## 使用示例

### 场景 1：资源不足时暂停

```json
// Round N: 检测到资源不足
{"thought":"资源不足，暂停派发","action":"STOP","params":{"reason":"等待资源释放"}}

// Round N+1: 资源就绪
{"thought":"资源已就绪","action":"START","params":{}}
```

### 场景 2：分批派发

```json
// Round N: 派发第一批（3 个并发）
{"thought":"第一批派发","action":"PARALLEL_DISPATCH","params":{"taskIds":["T1","T2","T3","T4","T5"],"maxConcurrency":3}}

// Round N+1: 自动派发剩余
{"thought":"继续派发剩余任务","action":"PARALLEL_DISPATCH","params":{"taskIds":["T4","T5"],"maxConcurrency":3}}
```

## 实现细节

- `STOP` 会保存 checkpoint，状态标记为 `paused`
- `START` 会恢复为 `parallel_dispatch` 状态
- 暂停期间执行者继续完成已派发的任务
- 恢复时自动检测剩余待派发任务
