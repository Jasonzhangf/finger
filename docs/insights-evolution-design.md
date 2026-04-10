# Finger 洞察引擎与进化循环设计

## 一、设计目标

基于 Hermes Agent 的进化机制，为 Finger 实现一个**自动化洞察生成与消费系统**：
- 从 `reasoning.stop` 的 `learning` 字段自动提取经验
- 利用 `mempalace` 进行语义索引和查询
- 通过定时任务自动生成洞察报告
- 将洞察转化为可执行的建议和技能

**核心原则**：不训练模型，而是通过提示词强化 + 数据驱动来引导系统进化。

---

## 二、Hermes 洞察激活与消费机制分析

### 2.1 激活方式

Hermes 提供了三种洞察激活方式：

| 激活方式 | 入口 | 触发时机 |
|---------|------|---------|
| CLI 手动 | `hermes insights --days 30` | 用户主动请求 |
| 定时任务 | `scheduler.py` | 每日/每周自动 |
| Gateway 触发 | Telegram/Discord 命令 | 对话中请求 |

### 2.2 消费路径

Hermes 的洞察消费路径：

```
┌─────────────────────────────────────────────────────────┐
│                    洞察生成                               │
│   insights.py → 生成报告 → 终端展示                       │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                    洞察消费                               │
│   1. 通知用户（终端/Telegram/Discord）                    │
│   2. 写入 memory（可选）                                  │
│   3. 生成改进建议（recommendations）                       │
│   4. 用户手动决策是否采纳                                 │
└─────────────────────────────────────────────────────────┘
```

**关键发现**：Hermes 的洞察主要是**被动展示**，需要用户手动决策。Finger 可以做得更好——自动转化为技能或配置更新。

---

## 三、Finger 进化系统设计

### 3.1 核心数据流

```
┌─────────────────────────────────────────────────────────┐
│                  1. 经验生成（每 Turn）                   │
│   reasoning.stop → learning 字段                        │
│   - successes: 成功经验                                  │
│   - failures: 失败教训                                   │
│   - tags: 分类标签                                       │
└─────────────────────────────────────────────────────────┘
                          ↓ 自动同步
┌─────────────────────────────────────────────────────────┐
│                  2. 语义索引（后台）                       │
│   context_ledger (JSONL) → mempalace (SQLite+Embedding) │
│   - 写入原始记录                                         │
│   - 生成 embedding 向量                                  │
│   - 建立语义索引                                         │
└─────────────────────────────────────────────────────────┘
                          ↓ 定时触发
┌─────────────────────────────────────────────────────────┐
│                  3. 洞察生成（每日/周）                    │
│   InsightsEngine.analyze()                              │
│   - 聚类相似错误                                         │
│   - 识别高频模式                                         │
│   - 生成改进建议                                         │
└─────────────────────────────────────────────────────────┘
                          ↓ 自动消费
┌─────────────────────────────────────────────────────────┐
│                  4. 自动进化                              │
│   高频错误 → 生成 SKILL.md（防回归）                      │
│   用户偏好 → 更新 MEMORY.md                              │
│   成本异常 → 调整参数                                    │
└─────────────────────────────────────────────────────────┘
```

### 3.2 `reasoning.stop` Learning 提取机制

**现状问题**：`reasoning.stop` 的 `learning` 字段当前只是写入 ledger，没有被自动利用。

**改进方案**：

