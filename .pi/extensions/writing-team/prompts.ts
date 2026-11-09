import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chapterKey, fileExists, readJson } from "./paths.ts";
import { roleLabel, roleOutputTargets } from "./roles.ts";
import type { BookProject, OutlineManifest, RoleId, TeamConfig } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const promptCache = new Map<string, string>();

export function loadPromptFile(name: string): string {
	const cached = promptCache.get(name);
	if (cached !== undefined) return cached;
	const path = join(HERE, "prompts", `${name}.md`);
	const text = readFileSync(path, "utf8");
	promptCache.set(name, text);
	return text;
}

export function buildSystemPrompt(role: RoleId): string {
	return `${loadPromptFile("_common").trim()}\n\n---\n\n${loadPromptFile(role).trim()}\n`;
}

export interface TaskPromptOptions {
	role: RoleId;
	book: BookProject;
	bookRoot: string;
	config: TeamConfig;
	chapter?: number;
	feedback?: string;
}

export function buildTaskPrompt(options: TaskPromptOptions): string {
	const { role, book, bookRoot, chapter, feedback } = options;
	const chapterNo = chapter ?? book.currentChapter;
	const targets = roleOutputTargets(role, chapterNo);
	const outline = readJson<OutlineManifest>(join(bookRoot, "outline.json"));
	const outlineChapter = (Array.isArray(outline?.chapters) ? outline.chapters : []).find((ch) => ch.n === chapterNo);
	const chapterTitle = outlineChapter?.title ?? `第 ${chapterNo} 章`;
	const targetWords = outlineChapter?.targetWords ?? book.config.defaults.chapterWords;

	const sections: string[] = [];
	sections.push(`# 本次任务：${roleLabel(role)}`);
	sections.push(buildFacts(book, chapterNo, chapterTitle, targetWords));
	sections.push(buildReadingList(role, bookRoot, chapterNo));
	sections.push(buildRoleTask(role, book, chapterNo, chapterTitle, targetWords, feedback));
	sections.push(buildOutputContract(targets, role));
	if (feedback?.trim()) {
		sections.push(`## 用户修改意见\n${feedback.trim()}\n\n请明确说明本版如何回应这些意见。`);
	}
	sections.push(
		[
			"## 完成前自检",
			"- 所有必写目标都已通过 save_artifact 保存；",
			"- 没有把全文粘贴在最终回复里；",
			"- 没有修改本角色输出列表之外的文件；",
			"- 如果存在需要用户拍板的问题，写在工件的 `## 待确认` 一节。",
		].join("\n"),
	);
	return sections.join("\n\n");
}

function buildFacts(book: BookProject, chapter: number, chapterTitle: string, targetWords: number): string {
	const intake = book.intake;
	return [
		"## 项目事实",
		`- 书名：${book.title}`,
		`- 题材：${intake.genre || "未填写"}`,
		`- 目标读者：${intake.audience || "未填写"}`,
		`- 核心卖点：${intake.premise || "未填写"}`,
		`- 主题：${intake.themes.length ? intake.themes.join("、") : "未填写"}`,
		`- 基调：${intake.tone || "未填写"}`,
		`- 叙事视角：${intake.pov || "未填写"}`,
		`- 总字数目标：${intake.targetWords || book.config.defaults.totalWords}`,
		`- 当前章节：第 ${chapter} 章《${chapterTitle}》`,
		`- 本章目标字数：${targetWords}`,
		`- 红线：${intake.redLines.length ? intake.redLines.join("；") : "无"}`,
		`- 语言：${book.language}`,
	].join("\n");
}

