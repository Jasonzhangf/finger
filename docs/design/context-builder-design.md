# Context Builder 动态上下文构建设计

> Last updated: 2026-03-24 23:55 +08:00  
> Status: Active  
> Owner: Jason

## 1. 目标

Context Builder 只负责**重建 history 上下文**（会话历史片段），不改其他注入段：
- skills
- mailbox
- 系统/开发者提示词
- AGENTS 路由、HEARTBEAT 等

即：**history-only**。

---

## 2. 三种模式（mode）

配置字段：`contextBuilder.mode`

### 2.1 minimal（最轻模式）
- 仅移除无关 task
- 不从历史补充 task
- 当前 task 始终保留在尾部

示意：
- 原始: `[task1] [task2(无关)] [task3] [task4(当前)]`
- 结果: `[task1] [task3] [task4(当前)]`

### 2.2 moderate（中等模式）
- 先移除无关 task（按 task 最小颗粒）
- 再从历史按相关性补充 task
- **关键规则**：
  - 如果单个补充 task 超过“移除量”，但总 tokens 仍在上下文预算内，仍允许补充
- 当前 task 始终保留在尾部

流程：
1. 识别并移除无关 task，记录 `removedTokens`
2. 对历史候选按相关性排序
3. 逐个补充：
   - 优先在“移除额度”内补充
   - 若超出移除额度但仍不超总预算，也允许补充
4. 直到预算耗尽或无候选

### 2.3 aggressive（激进模式）
- 完全按相关性重排历史 task
- 当前 task 固定尾部
- 最大化相关性

示意：
- 原始: `[task1] [task2] [task3] [task4(当前)]`
- 相关性排序: `task3 > task1 > task2`
- 结果: `[task3] [task1] [task2] [task4(当前)]`

---

## 3. 排序（ranking）与 dryrun

字段：`contextBuilder.enableModelRanking`
- `false`: 不调用排序模型
- `true` (active): 调排序模型并应用重排
- `'dryrun'`: 调排序模型但**不改顺序**，只输出可观测结果

`rankingProviderId` 关联 `user-settings.json.aiProviders`，不硬编码模型。

---

## 4. 关键配置

文件：`~/.finger/config/user-settings.json`

```json
{
  "contextBuilder": {
    "enabled": true,
    "mode": "minimal | moderate | aggressive",
    "budgetRatio": 0.85,
    "halfLifeMs": 86400000,
    "overThresholdRelevance": 0.5,
    "enableModelRanking": false,
    "rankingProviderId": "tcm",
    "includeMemoryMd": true
  }
}
```

---

## 5. UI 与 API

### 5.1 UI（Settings）
在左侧 `Settings` 新增 Context Builder 控件：
- 启用/禁用
- `mode` 选择：minimal / moderate / aggressive
- `ranking` 选择：off / dryrun / active

### 5.2 API
- `GET /api/v1/context-builder/settings`
- `PUT /api/v1/context-builder/settings`

---

## 6. Context Monitor 可观测性

Context Monitor 会显示：
- `history-only`
- `mode`
- `ranking` 状态（含 dryrun）
- `removed/supplemented` 计数（metadata）

并固定交互语义：
1. 选 Round（最小单元）
2. 看该 Round 的 Selected Context 组合
3. 右侧对照原始 Ledger（已选/未选）
4. 点击查看详情

---

## 7. 实现落点

- `src/runtime/context-builder.ts`：三模式核心逻辑、moderate 补充规则、当前 task 尾部约束
- `src/core/user-settings.ts`：`contextBuilder.mode` + `enableModelRanking`(含 dryrun)
- `src/server/routes/system.ts`：Context Builder settings API
- `src/orchestration/session-manager.ts`：将 `mode` 传入 `buildContext`
- `src/server/routes/ledger-routes.ts`：Context Monitor 返回 mode/ranking 元数据
- `ui/src/components/LeftSidebar/LeftSidebar.tsx`：Settings 选择器