```typescript
// src/core/ledger/learning-extractor.ts

export interface LearningEntry {
  timestamp: Date;
  successes: string[];
  failures: string[];
  tags: string[];
  tool_usage: ToolUsageRecord[];
  session_id: string;
}

export class LearningExtractor {
  /**
   * 从 reasoning.stop 的 learning 字段提取结构化经验
   */
  async extractAndIndex(): Promise<void> {
    // 1. 读取最近的 learning 条目
    const learnings = await this.readRecentLearnings(7); // 最近 7 天
    
    // 2. 聚类相似失败模式
    const failurePatterns = await this.clusterFailures(learnings);
    
    // 3. 识别高频成功模式
    const successPatterns = await this.clusterSuccesses(learnings);
    
    // 4. 同步到 mempalace 进行语义索引
    await this.syncToMempalace(failurePatterns, successPatterns);
    
    // 5. 生成候选技能
    const skillCandidates = this.generateSkillCandidates(failurePatterns);
    
    // 6. 写入 MEMORY.md
    await this.updateMemoryMd(skillCandidates, successPatterns);
  }
  
  /**
   * 聚类失败模式
   */
  private async clusterFailures(learnings: LearningEntry[]): Promise<FailurePattern[]> {
    const failures = learnings.flatMap(l => l.failures);
    
    // 使用 mempalace 进行语义聚类
    const clusters: Map<string, string[]> = new Map();
    
    for (const failure of failures) {
      // 搜索相似失败
      const similar = await mempalace.search(failure, 5);
      
      if (similar.length > 2) {
        // 找到相似模式，归入已有聚类
        const patternKey = similar[0].id;
        clusters.set(patternKey, [...(clusters.get(patternKey) || []), failure]);
      } else {
        // 创建新聚类
        clusters.set(`pattern-${Date.now()}`, [failure]);
      }
    }
    
    // 按频率排序
    return Array.from(clusters.entries())
      .map(([id, examples]) => ({
        id,
        count: examples.length,
        examples: examples.slice(0, 3),
        recommendation: this.generateRecommendation(examples),
      }))
      .sort((a, b) => b.count - a.count);
  }
}
```

### 3.3 提示词强化：引导生成高质量 Learning

**核心改进**：通过系统提示词强化，引导 Agent 生成**可操作的、结构化的** learning 内容。

**改进 reasoning.stop 的调用约定**：

```markdown
## reasoning.stop 使用规范

### successes 字段
- 必须是具体的、可复用的操作模式
- 格式：`"<action> → <outcome>"` 
- 示例：`"使用 rg 代替 grep 提速 10x"`

### failures 字段
- 必须包含根因分析和避免方法
- 格式：`"<error> → <root_cause> → <prevention>"`
- 示例：`"EPIPE error → kernel stdin closed → 检测 EPIPE 后重试"`

### tags 字段
- 必须包含分类标签，便于聚类
- 推荐：`["error-pattern", "tool-usage", "cost-optimization", "user-preference"]`

### 示例调用
```json
{
  "successes": [
    "使用 exec_command 并行查询多个文件 → 减少 60% 等待时间"
  ],
  "failures": [
    "apply_patch 失败 → 文件路径不存在 → 先检查 file.exists() 再 patch"
  ],
  "tags": ["tool-optimization", "error-pattern"]
}
```
```

### 3.4 自动技能生成

**触发条件**：同一失败模式出现 ≥ 3 次

**生成流程**：

```
高频失败模式 → 提取特征 → 生成 SKILL.md → 通知用户确认
```

**示例**：

失败模式：
- "Tool exec_command does not exists" 出现 12 次
- 根因：session 工具注册表未正确加载

自动生成的 SKILL.md：

```markdown
# Tool Availability Check

## 触发条件
- Agent 尝试调用工具但收到 "Tool does not exists"
- 检测到工具注册表异常

## 自动恢复步骤
1. 检查当前 session 的工具列表
2. 如果关键工具缺失，尝试重新初始化
3. 如果无法恢复，通知用户重启 daemon

## 防止重复
- 在调用工具前检查 `allowed_tools` 列表
- 如果工具不在列表中，提前报错而非延迟失败
```

---

## 四、Mempalace 集成方案

### 4.1 数据同步策略

