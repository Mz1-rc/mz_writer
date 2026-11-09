# Pi 多 Agent 协作写作团队

一个严格线性的长文写作扩展：主会话是制作人，角色 Agent 在独立的嵌套 Pi 会话中依次运行，所有产出落盘，设计 / 大纲 / 章节 / 终审都必须人工确认。

## 安装与加载

扩展位于：

```text
.pi/extensions/writing-team/
```

在项目内启动 Pi 时会自动发现。也可以临时加载：

```bash
pi -e ./.pi/extensions/writing-team/index.ts
```

项目本地扩展需要项目信任。修改代码后使用 `/reload` 热重载。

## 快速开始

```text
/book init 长夜将明
/book next
```

典型流程：

1. `/book init`：需求访谈，创建 `books/<slug>/`；
2. `/book next`：故事架构师产出设计，进入 G1；
3. `/book approve` / `/book revise <意见>`：确认或修改；
4. `/book next`：世界观（可选）→ 大纲，进入 G2；
5. 大纲确认后，章节内部自动串行跑规划、初稿、连续性审校、修订、文字编辑，停在 G3；
6. 每章确认后档案管理员更新连续性档案；
7. 全书完成后主编终审，进入 G4；
8. 确认后导出 Markdown 到 `exports/latest.md`。

## 命令

| 命令 | 作用 |
|---|---|
| `/book init [书名]` | 创建书籍并进入需求访谈 |
| `/book status` | 查看阶段、章节、字数、闸门、模型 |
| `/book next` | 推进下一阶段（章节阶段按配置自动串行） |
| `/book step` | 只运行下一个角色或闸门 |
| `/book run <role>` | 运行当前阶段对应的角色 |
| `/book approve` | 通过当前闸门并继续 |
| `/book revise <意见>` | 带修改意见重跑当前闸门产物 |
| `/book chapter <n>` | 切换当前章节 |
| `/book rewind <阶段>` | 回滚到 `design` / `outline` / `chapter_plan` / `final_review` |
| `/book models` | 为角色选择模型和 thinking level |
| `/book config` | 查看配置 |
| `/book pause` / `/book resume` | 暂停 / 恢复 |
| `/book abort` | 请求中止当前角色运行（也可按 Esc） |
| `/book export` | 导出 Markdown 成稿 |
| `/book doctor` | 检查状态、文件、锁、未完成运行 |
| `/book open [slug]` | 列出或切换书籍项目 |
| `/book help` | 帮助 |

主 Agent 还可以调用 `writing_team` 工具，用自然语言驱动同一套流程。工具设置了 `executionMode: "sequential"`，并明确要求一次只推进一个阶段。

## 角色

| Role ID | 中文名 | 产物 |
|---|---|---|
| `architect` | 故事架构师 | `design.md`、`style-guide.md` |
| `worldbuilder` | 世界观设定师（可选） | `bible.md` |
| `outliner` | 大纲师 | `outline.md`、`outline.json` |
| `chapter_planner` | 章节规划师 | `chapters/chNNN/plan.md` |
| `writer` | 执笔作者 | `chapters/chNNN/draft.md` |
| `continuity_editor` | 连续性编辑 | `chapters/chNNN/continuity.md` |
| `reviser` | 修订作者 | `chapters/chNNN/revised.md` |
| `line_editor` | 文字编辑 | `chapters/chNNN/final.md` |
| `beta_reader` | 读者代表（可选） | `chapters/chNNN/reader-report.md` |
| `archivist` | 档案管理员 | `continuity/*.md` |
| `chief_editor` | 主编 | `reviews/final-review.md` |

角色提示词在 `prompts/` 中，可以直接修改；修改后 `/reload`。

## 配置

优先级：内置默认值 < `~/.pi/agent/writing-team.json` < `<cwd>/.pi/writing-team.json` < `book.json` 中的 `config`。

示例：

```json
{
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
    "writer": { "model": "provider/model-b", "thinkingLevel": "medium" }
  }
}
```

模型未配置时继承主会话模型；配置的模型不存在时会回退并给出警告。

## 书籍目录

```text
books/<slug>/
├── book.json
├── design.md
├── style-guide.md
├── bible.md
├── outline.md
├── outline.json
├── chapters/chNNN/
│   ├── plan.md
│   ├── draft.md
│   ├── continuity.md
│   ├── revised.md
│   ├── final.md
│   └── reader-report.md
├── continuity/
│   ├── characters.md
│   ├── timeline.md
│   ├── threads.md
│   ├── world.md
│   └── summaries.md
├── reviews/final-review.md
├── exports/
└── .runs/<runId>/
    ├── prompt.md          # 实际发送的角色提示
    ├── output.md          # 角色最终摘要
    ├── meta.json          # 模型、耗时、用量、校验结果
    └── <target files>     # 本次运行写入的工件快照
```

`book.json` 是状态机与配置；`.runs` 是每次运行的输入、输出、模型和用量记录；正式工件由 `save_artifact` 原子写入。

## 线性与安全

- 角色运行在 `createAgentSession()` 创建的独立内存会话中，一次 `await` 一个；
- 角色只有 `read`、`grep`、`find`、`ls` 和受控的 `save_artifact`，没有 `bash` / `edit` / `write`；
- `save_artifact` 只允许写本次角色的声明目标，并拒绝 `..` 路径越界；
- 每个项目有 `.lock` 跨进程锁，避免两个终端同时写；
- 每次运行前 `book.json` 记录运行状态，崩溃后未完成运行标记为 `interrupted`，阶段不前进；
- 角色输出有校验（字数、JSON、问题级别、`VERDICT` 等），失败会在同角色内补全一次。

## 测试

```bash
cd .pi/extensions/writing-team
node --experimental-strip-types --test tests/*.test.ts
```

测试覆盖：

- 状态迁移与非法迁移；
- 单飞锁；
- 路径越界；
- 配置合并；
- 大纲解析；
- 用假角色运行器跑完整流水线，并断言任意时刻最多一个角色。

## 已知限制

- 闸门依赖交互式 TUI；在 print / JSON 模式下会返回暂停；
- 导出目前只支持 Markdown；
- 嵌套会话沿用 Pi 的模型认证，不额外复用主会话的临时 API key 覆盖；
- 角色不会自动联网查资料，设定以已确认工件为准。
