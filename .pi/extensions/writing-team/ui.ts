import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BookStore } from "./state.ts";
import { chapterKey } from "./paths.ts";
import type { Phase } from "./types.ts";

const STATUS_KEY = "writing-team";
const WIDGET_KEY = "writing-team";

export function phaseLabel(phase: Phase): string {
	const labels: Record<Phase, string> = {
		idle: "未开始",
		intake: "需求访谈",
		design: "故事设计",
		design_gate: "设计确认",
		bible: "世界观设定",
		outline: "大纲生成",
		outline_gate: "大纲确认",
		chapter_plan: "章节规划",
		draft: "初稿写作",
		continuity: "连续性审校",
		revision: "修订",
		line_edit: "文字编辑",
		reader: "读者反馈",
		chapter_gate: "章节确认",
		archive: "档案更新",
		final_review: "全书终审",
		final_gate: "终审确认",
		export: "导出",
		done: "已完成",
		paused: "已暂停",
		error: "运行出错",
	};
	return labels[phase] ?? phase;
}

function progressBar(done: number, total: number, width = 16): string {
	if (total <= 0) return "";
	const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function updateStatus(ctx: ExtensionContext, store: BookStore, progress?: string): void {
	const book = store.book;
	const chapterText = book.chapterCount > 0 ? `第 ${book.currentChapter}/${book.chapterCount} 章` : "筹备中";
	const words = book.stats.words > 0 ? ` · ${book.stats.words.toLocaleString()} 字` : "";
	const extra = progress ? ` · ${progress}` : "";
	ctx.ui.setStatus(STATUS_KEY, `📖 ${book.title} · ${chapterText}${words}${extra}`);

	const lines: string[] = [];
	const design = book.gates.design.status === "approved" ? "✔ 设计" : "○ 设计";
	const outline = book.gates.outline.status === "approved" ? "✔ 大纲" : "○ 大纲";
	const chapterProgress =
		book.chapterCount > 0
			? `${book.stats.chaptersCompleted >= book.chapterCount ? "✔" : "▶"} 第${book.currentChapter}章`
			: "○ 章节";
	const final = book.gates.final.status === "approved" ? "✔ 终审" : "○ 终审";
	lines.push(`${design}   ${outline}   ${chapterProgress}   ${final}`);
	if (book.chapterCount > 0) {
		lines.push(`${progressBar(book.stats.chaptersCompleted, book.chapterCount)}  ${book.stats.chaptersCompleted}/${book.chapterCount} · ${phaseLabel(book.phase)}`);
	} else {
		lines.push(`当前：${phaseLabel(book.phase)}`);
	}
	if (progress) lines.push(progress);
	ctx.ui.setWidget(WIDGET_KEY, lines);
}

export function updateChapterGateWidget(ctx: ExtensionContext, store: BookStore, summary: string): void {
	const lines = [
		`第 ${store.book.currentChapter} 章待确认`,
		summary.split("\n").slice(0, 3).join("\n"),
	];
	ctx.ui.setWidget(WIDGET_KEY, lines);
}

export function clearStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

export function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(message, type);
}

export async function showText(ctx: ExtensionContext, title: string, text: string): Promise<void> {
	if (!ctx.hasUI) {
		notify(ctx, `${title}：${text.slice(0, 200)}...`, "info");
		return;
	}
	// The built-in editor is a convenient scrollable viewer. The returned edits
	// are intentionally discarded; artifacts are only changed by save_artifact.
	await ctx.ui.editor(`${title}（Esc 返回，不会保存）`, text);
}

export function chapterStatusLine(store: BookStore, n: number): string {
	const key = chapterKey(n);
	const gate = store.book.gates.chapters[key];
	if (gate?.status === "approved") return `✔ 第${n}章`;
	if (n === store.book.currentChapter) return `▶ 第${n}章`;
	return `○ 第${n}章`;
}