function buildReadingList(role: RoleId, bookRoot: string, chapter: number): string {
	const ch = chapterKey(chapter);
	const prev = chapter > 1 ? chapterKey(chapter - 1) : undefined;
	const entries: Array<[string, string]> = [];
	const add = (path: string, why: string) => {
		if (fileExists(join(bookRoot, path))) entries.push([path, why]);
	};

	switch (role) {
		case "architect":
			entries.push(["（无必读文件，依据项目事实创作）", "从零建立设计"]);
			break;
		case "worldbuilder":
			add("design.md", "已确认的创意设计");
			add("style-guide.md", "文风与红线");
			break;
		case "outliner":
			add("design.md", "已确认的创意设计");
			add("style-guide.md", "文风与节奏");
			add("bible.md", "世界规则与人物");
			break;
		case "chapter_planner":
			add("design.md", "主题与人物弧");
			add("style-guide.md", "视角与文风");
			add("bible.md", "世界规则");
			add("outline.md", "全书结构");
			add("outline.json", "当前章节目标");
			add("continuity/characters.md", "人物当前状态");
			add("continuity/timeline.md", "时间线");
			add("continuity/threads.md", "未回收伏笔");
			if (prev) add(`chapters/${prev}/final.md`, "上一章定稿");
			break;
		case "writer":
			add(`chapters/${ch}/plan.md`, "本章场景节拍（最高优先级）");
			add("style-guide.md", "文风、视角和红线");
			add("design.md", "主题与人物弧");
			add("bible.md", "世界规则");
			add("outline.md", "全书结构");
			add("continuity/characters.md", "人物当前状态");
			add("continuity/timeline.md", "时间线");
			add("continuity/threads.md", "未回收伏笔");
			if (prev) add(`chapters/${prev}/final.md`, "上一章定稿，用于衔接");
			break;
		case "continuity_editor":
			add(`chapters/${ch}/draft.md`, "待审校的初稿");
			add(`chapters/${ch}/plan.md`, "本章计划");
			add("bible.md", "世界规则");
			add("outline.md", "全书结构");
			add("design.md", "主题与人物弧");
			add("continuity/characters.md", "人物状态");
			add("continuity/timeline.md", "时间线");
			add("continuity/threads.md", "伏笔");
			add("continuity/world.md", "已确认世界规则");
			if (prev) add(`chapters/${prev}/final.md`, "上一章定稿");
			break;
		case "reviser":
			add(`chapters/${ch}/draft.md`, "原稿");
			add(`chapters/${ch}/continuity.md`, "必须处理的审校问题");
			add(`chapters/${ch}/plan.md`, "本章计划");
			add("style-guide.md", "文风");
			add("continuity/characters.md", "人物状态");
			add("continuity/timeline.md", "时间线");
			break;
		case "line_editor":
			add(`chapters/${ch}/revised.md`, "修订稿；若不存在则用 draft.md");
			add(`chapters/${ch}/draft.md`, "初稿（当修订稿不存在时）");
			add(`chapters/${ch}/plan.md`, "本章计划");
			add("style-guide.md", "文风、节奏、红线");
			add("design.md", "主题与人物语气");
			break;
		case "beta_reader":
			add(`chapters/${ch}/final.md`, "待读章节");
			add("design.md", "目标读者与卖点");
			add("outline.md", "全书结构");
			break;
		case "archivist":
			add(`chapters/${ch}/final.md`, "已确认定稿");
			add(`chapters/${ch}/plan.md`, "本章计划");
			add("bible.md", "初始设定");
			add("continuity/characters.md", "现有人物档案");
			add("continuity/timeline.md", "现有时间线");
			add("continuity/threads.md", "现有伏笔");
			add("continuity/world.md", "现有世界规则");
			add("continuity/summaries.md", "已有章节摘要");
			break;
		case "chief_editor":
			add("design.md", "创意目标");
			add("outline.md", "全书结构");
			add("outline.json", "章节清单");
			add("continuity/summaries.md", "章节摘要");
			add("continuity/characters.md", "人物状态");
			add("continuity/timeline.md", "时间线");
			add("continuity/threads.md", "伏笔回收情况");
			for (let n = 1; n <= 999; n++) {
				const path = `chapters/${chapterKey(n)}/final.md`;
				if (!fileExists(join(bookRoot, path))) break;
				add(path, `第 ${n} 章定稿`);
			}
			break;
	}
	if (entries.length === 0) return "## 必读文件\n（无）";
	return ["## 必读文件", ...entries.map(([path, why]) => `- \`${path}\`：${why}`)].join("\n");
}