```rust
// src/evolution/mempalace_bridge.rs

pub struct MempalaceBridge {
    palace_path: PathBuf,
    db_path: PathBuf,
}

impl MempalaceBridge {
    /// 同步 learning 条目到 mempalace
    pub async fn sync_learning(&self, entry: &LearningEntry) -> Result<()> {
        let doc = Document {
            id: format!("learning-{}", entry.timestamp.timestamp()),
            content: format!(
                "Successes: {:?}\nFailures: {:?}\nTags: {:?}",
                entry.successes, entry.failures, entry.tags
            ),
            metadata: json!({
                "type": "learning",
                "session_id": entry.session_id,
                "timestamp": entry.timestamp.to_rfc3339(),
                "tags": entry.tags,
            }),
        };
        
        // 调用 mempalace 添加文档
        self.add_document(&doc).await?;
        
        Ok(())
    }
    
    /// 搜索相似错误模式
    pub async fn search_similar_failures(&self, query: &str, limit: usize) -> Result<Vec<FailureMatch>> {
        let results = self.search(query, limit).await?;
        
        Ok(results.into_iter().map(|r| FailureMatch {
            learning_id: r.id,
            similarity: r.score,
            failure_text: r.content,
            timestamp: r.metadata["timestamp"].as_str().unwrap_or("").to_string(),
        }).collect())
    }
}
```

### 4.2 查询优化

利用 mempalace 的语义搜索能力：

```typescript
// 查询示例
const results = await mempalace.search("EPIPE error kernel stdin", 10);

// 返回相似的历史失败及其解决方案
// 可用于自动生成恢复建议
```

---

## 五、定时任务与进化循环

### 5.1 任务注册

```typescript
// src/evolution/scheduler.ts

export class EvolutionScheduler {
  registerJobs() {
    // 每日洞察生成（06:00）
    cron.schedule("0 6 * * *", async () => {
      const insights = await this.insightsEngine.generateDaily();
      await this.consumeInsights(insights);
    });
    
    // 每周深度分析（周日 02:00）
    cron.schedule("0 2 * * 0", async () => {
      const deepInsights = await this.insightsEngine.generateWeekly();
      await this.proposeSkills(deepInsights.failurePatterns);
    });
    
    // 每月 MEMORY.md 清理（1号 03:00）
    cron.schedule("0 3 1 * *", async () => {
      await this.memoryManager.pruneStaleEntries();
    });
  }
}
```

### 5.2 洞察消费逻辑

```typescript
async consumeInsights(insights: UsageInsights): Promise<void> {
  // 1. 高频失败 → 生成技能候选
  for (const pattern of insights.failurePatterns) {
    if (pattern.count >= 3) {
      await this.proposeSkill(pattern);
    }
  }
  
  // 2. 用户偏好更新
  for (const pref of insights.userPreferences) {
    await this.updateUserPreference(pref);
  }
  
  // 3. 成本异常预警
  if (insights.costEstimation.anomaly) {
    await this.notifyUser({
      type: "cost-warning",
      message: `本周 token 消耗异常：${insights.costEstimation.total} tokens`,
    });
  }
  
  // 4. 写入 MEMORY.md
  await this.memoryManager.appendInsights(insights);
}
```

---

## 六、实施路线图

### Phase 1: Learning 提取器（1周）
- [ ] 实现 `LearningExtractor` 类
- [ ] 修改 `reasoning.stop` 调用点，同步到 mempalace
- [ ] 添加提示词强化

### Phase 2: 洞察引擎（1-2周）
- [ ] 实现 `InsightsEngine` 核心逻辑
- [ ] 错误模式聚类
- [ ] 高频模式识别

### Phase 3: 自动进化（1周）
- [ ] 技能候选生成
- [ ] MEMORY.md 自动更新
- [ ] 用户通知机制

### Phase 4: 集成测试（1周）
- [ ] 端到端测试
- [ ] 性能基准
- [ ] 文档完善

---

## 七、预期收益

| 指标 | 当前状态 | 改进后 |
|------|---------|--------|
| 失败重复率 | 未知 | 自动识别高频失败 |
| 用户反馈利用 | 手动 | 自动提取偏好 |
| 系统进化 | 无 | 周度洞察报告 |
| 技能积累 | 手动 | 自动生成候选 |

---

## 八、关键设计决策

1. **不训练模型**：通过提示词强化 + 数据聚类，实现"软进化"
2. **利用现有组件**：`reasoning.stop` + `mempalace` + `context_ledger`
3. **自动优先**：高频模式自动生成技能候选，用户只需确认
4. **可观测性**：每次进化都有报告，用户可追溯
