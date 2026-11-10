# mz_writer 多 Agent 协作写作团队 — 设计方案

> 状态：**已确认并实施（v0.1）**
> 目标宿主：Pi 1.5.x（当前环境 1.5.0）
> 形态：Pi 扩展（Extension）+ 项目内写作工作区
> 默认语言：中文

---

## 1. 需求理解

### 1.1 目标

在当前项目中实现一个 Pi 写作插件，用多个职责明确的 Agent 组成一个“写作团队”，完成一部长篇作品从构思到交付的全过程：

1. 需求访谈与创意设计；
2. 世界观 / 人物设定（可选）；
3. 全书大纲生成与**人工确认**；
4. 逐章规划、写作、连续性审校、文字编辑；
5. 每章**人工确认**；
6. 全书终审与**人工确认**；
7. 导出成稿，并维护可追溯的版本和连续性资料。

### 1.2 核心约束

| 约束 | 解释 |
|---|---|
| **严格线性** | 任意时刻最多只有一个角色 Agent 在运行。禁止 `Promise.all` 并行跑角色，禁止角色互相调用。 |
| **人工闸门** | 设计、大纲、章节、终审都必须停下来由用户确认；未确认不得进入下一阶段。 |
| **工件可追溯** | 每一次角色运行都保留输入、输出、模型、时间、用量、修改意见，可回滚。 |
| **可恢复** | 关闭 Pi、重启、崩溃后能从 `book.json` 恢复阶段，不丢已完成内容。 |
| **可配置** | 每个角色可以单独指定模型、思考等级；可选角色可开关。 |
| **角色隔离** | 每个角色拥有独立会话、独立系统提示、独立工具白名单，避免上下文串味。 |
| **文件即事实** | 磁盘上的 Markdown / JSON 工件是唯一事实来源，会话历史只用于交互。 |

### 1.3 非目标（本期不做）

- 不做多用户实时协作、Web UI；
- 不做多个 Agent 同时运行或“圆桌会议”式并行讨论；
- 不做封面图、插图生成；
- 不做 DOCX / EPUB / PDF 排版（先导出 Markdown，后续可扩展）；
- 不做联网资料检索和自动事实核查；
- 不做自动发布到小说平台。

### 1.4 关键设计判断

用户要的是“多 Agent 团队”，而不是“一个 Agent 换几套提示词”。因此方案采用：

> **主会话作为制作人 / 调度器，每个角色在独立的嵌套 Pi 会话中运行，一次只跑一个，工件落盘，闸门由用户拍板。**

---

## 2. 总体架构

### 2.1 架构图

