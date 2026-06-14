<div align="center">

# 🔥 NovelForge — AI 小说创作 IDE

**AI 深度驱动的小说创作集成开发环境，为网文作者而生。**

[![React](https://img.shields.io/badge/React-19-blue.svg)](https://reactjs.org/)
[![Electron](https://img.shields.io/badge/Electron-41-black.svg)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6.svg)](https://www.typescriptlang.org/)
[![Version](https://img.shields.io/badge/Version-2.1.1-green.svg)]()
[![CI](https://github.com/LunaRime/novelforge/actions/workflows/webpack.yml/badge.svg)](https://github.com/LunaRime/novelforge/actions/workflows/webpack.yml)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-yellow.svg)](https://opensource.org/licenses/GPL-3.0)

</div>

---

> **NovelForge** 是一款开源、隐私优先的 AI 写作 IDE。将大语言模型驱动的全流程工作流与本地 RAG 知识库深度融合，为作者提供 IDE 级别的沉浸式创作体验。

---

## ✨ 核心特性

### 🧬 AI 小说创作全流程

| 能力 | 说明 |
|---|---|
| 🌍 世界观与设定管理 | 全局世界观、剧情主轴、角色人设档案（跨章动态追踪） |
| 📋 自动大纲与细纲生成 | AI 生成结构骨架 → 章节细纲 → 场景/情绪/节奏要求 |
| 📐 大纲自动拆章 | AI 分析大纲自动建议章节数、分卷结构和高潮章号 |
| ✍️ 流式章节正文生成 | 单章流式打字机生成，精准响应前文上下文 |
| 🎬 章节过渡引擎 | 写稿前提取前3章场景卡片注入 prompt，确保连贯性 |
| 🔄 段落级改写 | 扩写/缩写/改风格/增强冲突/润色五种模式，非全文重写 |
| 📝 编辑部协作审阅 | 5 角色并行评审（主编/情节/文案/连续性/风格）+ 加权评分 |
| 🎤 角色声音一致性 | 定稿后分析角色对话风格，写稿时自动注入保持一致性 |
| 📊 多稿对比择优 | 同章并行生成多版本，AI 自动评分选出最佳 |
| 🔮 伏笔管理器 | 自动扫描新伏笔 + 检测回收旧伏笔，防止遗忘 |
| 🔁 后期管线 | 正文入库 → 剧情提取 → 角色更新 → 伏笔扫描 → 声音分析 → 文风学习 |

### 🧠 百万字级本地知识库 + 向量引擎

| 能力 | 说明 |
|---|---|
| 🔍 LLM+向量融合检索 | 语义搜索 + 全文检索混合，自动注入 AI prompt |
| 🧬 LLM 向量化 | 将 LLM 作为向量模型使用，无需专用 Embedding API |
| ⚙️ 向量配置管理 | 模块/模型/LLM 三开关 + 连通性测试 |
| 🔒 纯本地存储 | SQLite + LanceDB，断网可用 |

### 💰 成本优化引擎

| 能力 | 说明 |
|---|---|
| 🎯 分层模型路由 | elite/standard/budget 三层自动路由，节省 50-70% |
| ⚡ Prompt 缓存 | API 自动缓存命中，输入费用降低 50% |
| 📊 实时费用追踪 | StatusBar 实时显示会话费用 |
| 📐 Token 预算引擎 | 智能截断，系统提示词上限控制 |

---

## 🚀 安装

### 📦 预构建版本（推荐）

前往 [Releases](https://github.com/LunaRime/novelforge/releases) 下载最新安装包：
- **Windows**: `NovelForge-2.1.1-setup.exe`（NSIS 安装程序，可选安装路径）

### 🔨 源码构建

#### 环境要求

| 工具 | 版本 | 说明 |
|------|------|------|
| **Node.js** | `>= 22.x` | Electron 41 内置版本，CI 已验证 |
| **npm** | `>= 10.x` | 随 Node.js 22 附带 |
| **Python** | `>= 3.10` | 编译 `better-sqlite3` / `lancedb` 等原生模块 |
| **C++ 工具链** | — | Windows: Visual Studio Build Tools · macOS: Xcode CLT · Linux: `build-essential` |

#### 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/LunaRime/novelforge.git
cd novelforge

# 2. 安装依赖
#    Windows 设置环境变量跳过 Electron 二进制下载（节省 ~180 MB）
#    macOS / Linux 直接 npm install 即可
set ELECTRON_SKIP_BINARY_DOWNLOAD=1   # Windows CMD
# $env:ELECTRON_SKIP_BINARY_DOWNLOAD=1  # Windows PowerShell
# export ELECTRON_SKIP_BINARY_DOWNLOAD=1  # macOS / Linux

npm install

# 3. 开发模式（Vite HMR 热更新，无需完整 Electron 构建）
npm run dev

# 4. 完整构建（TypeScript 检查 → Vite 打包 → Electron Builder 安装包）
npm run build
```

#### 原生模块说明

项目依赖 `better-sqlite3` 和 `@lancedb/lancedb` 两个原生模块。如果 `npm install` 后遇到模块加载错误，请执行：

```bash
# 针对 Electron 内置 Node 版本重新编译原生模块
npm run rebuild
```

> `rebuild` 实际运行 `electron-rebuild -f -w better-sqlite3`，确保原生模块与 Electron 41 的 Node.js 版本 ABI 匹配。

---

## ⚙️ 模型配置

支持 `OpenAI` · `DeepSeek` · `Gemini` · `Claude` · `Ollama` · `智谱 GLM` · 任何 OpenAI 兼容 API。

在设置中配置 AI 生成模型 + 向量模型，开启分层路由和 Prompt 缓存以节省费用。

---

## 🏗️ 技术架构

React 19 + TypeScript + Zustand | Electron 41 + Vite 8 | Tailwind CSS + Radix UI | better-sqlite3 + LanceDB | ReAct Agent + MCP

---

## 📄 协议

基于 GPL-3.0 开源。原始项目 [Vela](https://github.com/heider-x/vela) by heider-x，由 LunaRime 持续开发维护。

---

<div align="center">
<b>NovelForge — Forge your novel with AI.</b>
</div>
