# Finger 进化系统设计文档

## 一、设计目标

在 Finger 现有基础上（context_ledger + MEMORY.md + mempalace），增强**系统自我进化能力**：

1. **自动洞察** — 从历史数据中提取改进建议
2. **RL 自训练** — 从失败轨迹中学习，避免重复错误
3. **记忆增强** — 用 mempalace 做语义检索，ledger 做原始记录

---

## 二、Hermes 进化机制深度剖析

### 2.1 洞察引擎激活与消费

**激活方式：**

```bash
# CLI 命令激活
hermes insights --days 30

# 网关命令激活（Telegram/Discord/CLI 内）
/insights 30
```

**消费路径：**

```
┌─────────────────────────────────────────────────────────────────┐
│                    InsightsEngine                               │
├─────────────────────────────────────────────────────────────────┤
│  1. 查询 SQLite SessionDB（hermes_state.py）                     │
│  2. 提取 sessions + messages 表数据                             │
│  3. 计算各维度指标                                               │
│  4. 生成结构化报告 + 终端格式化输出                               │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    输出维度                                      │
├─────────────────────────────────────────────────────────────────┤
│  • Token 消耗统计（input/output/cache_read/cache_write）         │
│  • 成本估算（按模型定价计算 USD）                                 │
│  • 工具使用频率（调用次数 + 成功率）                              │
│  • 活动趋势（按天/小时分布）                                      │
│  • 模型/平台对比                                                 │
│  • 会话时长分析                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**核心代码路径：**

```python
# hermes_cli/main.py:5252-5265
def cmd_insights(args):
    from hermes_state import SessionDB
    from agent.insights import InsightsEngine
    
    db = SessionDB()
    engine = InsightsEngine(db)
    report = engine.generate(days=args.days)  # 核心调用
    print(engine.format_terminal(report))
    db.close()
```

**数据源结构：**

```sql
-- hermes_state.py SessionDB 表结构
sessions:
  - session_id, model, platform, created_at, ended_at
  - input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
  - billing_provider, billing_base_url

messages:
  - session_id, role, content, tool_name, tool_args
  - created_at, tokens
```

---

### 2.2 RL 训练激活与消费

**激活方式：**

```bash
# 1. 压缩轨迹数据（生成训练样本）
python trajectory_compressor.py --input=data/trajectories.jsonl --sample_percent=15

# 2. 启动 RL 训练
python -m tools.rl_training_tool start --environment gsm8k --config config.yaml
```

**训练样本提取流程：**

```
┌─────────────────────────────────────────────────────────────────┐
│              TrajectoryCompressor                               │
├─────────────────────────────────────────────────────────────────┤
│  输入：JSONL 轨迹文件（完整对话历史）                              │
│                                                                 │
│  处理步骤：                                                       │
│  1. 读取轨迹，计算 token 数                                       │
│  2. 保护首尾关键 turn（系统提示 + 最终结果）                       │
│  3. 用辅助 LLM 压缩中间部分（生成摘要）                            │
│  4. 输出压缩后的轨迹（适合训练窗口）                               │
│                                                                 │
│  输出：compressed.jsonl（符合 target_max_tokens）                 │
└─────────────────────────────────────────────────────────────────┘
```

**压缩策略核心参数：**

```python
# trajectory_compressor.py CompressionConfig
@dataclass
class CompressionConfig:
    target_max_tokens: int = 15250      # 目标最大 token
    summary_target_tokens: int = 750    # 摘要目标 token
    
    protect_first_system: bool = True   # 保护系统提示
    protect_first_human: bool = True    # 保护首次用户输入
    protect_first_gpt: bool = True      # 保护首次模型回复
    protect_first_tool: bool = True     # 保护首次工具调用
    protect_last_n_turns: int = 4       # 保护最后 N 轮
    
    summarization_model: str = "google/gemini-3-flash-preview"
    num_workers: int = 4
    max_concurrent_requests: int = 50