```text
┌─────────────────────────────────────────────────────────────┐
│                     Pi 主会话（制作人）                      │
│  /book 命令 · writing_team 工具 · 状态栏 · 闸门 UI           │
│  职责：状态机、顺序调度、人工确认、文件持久化、错误恢复       │
└───────────────────────────┬─────────────────────────────────┘
                            │ 串行 await，一次只启动一个
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              角色运行器 Role Runner（扩展内部）              │
│  createAgentSession() 创建独立嵌套会话                       │
│  独立 system prompt / model / tools / 内存 session           │
│  只读工具 + 受控 save_artifact 工具                          │
└───────────────────────────┬─────────────────────────────────┘
                            │ 写入
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                书籍工作区 books/<slug>/                       │
│  book.json  状态机 · 配置 · 运行记录                          │
│  design.md  bible.md  outline.md  style-guide.md             │
│  chapters/chNNN/*.md                                        │
│  continuity/*.md   reviews/*.md   exports/*.md               │
│  .runs/<runId>/prompt.md output.md meta.json                │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 为什么选择“嵌套独立会话”，而不是其他方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. 单会话，多套角色提示词 | 实现最简单，上下文共享 | 角色上下文串味；很难真正限制每个角色的工具；长文容易污染主会话 | 不采用 |
| B. 每个角色启动 `pi` 子进程 | 完全隔离，进程级线性 | 需要定位 CLI、传递配置、解析输出；与主 TUI 集成较弱；启动开销大 | 备选 |
| C. 扩展内用 SDK 创建嵌套 AgentSession | 真正独立上下文；可单独选模型；可流式订阅；`await` 天然串行；无需子进程 | 需要小心避免扩展递归加载；嵌套会话无交互 UI | **采用** |
| D. 并行多 Agent | 速度快 | 违反“不要同时运行”；状态冲突；成本不可控 | 明确禁止 |

### 2.3 嵌套会话的实现要点

角色运行器使用 Pi 暴露的 SDK：

```ts
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
```

每次运行角色时：

1. 创建独立的 `DefaultResourceLoader`，设置：
   - `noExtensions: true`（防止再次加载本扩展造成递归）；
   - `noSkills: true`、`noPromptTemplates: true`、`noThemes: true`、`noContextFiles: true`；
   - `systemPrompt` = 角色系统提示 + 全局写作宪法；
   - `appendSystemPrompt: []`。
2. 使用 `SessionManager.inMemory(bookRoot)`，不污染用户的会话列表。
3. 使用 `SettingsManager.inMemory(...)`，关闭嵌套会话的自动压缩，保留有限重试。
4. 通过 `tools: ["read", "grep", "find", "ls"]` 给角色只读能力。
5. 通过 `customTools: [saveArtifactTool]` 给角色唯一的写入能力；写入路径由运行器锁定，模型不能任意选择路径。
6. `await session.prompt(taskPrompt)` 完成后再进入下一角色。
7. 在 `finally` 中 `session.dispose()`，确保异常、取消、超时都不会遗留会话。

> 关键：角色 Agent 没有 `bash`、`edit`、`write`，因此无法启动第二个 Pi、无法并行、无法改坏其他文件。

---

## 3. 角色设计

### 3.1 角色总表

| # | Role ID | 中文名 | 职责 | 主要输入 | 主要输出 | 默认闸门 |
|---|---|---|---|---|---|---|
| 0 | `producer` | 制作人 | 需求访谈、状态管理、闸门、导出；由扩展实现，不调用模型 | 用户输入 | `book.json` | — |
| 1 | `architect` | 故事架构师 | 题材、卖点、主题、结构、人物弧、风格、红线 | 需求卡 | `design.md`、`style-guide.md` | **G1 设计确认** |
| 2 | `worldbuilder` | 世界观设定师（可选） | 世界规则、势力、地点、术语、年表 | `design.md` | `bible.md` | 可选，默认自动判定 |
| 3 | `outliner` | 大纲师 | 分卷 / 分章大纲、每章目标、冲突、转折、钩子、字数 | design / bible | `outline.md`、`outline.json` | **G2 大纲确认** |
| 4 | `chapter_planner` | 章节规划师 | 场景节拍、POV、时间地点、连续性引用 | 大纲当前章、bible、前章摘要 | `chapters/chNNN/plan.md` | — |
| 5 | `writer` | 执笔作者 | 写章节初稿 | plan、outline、bible、style、前章摘要 | `chapters/chNNN/draft.md` | — |
| 6 | `continuity_editor` | 连续性编辑 | 事实、时间线、人物状态、伏笔、设定冲突检查 | draft + 全部 canon | `chapters/chNNN/continuity.md` | — |
| 7 | `reviser` | 修订作者 | 按连续性意见和编辑意见改写 | draft + continuity | `chapters/chNNN/revised.md` | — |
| 8 | `line_editor` | 文字编辑 | 语言、节奏、对白、去 AI 味、统一文风 | revised / draft + style | `chapters/chNNN/final.md` | — |
| 9 | `beta_reader` | 读者代表（可选） | 以目标读者视角给出体验报告 | final | `chapters/chNNN/reader-report.md` | — |
| 10 | `archivist` | 档案管理员 | 更新人物、时间线、伏笔、章节摘要 | 已确认 final | `continuity/*.md` | — |
| 11 | `chief_editor` | 主编 | 全书结构、节奏、人物弧、质量结论 | 全书 + 报告 | `reviews/final-review.md` | **G4 终审确认** |

### 3.2 每个角色的独立配置

每个角色拥有：

- 独立 system prompt（放在扩展的 `prompts/` 目录，便于修改）；
- 独立的模型 / thinking level 配置（默认继承主会话）；
- 独立工具白名单（默认只有只读 + `save_artifact`）；
- 独立输入清单和输出契约；
- 独立的成功校验规则。

### 3.3 全局“写作宪法”

所有角色共享一段基础约束，避免不同角色互相矛盾：

1. 严格服从已确认的 `design.md`、`outline.md`、`bible.md` 和 `continuity/`；发现冲突时在输出中明确标注，不得擅自改设定。
2. 不得输出“好的，以下是……”之类的前言；最终回复只写简短摘要。
3. 不得在回复中重复全文；正文必须通过 `save_artifact` 写入指定文件。
4. 不得询问用户；需要用户决策时，在工件末尾写 `## 待确认` 列表，由制作人在闸门中处理。
5. 不得引用未提供的资料，不得编造与 canon 冲突的事实。
6. 遵守 `style-guide.md` 的视角、时态、人称、语言风格和敏感内容红线。
7. 角色之间不能直接对话，所有协作通过磁盘工件完成。

---

## 4. 流水线与人工闸门

### 4.1 主流程

```text
/book init
   │
   ▼
[需求访谈] ──► architect ──► design.md
                              │
                              ▼
                         G1 设计确认
                         ├─ 修改 → 带反馈重跑 architect
                         └─ 通过
                              │
                              ▼
                 [worldbuilder?] ──► bible.md（可选）
                              │
                              ▼
                         outliner ──► outline.md + outline.json
                              │
                              ▼
                         G2 大纲确认
                         ├─ 修改 → 带反馈重跑 outliner
                         ├─ 调整章数 → 重跑 outliner
                         └─ 通过
                              │
                              ▼
        ┌──────────── 对每一章循环 ────────────┐
        │  chapter_planner → plan.md            │
        │  writer → draft.md                    │
        │  continuity_editor → continuity.md    │
        │  [有问题] reviser → revised.md        │
        │  line_editor → final.md               │
        │  [可选] beta_reader → reader-report   │
        │  G3 章节确认                          │
        │  ├─ 修改 → reviser / line_editor      │
        │  ├─ 重写 → chapter_planner / writer   │
        │  └─ 通过                              │
        │  archivist → continuity/*             │
        └───────────────────────────────────────┘
                              │
                              ▼
                    chief_editor → final-review.md
                              │
                              ▼
                         G4 终审确认
                         ├─ 修改 → 指定章节返工
                         ├─ 接受问题 → 带问题交付
                         └─ 通过
                              │
                              ▼
                         export → 成稿
                              │
                              ▼
                            done
```

### 4.2 闸门行为

所有闸门统一提供以下选项：

| 选项 | 行为 |
|---|---|
| **通过** | 记录确认人（当前用户）、时间、工件版本，进入下一阶段 |
| **提出修改** | 打开多行编辑器收集意见；带反馈重跑当前阶段的产出角色，生成新版本；再次回到闸门 |
| **查看全文** | 在滚动浮层或编辑器中查看工件；不改变状态 |
| **暂停** | 状态置为 `paused`，保留当前工件和阶段；之后 `/book resume` |
| **放弃** | 二次确认后终止当前书籍项目，不删除文件 |

补充规则：

- 修改轮次默认上限 3 轮；超过后提示用户“继续修改 / 接受当前版本 / 暂停”。
- G2 大纲确认额外提供“调整章数 / 调整分卷 / 重排节奏”，收集结构化要求后重跑大纲。
- G3 章节确认额外提供“局部重写”（指定段落）和“整章重写”。
- G4 终审确认必须显式选择“确认交付”，不能只按回车；若主编结论为 `REVISE`，默认不允许直接通过，除非用户选择“带问题交付”。
- 任何闸门未确认时，状态机拒绝进入下一阶段。

### 4.3 自动 / 手动模式

- `autoRunChapterPipeline: true`（默认）：大纲确认后，章节内部 `planner → writer → continuity → reviser → line_editor` 自动串行跑完，停在 G3。
- `autoRunChapterPipeline: false`：每一步都由 `/book step` 或 `/book run <role>` 手动触发。
- 无论哪种模式，角色都严格串行，闸门都必须人工确认。

---

## 5. 状态机设计

### 5.1 阶段枚举

```ts
type Phase =
  | "idle"          // 未创建项目
  | "intake"        // 需求访谈
  | "design"        // 故事架构师运行中
  | "design_gate"   // G1
  | "bible"         // 世界观运行中
  | "outline"       // 大纲师运行中
  | "outline_gate"  // G2
  | "chapter_plan"  // 章节规划中
  | "draft"         // 初稿中
  | "continuity"    // 连续性审校中
  | "revision"      // 修订中
  | "line_edit"     // 文字编辑中
  | "reader"        // 读者代表运行中（可选）
  | "chapter_gate"  // G3
  | "archive"       // 档案更新中
  | "final_review"  // 主编终审中
  | "final_gate"    // G4
  | "export"        // 导出中
  | "done"          // 已交付
  | "paused"        // 用户暂停
  | "error";        // 最近一次运行失败
```

### 5.2 合法迁移

| 当前阶段 | 允许进入 |
|---|---|
| `idle` | `intake` |
| `intake` | `design` |
| `design` | `design_gate` / `error` |
| `design_gate` | `design`（修改）/ `bible` / `outline`（跳过世界观）/ `paused` |
| `bible` | `outline` / `error` |
| `outline` | `outline_gate` / `error` |
| `outline_gate` | `outline`（修改）/ `chapter_plan` / `paused` |
| `chapter_plan` | `draft` / `error` |
| `draft` | `continuity` / `error` |
| `continuity` | `revision`（有阻断问题）/ `line_edit` / `error` |
| `revision` | `line_edit` / `error` |
| `line_edit` | `reader`（启用）/ `chapter_gate` / `error` |
| `reader` | `chapter_gate` / `error` |
| `chapter_gate` | `revision`（局部修改）/ `chapter_plan`（整章重写）/ `archive`（通过）/ `paused` |
| `archive` | `chapter_plan`（下一章）/ `final_review`（全书完成）/ `error` |
| `final_review` | `final_gate` / `error` |
| `final_gate` | `chapter_plan`（指定章节返工）/ `export`（通过或带问题交付）/ `paused` |
| `export` | `done` / `error` |
| `paused` | 暂停前的阶段 |
| `error` | 失败前的阶段（重试）或 `paused` |

实现上用显式 `ALLOWED_TRANSITIONS` 表校验，任何不在表中的迁移直接拒绝并提示当前阶段。

### 5.3 线性保证

线性不是靠提示词，而是靠代码结构：

1. **单飞锁**：`runExclusive()` 维护 `activeRun`；已存在时直接抛错“已有角色在运行，请等待完成”。
2. **串行 await**：流水线只使用 `for...of` / `await`，代码中禁止 `Promise.all` 跑角色。
3. **工具顺序执行**：`writing_team` 工具设置 `executionMode: "sequential"`。
4. **角色无并行能力**：角色会话没有 `bash`，不能启动新的 Pi 进程；没有 `edit`/`write`，不能改其他文件。
5. **跨进程锁**：`books/<slug>/.lock` 记录 PID 和 session id；第二个 Pi 进程操作同一本书时拒绝运行，避免两个终端同时写。
6. **主会话忙碌**：角色在工具执行期间，主 Pi 正在处理该工具，用户的新输入只会按 Pi 的 steering/follow-up 规则排队，不会启动第二个角色。
7. **测试断言**：运行器维护 `activeCount`，测试中断言任意时刻 `activeCount <= 1`。

### 5.4 失败、取消与恢复

| 情况 | 处理 |
|---|---|
| 角色运行失败（API 错误、超时） | 不推进阶段；`book.json` 记录 `lastError`；状态保持原阶段；通知用户重试 |
| 用户按 Esc / 取消 | 通过 `ctx.signal` 中止嵌套会话；`session.dispose()`；运行记录标记 `aborted` |
| 输出为空或工件未写入 | 先在同一会话内追加一次“请补全并保存”的指令；仍失败则标记失败，不推进 |
| 输出不满足校验 | 例如大纲 JSON 缺字段、章节字数过短；在同一会话内重试一次，仍失败则回到闸门让用户决定 |
| Pi 退出 / 崩溃 | 重启后从 `book.json` 恢复；未完成的 run 标记为 `interrupted`；阶段不自动前进 |
| 磁盘写入失败 | 原子写入失败则保留旧文件；向用户报错；不更新状态 |

---

## 6. 数据与文件布局

### 6.1 扩展位置

```text
<project>/.pi/extensions/writing-team/
├── index.ts                 # 扩展入口：注册命令、工具、事件
├── types.ts                 # 状态、角色、运行记录类型
├── config.ts                # 全局/项目/书籍配置合并
├── state.ts                 # 状态机、迁移校验、原子持久化、锁
├── roles.ts                 # 角色元数据与加载
├── prompts/
│   ├── _common.md           # 全局写作宪法
│   ├── architect.md
│   ├── worldbuilder.md
│   ├── outliner.md
│   ├── chapter_planner.md
│   ├── writer.md
│   ├── continuity_editor.md
│   ├── reviser.md
│   ├── line_editor.md
│   ├── beta_reader.md
│   ├── chief_editor.md
│   └── archivist.md
├── prompts.ts               # 组装角色 system prompt / task prompt
├── runner.ts                # 嵌套 SDK 会话、流式事件、abort、用量统计
├── artifacts.ts             # save_artifact 工具、路径校验、快照
├── pipeline.ts              # 顺序流水线
├── gates.ts                 # 四类闸门 UI 与决策
├── ui.ts                    # 状态栏、进度 widget、通知、查看全文
├── commands.ts              # /book 命令
├── tools.ts                 # writing_team 工具
├── export.ts                # 合并导出
├── doctor.ts                # 状态/文件一致性检查
├── README.md
└── tests/
    ├── state.test.ts
    ├── transitions.test.ts
    ├── prompts.test.ts
    ├── artifacts.test.ts
    └── pipeline.fake.test.ts
```

### 6.2 书籍工作区

```text
<workspace>/books/<slug>/
├── book.json                     # 状态机、配置、运行索引、统计
├── .lock                         # 跨进程单飞锁
├── design.md                     # G1 设计稿
├── style-guide.md                # 文风、视角、语言规范
├── bible.md                      # 世界观 / 人物 / 设定（可选）
├── outline.md                    # 人类可读大纲
├── outline.json                  # 结构化章节清单（供状态机使用）
├── chapters/
│   └── ch001/
│       ├── plan.md
│       ├── draft.md
│       ├── continuity.md
│       ├── revised.md
│       ├── final.md
│       └── reader-report.md      # 可选
├── continuity/
│   ├── characters.md             # 人物状态、关系、已知信息
│   ├── timeline.md               # 时间线
│   ├── threads.md                # 伏笔与未回收线索
│   ├── world.md                  # 已确认的世界规则
│   └── summaries.md              # 已确认章节摘要
├── reviews/
│   └── final-review.md
├── exports/
│   └── <slug>-<timestamp>.md
└── .runs/
    └── <runId>/
        ├── prompt.md             # 实际发送的角色任务提示
        ├── output.md             # 最终工件快照
        ├── meta.json             # 模型、耗时、用量、状态、错误
        └── events.jsonl          # 可选：流式事件记录（用于调试）
```

约定：

- 章节编号固定三位：`ch001`、`ch002`。
- 所有路径都相对于书籍根目录，禁止 `..` 穿越。
- 每次运行先写 `.runs/<runId>/`，成功后再更新正式工件；正式工件使用临时文件 + `rename` 原子替换。
- `.runs` 是历史版本来源；闸门“查看历史”只读这里。

### 6.3 `book.json` 结构

```ts
interface BookProject {
  schemaVersion: 1;
  slug: string;
  title: string;
  language: string;
  createdAt: string;
  updatedAt: string;

  phase: Phase;
  previousPhase?: Phase;          // paused / error 恢复用
  currentChapter: number;         // 从 1 开始
  chapterCount: number;

  intake: {
    genre: string;
    audience: string;
    premise: string;
    themes: string[];
    tone: string;
    pov: string;
    targetWords: number;
    chapterWords: number;
    references: string[];
    redLines: string[];
    notes: string;
  };

  config: TeamConfig;
  gates: {
    design: GateRecord;
    outline: GateRecord;
    chapters: Record<string, GateRecord>;  // "ch001"
    final: GateRecord;
  };

  stats: {
    words: number;
    chaptersCompleted: number;
    totalUsage: { input: number; output: number; cost?: number };
  };

  runs: RunRecord[];
  lastError?: { runId: string; message: string; at: string };
}

interface GateRecord {
  status: "pending" | "approved" | "rejected";
  decidedAt?: string;
  feedback?: string;
  artifactVersion?: string;   // 对应 runId
}

interface RunRecord {
  id: string;
  role: RoleId;
  phase: Phase;
  chapter?: number;
  status: "running" | "success" | "error" | "aborted" | "interrupted";
  startedAt: string;
  endedAt?: string;
  model?: string;
  thinkingLevel?: string;
  inputFiles: string[];
  outputFiles: string[];
  revisionOf?: string;
  feedback?: string;
  usage?: { input: number; output: number; cost?: number };
  error?: string;
  validation?: { ok: boolean; issues: string[] };
}
```

### 6.4 结构化大纲

`outline.json` 示例：

```json
{
  "chapterCount": 12,
  "acts": [
    { "name": "第一幕", "chapters": [1, 2, 3, 4] }
  ],
  "chapters": [
    {
      "n": 1,
      "title": "雨夜的来客",
      "goal": "主角被迫离开故乡",
      "conflict": "追兵与旧友的忠诚冲突",
      "turn": "主角发现父亲留下的信",
      "hook": "信上出现了本该死者的名字",
      "pov": "林砚",
      "targetWords": 3200
    }
  ]
}
```

状态机只依赖 `outline.json` 推进章节；`outline.md` 供人阅读。两者必须同时保存，否则大纲闸门不通过。

---

## 7. 角色运行器设计

### 7.1 输入组装

每次运行角色时，任务提示由五部分组成：

1. **角色系统提示**：`prompts/_common.md` + `prompts/<role>.md`；
2. **项目事实卡**：书名、题材、受众、主题、POV、字数目标、红线；
3. **必读文件清单**：绝对/相对路径 + 阅读目的，由角色自己用 `read` 读取，避免一次性塞满上下文；
4. **本次任务**：要产出什么、写到哪个文件、验收标准；
5. **修订反馈**（如果有）：上一版问题、用户意见、需要保留的内容。

示例（大纲师）：

```text
你是本项目的「大纲师」。

## 项目事实
- 书名：《长夜将明》
- 题材：东方奇幻 / 悬疑
- 目标读者：18–35 岁，偏好强情节与人物成长
- 总字数目标：80,000 字，单章 3,000–3,500 字
- 叙事视角：第三人称限知，双主角交替

## 必读文件
- books/chang-ye/design.md（创意设计，已确认）
- books/chang-ye/style-guide.md（文风与红线）

## 本次任务
产出 12 章大纲，写入 outline.md 和 outline.json。
- 采用三幕结构；
- 每章必须有目标、冲突、转折、结尾钩子；
- 第 6 章与第 11 章各安排一次重大反转；
- outline.json 必须符合给定 schema。

## 输出要求
通过 save_artifact 保存两个文件，不要在回复中粘贴全文。
最终回复只写不超过 150 字的摘要。
```

### 7.2 输出契约与校验

| 角色 | 必写文件 | 校验规则 |
|---|---|---|
| `architect` | `design.md`、`style-guide.md` | 非空；包含主题、人物弧、结构、视角、文风、红线；≥ 800 字 |
| `worldbuilder` | `bible.md` | 非空；包含世界规则、势力、地点、术语；与 design 不冲突 |
| `outliner` | `outline.md`、`outline.json` | JSON 可解析；章节数 > 0；每章字段完整；与目标章数一致 |
| `chapter_planner` | `chapters/chNNN/plan.md` | 包含场景列表、每场目标/冲突/结果、POV、时间地点、连续性引用 |
| `writer` | `chapters/chNNN/draft.md` | 字数 ≥ 目标字数的 70%；包含章节标题；无“待补”占位符 |
| `continuity_editor` | `chapters/chNNN/continuity.md` | 包含问题列表，每条有严重级别（blocker/major/minor）和原文引用 |
| `reviser` | `chapters/chNNN/revised.md` | 字数不小于初稿的 85%；blocker 问题必须有处理说明 |
| `line_editor` | `chapters/chNNN/final.md` | 字数达标；无敏感红线；文风符合 style-guide |
| `beta_reader` | `chapters/chNNN/reader-report.md` | 包含投入度、困惑点、预测、弃读点 |
| `archivist` | `continuity/*.md` | 至少更新 `characters.md`、`timeline.md`、`summaries.md`；不得删旧事实 |
| `chief_editor` | `reviews/final-review.md` | 开头必须有 `VERDICT: PASS` 或 `VERDICT: REVISE`；附问题清单 |

校验失败时：

1. 在同一角色会话中追加一次修复指令（仍是串行）；
2. 修复后仍失败 → 记录 `validation.issues`，停在当前阶段；
3. 闸门提示“产出未通过校验”，让用户选择重试、手动编辑或放弃。

### 7.3 `save_artifact` 工具

角色唯一的写入通道：

```ts
save_artifact({
  target: string,       // 必须在本次角色的允许输出列表内
  content: string,
  mode?: "replace" | "append",
})
```

行为：

- 校验 `target` 在允许列表内；
- 解析后的绝对路径必须位于书籍根目录内；
- `content` 不能为空；
- 先写入 `.runs/<runId>/<target>`，再原子替换正式文件；
- 返回 `{ path, chars, sha256 }`；
- 拒绝写入 `book.json`、`.lock`、其他角色文件。

### 7.4 流式反馈与用量

运行器订阅嵌套会话事件：

- `message_update` 的 `text_delta` → 更新状态栏“当前角色 · 已生成 N 字”；
- `tool_execution_start` → 显示角色正在读哪个文件；
- `message_end` → 累计 usage；
- `agent_settled` → 标记运行结束。

主会话只显示摘要和进度，不把角色全文灌入主会话上下文，避免主会话膨胀。

---

## 8. 扩展与主会话交互

### 8.1 命令

主命令：`/book`

| 命令 | 作用 |
|---|---|
| `/book init [书名]` | 创建书籍项目，进入需求访谈 |
| `/book status` | 显示阶段、进度、字数、当前角色、最近运行 |
| `/book next` | 运行下一阶段（若当前在闸门则提醒先确认） |
| `/book step` | 手动模式：只运行下一个角色 |
| `/book run <role>` | 手动运行指定角色（需满足前置条件） |
| `/book approve [备注]` | 通过当前闸门 |
| `/book revise <意见>` | 对当前闸门产物提出修改，带反馈重跑 |
| `/book chapter <n>` | 切换当前章节（仅允许已确认章节或下一章） |
| `/book rewind <phase>` | 回滚到指定阶段；二次确认；后续章节标记 stale |
| `/book models` | 为角色选择模型 / thinking level |
| `/book config` | 查看 / 修改团队配置 |
| `/book pause` / `/book resume` | 暂停 / 恢复 |
| `/book abort` | 中止当前角色运行（也可用 Esc） |
| `/book export [md\|txt]` | 导出成稿 |
| `/book doctor` | 检查状态、文件缺失、锁、未完成运行 |
| `/book help` | 命令与角色说明 |

命令参数支持补全：子命令、角色 ID、章节号。

### 8.2 `writing_team` 工具

让主 Agent 可以通过自然语言驱动团队：

```ts
writing_team({
  action: "init" | "status" | "run_next" | "run_role" | "approve" |
          "revise" | "abort" | "export" | "set_chapter" | "configure",
  title?: string,
  role?: RoleId,
  chapter?: number,
  feedback?: string,
  model?: string,
})
```

工具返回：

- `content`：给主 Agent 的简短结果；
- `details`：结构化状态快照（阶段、章节、字数、产物路径、闸门状态），供 UI 渲染和主 Agent 继续决策。

工具描述中明确写：

> 只有在用户明确要求推进写作流程时才调用；一次调用只推进一个阶段或一个角色；不要并行调用；闸门必须等待用户选择。

### 8.3 状态栏与进度 Widget

Footer 状态：

```text
📖 长夜将明 · 第 2/12 章 · 42,180 字 · 执笔作者运行中 00:12
```

Widget（编辑器上方）：

```text
✔ 设计   ✔ 大纲   ✔ 第1章   ▶ 第2章   ○ 终审
[████████░░░░░░░░] 2/12  当前：执笔作者
最近产物：chapters/ch002/draft.md
```

运行中显示：

```text
执笔作者 · 已生成 1,842 字 · 读取 continuity/characters.md
```

### 8.4 主会话的角色

主会话只做“制作人”：

- 不直接写正文；
- 不把角色全文放进上下文；
- 负责调用工具、展示状态、弹闸门、处理错误；
- 在项目激活时，通过稳定的系统提示补充一段“当前是写作团队模式”的说明（避免每个阶段改系统提示造成缓存失效）；
- 阶段信息通过工具结果和自定义消息注入，而不是频繁改 system prompt。

---

## 9. 配置设计

### 9.1 配置层级

优先级从低到高：

1. 扩展内置默认值；
2. `~/.pi/agent/writing-team.json`（全局）；
3. `<cwd>/.pi/writing-team.json`（项目）；
4. `books/<slug>/book.json` 中的 `config`（单本书覆盖）。

### 9.2 配置示例

```json
{
  "language": "zh-CN",
  "storageRoot": "books",
  "defaults": {
    "thinkingLevel": "high",
    "maxRevisionRounds": 3,
    "autoRunChapterPipeline": true,
    "chapterGate": "each",
    "enableWorldbuilder": "auto",
    "enableBetaReader": false,
    "chapterWords": 3200,
    "totalWords": 80000
  },
  "roles": {
    "architect": { "model": "provider/model-a", "thinkingLevel": "high" },
    "outliner": { "model": "provider/model-a", "thinkingLevel": "high" },
    "writer": { "model": "provider/model-b", "thinkingLevel": "medium" },
    "continuity_editor": { "model": "provider/model-a", "thinkingLevel": "high" },
    "line_editor": { "model": "provider/model-b", "thinkingLevel": "medium" },
    "chief_editor": { "model": "provider/model-a", "thinkingLevel": "high" }
  }
}
```

### 9.3 模型解析

- `provider/modelId` 精确匹配；
- 未配置则继承主会话当前模型；
- 配置的模型不存在或未授权 → 通知并回退主会话模型，记录到 run 元数据；
- `/book models` 从 `ctx.scopedModels` / `ctx.modelRegistry` 中选择，避免用户手写错 ID。

---

## 10. 错误处理与恢复

| 场景 | 行为 |
|---|---|
| 角色运行中用户 Esc | 中止嵌套会话；状态回退到运行前；run 标记 aborted；正式工件不变 |
| API 限流 / 超时 | 嵌套会话内部有限重试；仍失败则停在当前阶段，显示错误和“重试”入口 |
| 输出校验失败 | 同会话修复一次；仍失败停在闸门，提供“重试 / 手动编辑 / 放弃” |
| 文件被外部修改 | `/book doctor` 检测 hash 不一致；提醒用户；不自动覆盖 |
| `book.json` 损坏 | 从 `.runs` 和备份恢复；无法恢复时拒绝继续，避免写坏 |
| 两次 Pi 同时操作 | `.lock` 拒绝第二个进程；提示“另一个会话正在运行” |
| 磁盘空间不足 | 写入失败，保留旧文件，状态不推进 |
| 嵌套会话创建失败 | 回退为“仅生成提示，不自动运行”；用户可复制提示到新会话手动运行（降级模式） |

---

## 11. 测试与验收

### 11.1 单元测试

- 状态迁移表：合法迁移通过，非法迁移拒绝；
- 单飞锁：并发调用 `runExclusive` 只有一个成功；
- 配置合并：全局 / 项目 / 书籍覆盖顺序；
- 路径校验：`../`、绝对路径、符号链接逃逸全部拒绝；
- 大纲 JSON 校验：缺字段、章数不符、非法章节号；
- 提示组装：角色、必读文件、修订反馈正确拼接；
- 导出：章节顺序、标题、字数统计。

### 11.2 集成测试（不调用真实模型）

用一个 `FakeRoleRunner` 替换嵌套会话，按角色返回固定内容：

- 走完 `init → design → G1 → outline → G2 → 2 章 → G4 → export`；
- 在每个闸门模拟“修改 / 通过”；
- 校验每次运行都产生 `.runs` 快照；
- 校验任意时刻最多一个角色运行；
- 模拟运行失败、重启恢复、锁冲突。

### 11.3 真机冒烟测试

用一本 2 章、约 6,000 字的短篇走完整流程：

1. `/book init 测试短篇`；
2. 完成需求访谈；
3. G1 提出一次修改，再通过；
4. G2 通过；
5. 第 1 章内部自动串行跑完，G3 修改一次，再通过；
6. 第 2 章通过；
7. G4 通过；
8. `/book export`；
9. 检查 `exports/*.md` 可读、章节完整、连续性文件已更新。

### 11.4 验收标准

- [ ] 全流程可在一本 2 章短篇上跑通；
- [ ] 四个闸门都必须人工确认，无法绕过；
- [ ] 任意时刻只有一个角色会话（日志和测试双重验证）；
- [ ] 每次运行都有 `.runs` 记录，可查看输入、输出、模型、用量；
- [ ] 重启 Pi 后 `/book status` 能恢复阶段和进度；
- [ ] 中途失败不会推进阶段，也不会破坏已有工件；
- [ ] 每个角色可单独配置模型，缺失时安全回退；
- [ ] 角色不能写允许列表之外的文件，不能执行 `bash`；
- [ ] `/book doctor` 能发现缺失文件和锁冲突；
- [ ] 导出文件按章节顺序合并，标题和字数正确。

---

## 12. 实施计划

| 阶段 | 内容 | 交付物 |
|---|---|---|
| M1 | 脚手架、类型、配置、状态机、原子持久化、锁 | `types.ts` / `state.ts` / `config.ts` + 单元测试 |
| M2 | 角色运行器：嵌套 SDK 会话、`save_artifact`、流式事件、abort、用量 | `runner.ts` / `artifacts.ts` + 假模型测试 |
| M3 | 角色提示词与校验：architect、outliner、chapter_planner、writer | `prompts/*` / `prompts.ts` / 校验器 |
| M4 | G1 / G2 闸门与设计、大纲流水线 | `gates.ts` / `pipeline.ts` / 命令 |
| M5 | 章节流水线：连续性、修订、文字编辑、G3、档案更新 | 完整章节循环 |
| M6 | 终审、G4、导出、`/book doctor` | `export.ts` / `doctor.ts` |
| M7 | TUI 打磨、README、端到端冒烟、边界修复 | 可交付版本 |

每个里程碑结束都可以运行测试；M4 后即可开始真实短篇验证。

---

## 13. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| 嵌套 SDK 会话与宿主版本不兼容 | 角色无法运行 | 锁定 Pi 1.5.x；运行器做启动自检；失败时降级为“生成提示词手动运行” |
| `noExtensions` 未完全隔离导致递归加载 | 扩展重复注册 / 卡死 | 使用独立 `SettingsManager` + `DefaultResourceLoader(noExtensions: true)`；启动时检测嵌套会话工具列表 |
| 单章太长，模型一次输出被截断 | 章节不完整 | `save_artifact` 支持 `append`；写作角色按场景分段写入；校验字数 |
| 上下文超限 | 角色读不到关键资料 | 任务提示只给路径和摘要，角色按需 `read`；运行器限制必读文件数量；超限时降级为摘要模式 |
| 角色输出质量不稳定 | 需要多轮修改 | 明确输出契约 + 自动校验 + 闸门人工确认 + 可配置更强模型 |
| 成本不可控 | 长书费用高 | 记录每次 usage；可选角色默认关闭；`/book status` 显示累计用量；支持角色级模型降级 |
| 状态文件损坏 | 无法继续 | 原子写 + `.runs` 快照 + `book.json` 备份 + `/book doctor` |
| 闸门 UI 在非 TUI 模式不可用 | RPC/print 无法确认 | 本期只保证 TUI；非 TUI 返回结构化错误和下一步命令，后续再补 RPC 闸门 |

---

## 14. 需要确认的决策

请重点确认以下默认值；如果都同意，回复“按推荐方案实施”即可。

| # | 决策 | 推荐默认 | 备选 |
|---|---|---|---|
| 1 | 存储位置 | `<workspace>/books/<slug>/` | 当前目录直接作为一本书 |
| 2 | 是否使用“嵌套独立 AgentSession” | 是（真正的多 Agent、独立上下文） | 单会话多提示词 |
| 3 | 章节内部是否自动串行跑完 | 是，停在 G3 | 每步手动 `/book step` |
| 4 | 每章是否都要确认 | 是（`chapterGate: "each"`） | 每卷/里程碑确认 |
| 5 | 是否默认启用世界观设定师 | `auto`：奇幻/科幻/历史自动启用，其他题材跳过 | 始终启用 / 始终关闭 |
| 6 | 是否默认启用读者代表 | 否 | 是 |
| 7 | 修订角色是否独立 | 是（`reviser` 单独角色） | 让 `writer` 直接改 |
| 8 | 角色模型 | 默认继承主会话；可在配置中逐个覆盖 | 全部强制同一模型 |
| 9 | 主 Agent 是否可自然语言驱动 | 是（`writing_team` 工具）+ 命令 | 仅命令 |
| 10 | 导出格式 | Markdown 单文件 | Markdown + 分章 + TXT |
| 11 | 修改轮次上限 | 3 轮 | 5 轮 / 不限制 |
| 12 | 语言 | 中文 | 中英双语 / 英文 |

### 14.1 我建议的首版范围

- 实现表中全部核心角色（`architect`、`outliner`、`chapter_planner`、`writer`、`continuity_editor`、`reviser`、`line_editor`、`archivist`、`chief_editor`）；
- `worldbuilder` 和 `beta_reader` 作为可配置可选角色，首版可用；
- 四个闸门全部实现；
- 命令 + `writing_team` 工具双入口；
- Markdown 导出；
- 完整单元测试、假模型流水线测试和 2 章真机冒烟。

### 14.2 确认后我会先做什么

1. 创建 `.pi/extensions/writing-team/` 骨架和类型；
2. 先实现状态机 + 假角色运行器，把全流程（含闸门）跑通；
3. 接入真实嵌套 SDK 会话；
4. 逐个补齐角色提示词和校验；
5. 用 2 章短篇做端到端验证，再交付。

---

## 15. 附：默认用户操作示例

```text
用户：/book init 长夜将明

扩展：进入需求访谈
      - 题材：东方奇幻 / 悬疑
      - 目标读者：18–35 岁
      - 核心卖点：双主角、时间循环、王朝崩塌
      - 总字数：80,000
      - 单章字数：3,200
      - 视角：第三人称限知
      - 主题：记忆与背叛
      - 红线：不写露骨暴力
      → 生成 design.md

扩展：G1 设计确认
      [通过并继续] [提出修改] [查看全文] [暂停]

用户：提出修改：主角动机再明确一些

扩展：architect 带反馈重跑 → design.md v2
      G1 再次确认

用户：通过

扩展：worldbuilder（自动，因题材为奇幻）→ bible.md
      outliner → outline.md + outline.json
      G2 大纲确认：12 章 / 约 7.8 万字

用户：第 8 章节奏太慢，提前高潮

扩展：outliner 重跑 → outline v2
      G2 再次确认

用户：通过

扩展：第 1 章
      chapter_planner → writer → continuity_editor → reviser → line_editor
      （全程串行，一次一个角色）
      G3 章节确认

用户：通过

扩展：archivist 更新 continuity/*
      第 2 章开始……
```

---

**当前状态：已按第 14 节的推荐默认值实施。实现与使用说明见 `.pi/extensions/writing-team/README.md`。**

---

## 16. v0.2 增补（已实施）

- **实时运行信息**：子 Agent 运行期间，状态栏与进度 Widget 实时显示上下文占用、当前工具操作、当前角色累计 token。
- **项目级 Token 统计**：`book.json` 的 `stats.totalUsage` 累计所有角色的 input / output / cost；状态栏、`/book status`、`writing_team` 工具结果都会显示。
- **全自动模式**：新增 `defaults.fullAuto`、`/book auto on|off`、`/book auto-run`，以及 `writing_team` 的 `set_auto` / `run_all`。全自动模式跳过人工闸门，但仍执行产出校验；校验失败会暂停，而不是强行通过。终审为 `VERDICT: REVISE` 时带问题交付并警告。
- **确认闸门不展示全文**：G1/G2/G3/G4 都不展示工件全文，只显示摘要、字数和文件路径（如 `design.md`、`outline.md`、`final.md`、`reviews/final-review.md`），由用户自行打开确认。
- **后台运行**：角色运行放在后台任务中，命令/工具立即返回；运行期间可执行 `/book status`、`/book doctor`、`/book abort` 等只读或中止命令。同一时间仍只允许一个后台任务。
