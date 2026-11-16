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
| `/book next` | 后台推进下一阶段（立即返回，可 `/book status` 查看） |
| `/book step` | 后台运行下一个角色或闸门 |
| `/book run <role>` | 后台运行当前阶段对应的角色 |
| `/book approve` | 后台通过当前闸门并继续 |
| `/book revise <意见>` | 后台带修改意见重跑当前闸门产物 |
| `/book chapter <n>` | 切换当前章节 |
| `/book rewind <阶段>` | 回滚到 `design` / `outline` / `chapter_plan` / `final_review` |
| `/book models` | 为角色选择模型和 thinking level |
| `/book config` | 查看配置 |
| `/book auto on\|off` | 开启/关闭全自动模式（闸门自动通过） |
| `/book auto-run` | 后台全自动跑完剩余流程 |
| `/book pause` / `/book resume` | 暂停 / 恢复 |
| `/book abort` | 请求中止当前角色运行（也可按 Esc） |
| `/book export` | 导出 Markdown 成稿 |
| `/book doctor` | 检查状态、文件、锁、未完成运行 |
| `/book open [slug]` | 列出或切换书籍项目 |
| `/book help` | 帮助 |

全自动模式：

- `/book auto on` 后，所有闸门自动通过，产出校验失败时自动暂停；
- 全自动模式下 `/book next` 会直接跑到完成，不再逐章停下；需要单步执行时用 `/book step`；
- `/book auto-run` 会开启全自动并直接跑完剩余流程；
- 最终审稿为 `VERDICT: REVISE` 时，全自动模式会带问题交付并给出警告；
- 所有确认闸门都不展示全文，只列出 `design.md`、`outline.md`、`final.md`、`reviews/final-review.md` 等文件路径，方便你自行打开确认；
- 全自动模式仍然执行角色输出校验、字数校验、JSON 校验和归档检查，不会跳过质量底线。

主 Agent 还可以调用 `writing_team` 工具，用自然语言驱动同一套流程。工具设置了 `executionMode: "sequential"`，并明确要求一次只推进一个阶段。全自动相关 action：`set_auto`、`run_all`。

耗时操作（`next`、`step`、`run_role`、`approve`、`revise`、`run_all`）会在后台启动，命令/工具立即返回。运行期间可以继续使用：

```text
/book status     # 查看当前角色、实时上下文、操作详情、Token
/book doctor     # 文件与状态体检
/book abort      # 请求中止当前后台任务
```

同一时间仍然只允许一个后台任务；重复推进会被拒绝并提示当前任务信息。`pause` / `resume` / `chapter` / `models` 等会修改状态或配置的命令在后台任务运行期间会被拒绝。

## 角色

| Role ID | 中文名 | 产物 |
|---|---|---|
| `architect` | 故事架构师 | `design.md`、`style-guide.md` |
| `worldbuilder` | 世界观设定师（可选） | `bible.md` |
| `outliner` | 大纲师 | `outline.md`、`outline.json` |
| `chapter_planner` | 章节规划师 | `chapters/chNNN/plan.md` |
| `writer` | 执笔作者 | `chapters/chNNN/draft.md` |
| `continuity_editor` | 连续性编辑 | `chapters/chNNN/continuity.md`、`continuity.json` |
| `reviser` | 修订作者 | `chapters/chNNN/revised.md` |
| `line_editor` | 文字编辑 | `chapters/chNNN/final.md` |
| `beta_reader` | 读者代表（可选） | `chapters/chNNN/reader-report.md` |
| `archivist` | 档案管理员 | `continuity/*.md` |
| `chief_editor` | 主编 | `reviews/final-review.md`、`final-review.json` |

角色提示词在 `prompts/` 中，可以直接修改；修改后 `/reload`。

## 配置

优先级：内置默认值 < `~/.pi/agent/writing-team.json` < `<cwd>/.pi/writing-team.json` < `book.json` 中的 `config`。

