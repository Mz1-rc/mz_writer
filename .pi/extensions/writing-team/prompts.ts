import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./paths.ts";
import { formatReadingList, roleInputs, roleTask } from "./role-specs.ts";
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
	const targetWords = outlineChapter?.targetWords ?? book.intake.chapterWords ?? book.config.defaults.chapterWords;

	const sections: string[] = [];
	sections.push(`# 本次任务：${roleLabel(role)}`);
	sections.push(buildFacts(book, chapterNo, chapterTitle, targetWords));
	sections.push(buildReadingSection(role, bookRoot, chapterNo));
	sections.push(roleTask(role, book, chapterNo, chapterTitle, targetWords, feedback));
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
			"- JSON 工件必须是严格 JSON，不要加 Markdown 代码围栏；",
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
		`- 单章目标字数：${intake.chapterWords || book.config.defaults.chapterWords}`,
		`- 当前章节：第 ${chapter} 章《${chapterTitle}》`,
		`- 本章目标字数：${targetWords}`,
		`- 参考作品：${intake.references.length ? intake.references.join("、") : "无"}`,
		`- 红线：${intake.redLines.length ? intake.redLines.join("；") : "无"}`,
		`- 补充说明：${intake.notes || "无"}`,
		`- 语言：${book.language}`,
	].join("\n");
}

function buildReadingSection(role: RoleId, bookRoot: string, chapter: number): string {
	const inputs = roleInputs(role, bookRoot, chapter);
	if (inputs.length === 0 && role === "architect") {
		return "## 必读文件\n（无必读文件，依据项目事实创作）";
	}
	return formatReadingList(inputs);
}

function buildOutputContract(targets: string[], role: RoleId): string {
	return [
		"## 输出契约",
		`本次允许写入的文件：${targets.map((t) => `\`${t}\``).join("、")}`,
		"必须使用 `save_artifact` 保存，路径参数使用上面列出的相对路径。",
		"最终回复只写不超过 150 字的摘要，不要粘贴正文。",
		role === "outliner" || role === "continuity_editor" || role === "chief_editor"
			? "对应的 `.json` 工件必须是严格 JSON，不要加 Markdown 代码围栏。"
			: "",
	].filter(Boolean).join("\n");
}