function buildRoleTask(
	role: RoleId,
	book: BookProject,
	chapter: number,
	chapterTitle: string,
	targetWords: number,
	feedback?: string,
): string {
	const ch = chapterKey(chapter);
	const revisionNote = feedback?.trim() ? "这是带用户反馈的修订运行，必须保留上一版中未被否定的优点。" : "";
	switch (role) {
		case "architect":
			return [
				"## 具体任务",
				"根据项目事实，产出一份可执行的长篇创作设计。",
				"- `design.md`：一句话卖点、题材定位、目标读者、主题、核心矛盾、三幕/多幕结构、主要人物与人物弧、世界规则概要、情感节奏、结局方向、风险与红线。",
				"- `style-guide.md`：叙事视角、时态、人称、段落长度、对白风格、描写密度、章节长度、禁用表达、目标文风参考。",
				"设计要具体到可以直接指导大纲和章节写作，不要写空泛的创作理论。",
			].join("\n");
		case "worldbuilder":
			return [
				"## 具体任务",
				"基于已确认的设计，产出 `bible.md`：",
				"- 世界基本规则与代价；",
				"- 地理、势力、组织结构；",
				"- 主要人物小传、关系、秘密、语言习惯；",
				"- 关键术语表；",
				"- 时间线与历史事件；",
				"- 不能违反的 canon 规则。",
				"只扩展设计允许的内容，不要另起炉灶。",
			].join("\n");
		case "outliner":
			return [
				"## 具体任务",
				`产出 ${book.intake.targetWords || book.config.defaults.totalWords} 字规模的分章大纲。`,
				"- `outline.md`：三幕/多幕结构说明、分卷、每章标题、目标、冲突、转折、结尾钩子、预计字数；",
				"- `outline.json`：严格 JSON，结构为 `{ chapterCount, acts, chapters: [{ n, title, goal, conflict, turn, hook, pov, targetWords }] }`；",
				"- `chapterCount` 必须等于 `chapters.length`，章节号从 1 连续递增；",
				"- 至少安排两次重大反转，并保证每章都有推进；",
				"- 结局必须回应主题和核心矛盾。",
			].join("\n");
		case "chapter_planner":
			return [
				"## 具体任务",
				`为第 ${chapter} 章《${chapterTitle}》产出 \`chapters/${ch}/plan.md\`。`,
				"- 本章目标、核心冲突、情绪曲线；",
				"- 3–7 个场景，每个场景写：地点、时间、POV、场景目标、阻碍、结果、信息增量；",
				"- 与前后章的衔接点；",
				"- 必须引用的 canon 事实和需要埋下/回收的伏笔；",
				`- 目标字数 ${targetWords}。`,
			].join("\n");
		case "writer":
			return [
				"## 具体任务",
				`根据 \`chapters/${ch}/plan.md\` 写第 ${chapter} 章《${chapterTitle}》的完整初稿。`,
				`- 目标字数 ${targetWords}，允许 ±15%；`,
				"- 按场景顺序写，保持 POV 一致；",
				"- 用行动、对白和细节推进，不要用总结代替场景；",
				"- 章末必须有钩子；",
				"- 长章节可分多次 `save_artifact`，使用 `mode: \"append\"` 逐场景追加；",
				"- 不要写作者旁白、创作说明或“以下是正文”。",
				revisionNote,
			].join("\n");
		case "continuity_editor":
			return [
				"## 具体任务",
				`审校 \`chapters/${ch}/draft.md\`，产出 \`chapters/${ch}/continuity.md\`。`,
				"逐条列出问题，每条包含：",
				"- 级别：`blocker` / `major` / `minor`；",
				"- 类型：事实、时间线、人物、世界规则、伏笔、逻辑、视角；",
				"- 原文引用（短句即可）；",
				"- 冲突对象（引用 canon 文件）；",
				"- 建议修复方式。",
				"如果没有任何问题，明确写 `无问题`。不要重写正文，不要直接改 draft.md。",
			].join("\n");
		case "reviser":
			return [
				"## 具体任务",
				`根据 \`chapters/${ch}/continuity.md\` 修订 \`chapters/${ch}/draft.md\`，产出 \`chapters/${ch}/revised.md\`。`,
				"- 逐条处理 blocker 和 major 问题；minor 问题酌情处理；",
				"- 保留原稿中有效的场景、对白和情绪；",
				"- 不要为了修 bug 把章节改成大纲复述；",
				"- 在响应摘要中列出已处理的问题编号或类型；",
				revisionNote,
			].join("\n");
		case "line_editor":
			return [
				"## 具体任务",
				`润色第 ${chapter} 章，产出 \`chapters/${ch}/final.md\`。`,
				"- 优先使用 revised.md；如果不存在则用 draft.md；",
				"- 统一视角、时态、人称和文风；",
				"- 压缩重复解释，增强场景调度、对白张力和节奏；",
				"- 清除 AI 味表达、套话、过度总结和空泛抒情；",
				"- 不改变情节事实、人物关系和 canon；",
				`- 目标字数 ${targetWords}，允许 ±10%。`,
			].join("\n");
		case "beta_reader":
			return [
				"## 具体任务",
				`以目标读者身份阅读第 ${chapter} 章，产出 \`chapters/${ch}/reader-report.md\`。`,
				"- 整体投入度（1–10）；",
				"- 最吸引人的 3 个点；",
				"- 困惑、出戏或信息过载的地方；",
				"- 对后续发展的预测；",
				"- 可能弃读的位置和原因；",
				"- 一句话读者评价。",
				"只写读者体验，不要给作者改稿指令。",
			].join("\n");
		case "archivist":
			return [
				"## 具体任务",
				`第 ${chapter} 章已确认。更新连续性档案：`,
				"- `continuity/characters.md`：人物状态、关系、已知信息、受伤/获得物品；",
				"- `continuity/timeline.md`：本章发生的确定时间点与顺序；",
				"- `continuity/threads.md`：新埋伏笔、回收伏笔、仍开放线索；",
				"- `continuity/world.md`：本章新增或确认的世界规则；",
				"- `continuity/summaries.md`：追加第 " + chapter + " 章摘要（300–500 字）。",
				"保留旧内容，只做增量和必要修正；不要删除已经确认的事实。",
			].join("\n");
		case "chief_editor":
			return [
				"## 具体任务",
				"对全书做终审，产出 `reviews/final-review.md`。",
				"报告开头必须是 `VERDICT: PASS` 或 `VERDICT: REVISE`。",
				"必须覆盖：",
				"- 结构与节奏；",
				"- 主题与人物弧完成度；",
				"- 连续性、伏笔回收；",
				"- 文风一致性与可读性；",
				"- 目标读者匹配度；",
				"- 按优先级排序的修改清单（blocker/major/minor）。",
				"如果有 blocker，必须给 REVISE。",
			].join("\n");
	}
}

function buildOutputContract(targets: string[], role: RoleId): string {
	return [
		"## 输出契约",
		`本次允许写入的文件：${targets.map((t) => `\`${t}\``).join("、")}`,
		"必须使用 `save_artifact` 保存，路径参数使用上面列出的相对路径。",
		"最终回复只写不超过 150 字的摘要，不要粘贴正文。",
		role === "outliner" ? "`outline.json` 必须是严格 JSON，不要加 Markdown 代码围栏。" : "",
	].filter(Boolean).join("\n");
}