`book.json` 只保存**本书相对项目配置的差异项**（例如单个角色的模型、`fullAuto`），不会保存完整配置快照。因此初始化之后再修改全局或项目配置，对已有书籍仍然生效。

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
    "totalWords": 80000,
    "fullAuto": false
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
│   ├── continuity.md       # 人读问题清单
│   ├── continuity.json     # 结构化问题（决定是否进入 revision）
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
├── reviews/final-review.json
├── exports/
├── archive/               # rewind 时归档的旧章节 / 连续性档案
└── .runs/
    ├── index.jsonl        # 全量运行索引（book.json 只保留最近 keepRuns 条）
    └── <runId>/
        ├── prompt.md      # 实际发送的角色提示
        ├── output.md      # 角色最终摘要
        ├── meta.json      # 模型、耗时、用量、校验、提示哈希、实际读取文件
        └── <target files> # 本次运行写入的工件快照
```

`book.json` 是状态机与配置；`.runs` 是每次运行的输入、输出、模型和用量记录；正式工件由 `save_artifact` 原子写入。

## 工件事务与回滚

- 角色的 `save_artifact` 只写入 `.runs/<runId>/`，通过校验后才会原子替换正式工件；失败、取消或校验不通过不会污染上一版正式文件。
- `continuity.json` 是连续性审校的机器可读结论，`reviews/final-review.json` 是终审结论；Markdown 仍用于人工阅读。
- `book.json` 的 `continuityThrough` 记录连续性档案可信到第几章。返工第 N 章时会把档案恢复到第 N−1 章，并把第 N 章及之后的章节确认重置。
- `/book rewind design|outline` 会把旧 `chapters/`、`continuity/`、`reviews/` 移动到 `archive/`，不会直接删除。
- 审批闸门会记录工件哈希；如果审批后手工修改了文件，`/book doctor` 会报告“确认后被修改”。

## 实时进度与 Token 统计

子 Agent 运行期间，底部状态栏和进度 Widget 会实时显示：

- 当前角色；
- 子 Agent 上下文占用，例如 `ctx 42.3k/128.0k (33%)`；
- 当前操作，例如 `读取 chapters/ch001/final.md`、`搜索「伏笔」 @ continuity/threads.md`、`保存 chapters/ch001/final.md（4,120 字符）`；
- 当前角色累计 input/output token；
- 整个项目累计 token 与成本。

项目累计用量保存在 `book.json` 的 `stats.totalUsage`，每次角色的精确用量保存在 `.runs/<runId>/meta.json`。

## 线性与安全

- 角色运行在 `createAgentSession()` 创建的独立内存会话中，一次 `await` 一个；
- 角色只有 `read`、`grep`、`find`、`ls` 和受控的 `save_artifact`，没有 `bash` / `edit` / `write`；
- 子 Agent 运行时会实时上报上下文大小和工具操作详情；
- `save_artifact` 只允许写本次角色的声明目标，并拒绝 `..` 路径越界；
- 每个项目有 `.lock` 跨进程锁，避免两个终端同时写；
- 整个后台任务持有书籍锁，单个角色运行使用可重入引用；锁会定期更新心跳，避免长任务被误判为陈旧锁；
- 每次运行前 `book.json` 记录运行状态，崩溃后未完成运行标记为 `interrupted`，阶段不前进；
- 角色输出有校验（字数、结构化连续性 JSON、大纲连续章节号、`VERDICT` 等），失败会在同角色内补全一次；
- `book.json` 只保留最近 `keepRuns` 条运行摘要，完整记录写入 `.runs/index.jsonl`。

## 测试

```bash
cd .pi/extensions/writing-team
node --experimental-strip-types --test tests/*.test.ts
```

测试覆盖：

- 状态迁移、非法迁移、暂停/错误恢复；
- 后台任务与可重入单飞锁；
- 路径越界与符号链接逃逸；
- 配置合并与“book.json 只保存差异项”；
- 大纲解析、章节号连续性；
- 工件两阶段提交与闸门哈希；
- 连续性档案回滚后重新跑完整流水线；
- 用假角色运行器跑完整流水线，并断言任意时刻最多一个角色。

## 已知限制

- 人工确认闸门依赖交互式 TUI；在 print / JSON 模式下会返回暂停；全自动模式不需要 UI；
- 全自动模式在产出校验失败时会暂停，而不是强行通过；
- 导出目前只支持 Markdown；
- 嵌套会话沿用 Pi 的模型认证，不额外复用主会话的临时 API key 覆盖；
- 角色不会自动联网查资料，设定以已确认工件为准；
- 早期项目（只有旧版 `book.json`、没有 `continuity.json` / `final-review.json`）会在下一次对应角色运行时补齐结构化工件；旧审批记录没有哈希时会由 `/book doctor` 给出警告。
