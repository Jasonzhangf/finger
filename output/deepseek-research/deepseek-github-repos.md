# DeepSeek GitHub 官方仓库汇总

> 收集时间：2025-02-23
> 组织地址：https://github.com/deepseek-ai
> 总仓库数：32 个

---

## 一、核心大语言模型（LLM）

### 1. DeepSeek-V3
- **地址**：https://github.com/deepseek-ai/DeepSeek-V3
- **类型**：模型权重
- **架构**：MoE (Mixture-of-Experts)
- **参数规模**：671B 总参数 / 37B 激活参数
- **上下文长度**：128K
- **核心特性**：
  - Multi-head Latent Attention (MLA) 架构
  - DeepSeekMoE 高效推理
  - 无辅助损失的负载均衡策略
  - 多 Token 预测训练目标
  - FP8 混合精度训练框架
- **训练成本**：仅 2.788M H800 GPU 小时
- **下载**：🤗 Hugging Face
- **许可证**：MIT License (代码) / Model License (模型)

### 2. DeepSeek-R1
- **地址**：https://github.com/deepseek-ai/DeepSeek-R1
- **类型**：推理模型
- **参数规模**：671B 总参数 / 37B 激活参数
- **上下文长度**：128K
- **核心特性**：
  - 大规模强化学习训练
  - 无需 SFT 的纯 RL 推理能力涌现
  - 自验证、反思、长 CoT 生成
  - 知识蒸馏到小模型
- **蒸馏模型**：
  | 模型 | 基座 | 下载 |
  |------|------|------|
  | DeepSeek-R1-Distill-Qwen-1.5B | Qwen2.5-Math-1.5B | HF |
  | DeepSeek-R1-Distill-Qwen-7B | Qwen2.5-Math-7B | HF |
  | DeepSeek-R1-Distill-Llama-8B | Llama-3.1-8B | HF |
  | DeepSeek-R1-Distill-Qwen-14B | Qwen2.5-14B | HF |
  | DeepSeek-R1-Distill-Qwen-32B | Qwen2.5-32B | HF |
  | DeepSeek-R1-Distill-Llama-70B | Llama-3.3-70B | HF |
- **性能亮点**：AIME 2024 Pass@1 达 79.8%，媲美 OpenAI o1-1217

### 3. DeepSeek-LLM
- **地址**：https://github.com/deepseek-ai/DeepSeek-LLM
- **类型**：通用语言模型
- **参数规模**：7B / 67B
- **上下文长度**：4096
- **训练数据**：2T tokens (中英双语)
- **核心特性**：
  - 与 LLaMA 相同架构
  - 7B 使用 MHA，67B 使用 GQA
  - 提供 Base 和 Chat 版本
  - 支持商业用途
- **性能**：HumanEval Pass@1: 73.78，GSM8K 0-shot: 84.1

---

## 二、代码模型（Code Models）

### 4. DeepSeek-Coder
- **地址**：https://github.com/deepseek-ai/DeepSeek-Coder
- **类型**：代码语言模型
- **参数规模**：1B / 5.7B / 6.7B / 33B
- **上下文长度**：16K
- **训练数据**：2T tokens (87% 代码 + 13% 自然语言)
- **支持语言**：100+ 编程语言
- **核心特性**：
  - 项目级代码补全
  - Fill-in-the-middle 任务支持
  - Base 和 Instruct 版本
- **性能**：在 HumanEval、MultiPL-E、MBPP、DS-1000、APPS 上达 SOTA

---

## 三、多模态模型（Vision-Language）

### 5. DeepSeek-VL
- **地址**：https://github.com/deepseek-ai/DeepSeek-VL
- **类型**：视觉语言模型
- **参数规模**：1.3B / 7B
- **上下文长度**：4096
- **核心能力**：
  - 逻辑图表理解
  - 网页内容解析
  - 公式识别
  - 科学文献理解
  - 自然图像理解
  - 具身智能场景
- **模型版本**：base 和 chat 变体

### 6. DeepSeek-OCR
- **地址**：https://github.com/deepseek-ai/DeepSeek-OCR
- **类型**：OCR 模型
- **发布日期**：2025-10-20
- **核心特性**：从 LLM 中心视角研究视觉编码器的作用

### 7. Janus-Series
- **地址**：https://github.com/deepseek-ai/Janus
- **类型**：统一多模态理解与生成模型
- **核心特性**：统一的多模态理解和生成能力

---

## 四、基础设施与工具链

### 8. DeepEP (High-Performance Communication Library)
- **地址**：https://github.com/deepseek-ai/DeepEP
- **类型**：通信库 / 工具链
- **编程语言**：CUDA / Python
- **核心功能**：
  - 高吞吐量、低延迟的 all-to-all GPU 内核
  - MoE dispatch 和 combine 操作
  - FP8 低精度支持
  - NVLink + RDMA 混合通信
  - 通信-计算重叠