```

**RL 训练流程：**

```
┌─────────────────────────────────────────────────────────────────┐
│                    RLTrainingTool                               │
├─────────────────────────────────────────────────────────────────┤
│  1. 环境发现：扫描 tinker_atropos/environments/                   │
│  2. 配置管理：加载 YAML + 应用 LOCKED_FIELDS                      │
│  3. 启动训练：subprocess 调用 tinker-atropos                      │
│  4. 状态监控：WandB metrics + 日志轮询                            │
│  5. 结果获取：checkpoint + 评估指标                               │
└─────────────────────────────────────────────────────────────────┘
```

**锁定配置（基础设施安全）：**

```python
# tools/rl_training_tool.py
LOCKED_FIELDS = {
    "env": {
        "tokenizer_name": "Qwen/Qwen3-8B",
        "max_token_length": 8192,
        "total_steps": 2500,
        # ... 模型不可修改的基础设施配置
    },
    "openai": [...],  # 模型后端配置
    "tinker": {...},  # LoRA 训练参数
    "slurm": False,
    "testing": False,
}
```

---

## 三、Finger 实现方案

### 3.1 架构整合

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Finger Evolution System                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐│
│  │  context_ledger │────▶│  mempalace      │────▶│ insights_engine ││
│  │  (原始记录)      │     │  (语义索引)      │     │  (洞察生成)      ││
│  │  JSONL          │     │  SQLite+Embed   │     │  Rust           ││
│  └─────────────────┘     └─────────────────┘     └─────────────────┘│
│          │                       │                       │          │
│          │                       ▼                       ▼          │
│          │              ┌─────────────────┐     ┌─────────────────┐│
│          │              │ 语义搜索        │     │ 改进建议        ││
│          │              │ "上次怎么解决   │     │ MEMORY.md 更新  ││
│          │              │  这个错误?"     │     │ 用户通知        ││
│          └─────────────▶└─────────────────┘     └─────────────────┘│
│                                  │                       │          │
│                                  ▼                       ▼          │
│                          ┌─────────────────┐     ┌─────────────────┐│
│                          │ 失败轨迹提取     │────▶│ RL 训练样本     ││
│                          │ 错误模式聚类     │     │ 模型微调        ││
│                          └─────────────────┘     └─────────────────┘│
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 数据流设计

```
用户交互 → context_ledger.jsonl (追加)
                    │
                    ▼
            mempalace sync (异步)
                    │
                    ▼
            ┌───────────────────────────────────────┐
            │         每日洞察任务                   │
            │  cron: "0 6 * * *" (06:00)           │
            │                                       │
            │  1. 读取 ledger 最近 7 天             │
            │  2. 统计工具使用 + 错误模式            │
            │  3. 调用 mempalace 聚类相似错误       │
            │  4. 生成改进建议                      │
            │  5. 写入 MEMORY.md                    │
            │  6. 可选：通知用户                    │
            └───────────────────────────────────────┘
                    │
                    ▼
            ┌───────────────────────────────────────┐
            │         每周训练任务                   │
            │  cron: "0 2 * * 0" (周日凌晨)         │
            │                                       │
            │  1. 提取失败轨迹                      │
            │  2. 压缩为训练样本                    │
            │  3. 启动 RL 微调                      │
            │  4. 保存 checkpoint                   │
            └───────────────────────────────────────┘
```

### 3.3 Rust 核心模块设计

#### 3.3.1 洞察引擎

```rust
// src/insights/engine.rs
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

/// 洞察引擎配置
#[derive(Debug, Clone, Deserialize)]
pub struct InsightsConfig {
    /// Ledger 路径
    pub ledger_path: PathBuf,
    /// Mempalace 数据库路径
    pub mempalace_db: PathBuf,
    /// 分析天数
    pub days: u32,
}