- **性能指标**：
  - Intranode: 153-158 GB/s (NVLink)
  - Internode: 43-58 GB/s (RDMA)
  - Low-latency: 77-369 μs
- **适用场景**：MoE 训练、推理预填充、推理解码

### 9. 3FS (Fire-Flyer File System)
- **地址**：https://github.com/deepseek-ai/3FS
- **类型**：分布式文件系统
- **描述**：高性能分布式文件系统，专为 AI 训练和推理工作负载设计

### 10. DreamCraft3D
- **地址**：https://github.com/deepseek-ai/DreamCraft3D
- **类型**：3D 生成工具
- **会议**：ICLR 2024
- **核心特性**：分层 3D 生成 + 自举扩散先验

### 11. DeepSeek-Math-V2
- **地址**：https://github.com/deepseek-ai/DeepSeek-Math-V2
- **类型**：数学推理模型
- **描述**：数学领域专用模型

---

## 五、生态系统与集成

### 12. awesome-deepseek-integration
- **地址**：https://github.com/deepseek-ai/awesome-deepseek-integration
- **类型**：集成资源汇总
- **内容**：
  - **应用**：Chatbox, Cherry Studio, DeepChat, LibreChat 等 50+ 应用
  - **AI Agent 框架**：smolagents, Dify, Upsonic, AgenticFlow 等
  - **RAG 框架**：FastGPT, MaxKB, Casibase 等
  - **IDE 插件**：VS Code, JetBrains, Neovim, Emacs 扩展
  - **浏览器扩展**：Chrome, Edge 扩展
  - **IM 插件**：微信、钉钉、飞书机器人
  - **API 客户端**：PHP, Go, Swift, .NET, Laravel

---

## 六、推理部署支持

### 官方推荐框架
| 框架 | FP8 | BF16 | 多节点 | 特性 |
|------|-----|------|--------|------|
| DeepSeek-Infer Demo | ✅ | ✅ | ✅ | 官方轻量级推理 |
| SGLang | ✅ | ✅ | ✅ | MLA 优化, DP Attention |
| vLLM | ✅ | ✅ | ✅ | Pipeline 并行 |
| LMDeploy | ✅ | ✅ | ✅ | 本地/云端部署 |
| TensorRT-LLM | ❌ | ✅ | ✅ | INT4/INT8 量化 |
| LightLLM | ✅ | ✅ | ✅ | 混合精度部署 |

### 硬件支持
- **NVIDIA GPU**：A100, H800, H100
- **AMD GPU**：通过 SGLang 支持 FP8/BF16
- **华为昇腾 NPU**：INT8 和 BF16

---

## 七、API 与平台

- **在线对话**：https://chat.deepseek.com
- **API 平台**：https://platform.deepseek.com
- **API 兼容**：OpenAI-Compatible API
- **联系方式**：service@deepseek.com

---

## 八、许可证概览

| 类型 | 许可证 | 商业用途 |
|------|--------|----------|
| 代码仓库 | MIT License | ✅ |
| 模型权重 | Model License | ✅ |
| 蒸馏模型 | 继承基座许可证 | ✅ |

---

## 九、引用

```bibtex
@misc{deepseekai2024deepseekv3technicalreport,
      title={DeepSeek-V3 Technical Report}, 
      author={DeepSeek-AI},
      year={2024},
      eprint={2412.19437},
      archivePrefix={arXiv},
}

@misc{deepseekai2025deepseekr1incentivizingreasoningcapability,
      title={DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning}, 
      author={DeepSeek-AI},
      year={2025},
      eprint={2501.12948},
      archivePrefix={arXiv},
}

@misc{deepep2025,
      title={DeepEP: an efficient expert-parallel communication library},
      author={Chenggang Zhao et al.},
      year={2025},
      publisher = {GitHub},
      howpublished = {\url{https://github.com/deepseek-ai/DeepEP}},
}
```

---

## 十、快速导航

### 按用途分类
- **通用对话**：DeepSeek-V3, DeepSeek-LLM
- **推理任务**：DeepSeek-R1
- **代码生成**：DeepSeek-Coder
- **视觉理解**：DeepSeek-VL, DeepSeek-OCR
- **数学推理**：DeepSeek-Math-V2
- **分布式训练**：DeepEP, 3FS
- **生态集成**：awesome-deepseek-integration

### 按资源需求分类
| 模型 | 最小显存需求 | 推荐配置 |
|------|-------------|----------|
| R1-Distill-Qwen-1.5B | ~4GB | 单卡消费级 GPU |
| R1-Distill-Qwen-7B | ~16GB | 单卡 A10/3090 |
| R1-Distill-Qwen-32B | ~64GB | 2x A100 40GB |
| DeepSeek-V3/R1 (671B) | ~1.3TB | 16x H800 80GB |