/// 洞察报告
#[derive(Debug, Clone, Serialize)]
pub struct InsightsReport {
    /// 生成时间
    pub generated_at: String,
    /// 分析时段
    pub period_days: u32,
    /// Token 统计
    pub token_stats: TokenStats,
    /// 工具使用统计
    pub tool_usage: Vec<ToolUsageStats>,
    /// 错误模式
    pub error_patterns: Vec<ErrorPattern>,
    /// 用户意图模式
    pub intent_patterns: Vec<IntentPattern>,
    /// 改进建议
    pub recommendations: Vec<Recommendation>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TokenStats {
    pub total_input: u64,
    pub total_output: u64,
    pub avg_per_session: f64,
    pub peak_session: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolUsageStats {
    pub tool_name: String,
    pub call_count: u64,
    pub success_count: u64,
    pub failure_count: u64,
    pub avg_latency_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorPattern {
    pub pattern_id: String,
    pub summary: String,
    pub occurrence_count: u64,
    pub last_occurrence: String,
    pub example_messages: Vec<String>,
    pub root_cause_hypothesis: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct IntentPattern {
    pub intent: String,
    pub frequency: u64,
    pub avg_tokens: f64,
    pub typical_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Recommendation {
    pub priority: String,  // "high", "medium", "low"
    pub category: String,  // "performance", "cost", "reliability", "usability"
    pub title: String,
    pub description: String,
    pub action_suggestion: String,
}

/// 洞察引擎主结构
pub struct InsightsEngine {
    config: InsightsConfig,
    mempalace: MempalaceBridge,
}

impl InsightsEngine {
    pub fn new(config: InsightsConfig) -> Result<Self, Box<dyn std::error::Error>> {
        let mempalace = MempalaceBridge::new(&config.mempalace_db)?;
        Ok(Self { config, mempalace })
    }
    
    /// 生成洞察报告
    pub fn generate(&self, days: u32) -> Result<InsightsReport, Box<dyn std::error::Error>> {
        // 1. 读取 ledger 数据
        let entries = self.read_ledger_days(days)?;
        
        // 2. 并行计算各维度
        let token_stats = self.analyze_tokens(&entries)?;
        let tool_usage = self.analyze_tools(&entries)?;
        let error_patterns = self.analyze_errors(&entries)?;
        let intent_patterns = self.analyze_intents(&entries)?;
        
        // 3. 生成建议
        let recommendations = self.generate_recommendations(
            &token_stats,
            &tool_usage,
            &error_patterns,
        );
        
        Ok(InsightsReport {
            generated_at: chrono::Utc::now().to_rfc3339(),
            period_days: days,
            token_stats,
            tool_usage,
            error_patterns,
            intent_patterns,
            recommendations,
        })
    }
    
    /// 分析错误模式（核心：使用 mempalace 语义聚类）
    fn analyze_errors(&self, entries: &[LedgerEntry]) -> Result<Vec<ErrorPattern>, Box<dyn std::error::Error>> {
        // 提取所有错误事件
        let errors: Vec<_> = entries.iter()
            .filter(|e| e.event_type == "error")
            .collect();
        
        if errors.is_empty() {
            return Ok(vec![]);
        }
        
        let mut patterns: Vec<ErrorPattern> = vec![];
        let mut clustered = vec![false; errors.len()];
        
        // 对每个未聚类的错误，搜索相似错误
        for (i, error) in errors.iter().enumerate() {
            if clustered[i] {
                continue;
            }
            
            // 使用 mempalace 语义搜索
            let similar = self.mempalace.search_similar(
                &error.message,
                10,  // 最多返回 10 个相似
            )?;
            
            // 创建新模式
            let mut pattern = ErrorPattern {
                pattern_id: uuid::Uuid::new_v4().to_string(),
                summary: self.summarize_error(&error.message),
                occurrence_count: 1,
                last_occurrence: error.timestamp.clone(),
                example_messages: vec![error.message.clone()],
                root_cause_hypothesis: self.hypothesize_root_cause(&error.message),
            };
            
            // 归并相似错误
            for (j, other) in errors.iter().enumerate() {
                if i != j && !clustered[j] && similar.iter().any(|s| s.matches(&other.message)) {
                    clustered[j] = true;
                    pattern.occurrence_count += 1;
                    pattern.example_messages.push(other.message.clone());
                    if other.timestamp > pattern.last_occurrence {
                        pattern.last_occurrence = other.timestamp.clone();
                    }
                }
            }
            
            clustered[i] = true;
            patterns.push(pattern);
        }
        
        // 按频率排序
        patterns.sort_by(|a, b| b.occurrence_count.cmp(&a.occurrence_count));
        
        Ok(patterns)
    }
    
    /// 生成改进建议
    fn generate_recommendations(
        &self,
        token_stats: &TokenStats,
        tool_usage: &[ToolUsageStats],
        error_patterns: &[ErrorPattern],
    ) -> Vec<Recommendation> {
        let mut recommendations = vec![];
        
        // 1. Token 消耗建议
        if token_stats.avg_per_session > 50000.0 {
            recommendations.push(Recommendation {
                priority: "medium".to_string(),
                category: "cost".to_string(),
                title: "平均 Token 消耗较高".to_string(),
                description: format!(
                    "平均每会话消耗 {:.0} tokens，考虑启用更激进的压缩策略",
                    token_stats.avg_per_session
                ),
                action_suggestion: "调整 context_ledger 压缩阈值为 0.3".to_string(),
            });
        }
        
        // 2. 工具失败率建议
        for tool in tool_usage {
            let failure_rate = tool.failure_count as f64 / tool.call_count as f64;
            if failure_rate > 0.3 {
                recommendations.push(Recommendation {
                    priority: "high".to_string(),
                    category: "reliability".to_string(),
                    title: format!("工具 {} 失败率过高", tool.tool_name),
                    description: format!("失败率 {:.1}%，需要排查根因", failure_rate * 100.0),
                    action_suggestion: format!("检查 {} 的前置条件和参数验证", tool.tool_name),
                });
            }
        }
        
        // 3. 错误模式建议
        for pattern in error_patterns.iter().take(3) {
            if pattern.occurrence_count > 5 {
                recommendations.push(Recommendation {
                    priority: "high".to_string(),
                    category: "reliability".to_string(),
                    title: format!("高频错误: {}", pattern.summary),
                    description: format!("出现 {} 次，建议修复根因", pattern.occurrence_count),
                    action_suggestion: pattern.root_cause_hypothesis.clone(),
                });
            }
        }
        
        recommendations
    }
    
    /// 格式化为 Markdown 报告
    pub fn format_markdown(&self, report: &InsightsReport) -> String {
        let mut md = String::new();
        
        md.push_str(&format!("# Finger 洞察报告\n\n"));
        md.push_str(&format!("生成时间: {}\n", report.generated_at));
        md.push_str(&format!("分析时段: 最近 {} 天\n\n", report.period_days));
        
        md.push_str("## Token 统计\n\n");
        md.push_str(&format!("- 总输入: {} tokens\n", report.token_stats.total_input));
        md.push_str(&format!("- 总输出: {} tokens\n", report.token_stats.total_output));
        md.push_str(&format!("- 平均每会话: {:.0} tokens\n\n", report.token_stats.avg_per_session));
        
        md.push_str("## 工具使用统计\n\n");
        md.push_str("| 工具 | 调用次数 | 成功率 | 平均延迟 |\n");
        md.push_str("|------|---------|--------|----------|\n");
        for tool in &report.tool_usage {
            let success_rate = (tool.success_count as f64 / tool.call_count as f64) * 100.0;
            md.push_str(&format!(
                "| {} | {} | {:.1}% | {:.0}ms |\n",
                tool.tool_name, tool.call_count, success_rate, tool.avg_latency_ms
            ));
        }
        
        if !report.error_patterns.is_empty() {
            md.push_str("\n## 错误模式\n\n");
            for pattern in &report.error_patterns {
                md.push_str(&format!("### {} ({} 次)\n", pattern.summary, pattern.occurrence_count));
                md.push_str(&format!("{}\n\n", pattern.root_cause_hypothesis));
            }
        }
        
        if !report.recommendations.is_empty() {
            md.push_str("## 改进建议\n\n");
            for rec in &report.recommendations {
                md.push_str(&format!("- [{}] **{}**: {}\n", rec.priority, rec.title, rec.description));
            }
        }
        
        md
    }
}
```

#### 3.3.2 Mempalace 桥接

```rust
// src/mempalace/bridge.rs
use std::path::Path;
use std::process::Command;

/// Mempalace 桥接器
pub struct MempalaceBridge {
    db_path: String,
    mempalace_bin: String,
}

#[derive(Debug, Clone)]
pub struct SearchResult {
    pub id: String,
    pub content: String,
    pub similarity: f32,
}

impl MempalaceBridge {
    pub fn new(db_path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            db_path: db_path.to_string_lossy().to_string(),
            mempalace_bin: "/opt/homebrew/bin/mempalace".to_string(),
        })
    }
    
    /// 同步文档到 Mempalace
    pub fn sync_document(&self, doc_id: &str, content: &str) -> Result<(), Box<dyn std::error::Error>> {
        let output = Command::new(&self.mempalace_bin)
            .args([
                "add",
                "--db", &self.db_path,
                "--id", doc_id,
                "--content", content,
            ])
            .output()?;
        
        if !output.status.success() {
            return Err(format!("mempalace add failed: {:?}", output.stderr).into());
        }
        
        Ok(())
    }
    
    /// 语义搜索
    pub fn search_similar(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
        let output = Command::new(&self.mempalace_bin)
            .args([
                "search",
                "--db", &self.db_path,
                "--query", query,
                "--limit", &limit.to_string(),
            ])
            .output()?;
        
        if !output.status.success() {
            return Err(format!("mempalace search failed: {:?}", output.stderr).into());
        }
        
        // 解析输出
        let stdout = String::from_utf8_lossy(&output.stdout);
        let results: Vec<SearchResult> = stdout
            .lines()
            .filter_map(|line| {
                // 解析格式: "id|similarity|content"
                let parts: Vec<_> = line.splitn(3, '|').collect();
                if parts.len() == 3 {
                    Some(SearchResult {
                        id: parts[0].to_string(),
                        similarity: parts[1].parse().ok()?,
                        content: parts[2].to_string(),
                    })
                } else {
                    None
                }
            })
            .collect();
        
        Ok(results)
    }
    
    /// 批量同步 Ledger 条目
    pub fn sync_ledger_entries(&self, entries: &[LedgerEntry]) -> Result<usize, Box<dyn std::error::Error>> {
        let mut count = 0;
        
        for entry in entries {
            if self.is_significant(entry) {
                let doc_id = format!("ledger-{}-{}", entry.session_id, entry.turn_id);
                let content = self.entry_to_document(entry);
                self.sync_document(&doc_id, &content)?;
                count += 1;
            }
        }
        
        Ok(count)
    }
    
    fn is_significant(&self, entry: &LedgerEntry) -> bool {
        matches!(entry.event_type.as_str(), "tool_call" | "error" | "decision" | "user_input")
    }
    
    fn entry_to_document(&self, entry: &LedgerEntry) -> String {
        format!(
            "[{}] {}: {}",
            entry.timestamp, entry.event_type, entry.message
        )
    }
}

impl SearchResult {
    pub fn matches(&self, text: &str) -> bool {
        // 简单相似度判断（实际应该用 embedding 余弦相似度）
        self.similarity > 0.7 || text.contains(&self.content[..50.min(self.content.len())])
    }
}
```

#### 3.3.3 进化循环调度

```rust
// src/evolution/scheduler.rs
use cron::Schedule;
use chrono::{DateTime, Utc};
use std::sync::Arc;

pub struct EvolutionScheduler {
    insights: Arc<InsightsEngine>,
    mempalace: Arc<MempalaceBridge>,
}

impl EvolutionScheduler {
    pub fn new(
        insights: Arc<InsightsEngine>,
        mempalace: Arc<MempalaceBridge>,
    ) -> Self {
        Self { insights, mempalace }
    }
    
    /// 启动定时任务
    pub async fn start(&self) {
        // 每日洞察任务：06:00
        let daily_schedule = Schedule::from_str("0 0 6 * * *").unwrap();
        let insights = self.insights.clone();
        
        tokio::spawn(async move {
            loop {
                let next = daily_schedule.upcoming(Utc).next().unwrap();
                let delay = (next - Utc::now()).to_std().unwrap();
                tokio::time::sleep(delay).await;
                
                // 执行洞察生成
                match insights.generate(7) {
                    Ok(report) => {
                        // 写入 MEMORY.md
                        let md = insights.format_markdown(&report);
                        insights.append_to_memory_md(&md);
                        
                        // 如果有严重问题，通知用户
                        if report.has_critical_findings() {
                            insights.notify_user(&report.summary());
                        }
                    }
                    Err(e) => {
                        eprintln!("Insights generation failed: {}", e);
                    }
                }
            }
        });
        
        // 每周 RL 训练任务：周日凌晨 02:00
        let weekly_schedule = Schedule::from_str("0 0 2 * * 0").unwrap();
        // ... 类似实现
    }
}
```

---

## 四、实施路线图

### Phase 1: Mempalace 集成（1-2 天）

1. 编写 Rust 同步工具
2. 修改 LedgerWriter 调用同步
3. 测试语义搜索

### Phase 2: 洞察引擎（2-3 天）

1. 实现 InsightsEngine 核心逻辑
2. 错误模式聚类
3. 用户意图提取
4. 报告生成

### Phase 3: RL 训练（3-5 天）

1. 训练样本提取器
2. 奖励函数设计
3. 训练脚本集成
4. 模型更新流程

### Phase 4: 进化循环（1-2 天）

1. 定时任务注册
2. MEMORY.md 自动更新
3. 用户通知机制

---

## 五、关键收益

| 能力 | 实施前 | 实施后 |
|------|--------|--------|
| 用户需求感知 | 手动分析 | 自动识别高频模式 |
| 错误学习 | 被动发现 | 主动聚类 + 建议 |
| 成本优化 | 人工监控 | 自动统计 + 预警 |
| 自我改进 | 无 | 周度进化报告 |
| 记忆检索 | 关键词匹配 | 语义搜索 |

---

## 六、文件结构

```
/Volumes/extension/code/finger/
├── src/
│   ├── insights/
│   │   ├── mod.rs
│   │   ├── engine.rs          # 洞察引擎核心
│   │   └── types.rs           # 类型定义
│   ├── mempalace/
│   │   ├── mod.rs
│   │   └── bridge.rs          # Mempalace 桥接
│   ├── evolution/
│   │   ├── mod.rs
│   │   ├── scheduler.rs       # 定时任务调度
│   │   └── rl/
│   │       ├── sample_extractor.rs
│   │       └── trainer.rs
│   └── main.rs
├── docs/
│   └── evolution-system-design.md  # 本文档
└── Cargo.toml
```
