import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveWithin } from "./paths.ts";
import type { BookStore } from "./state.ts";
import type { GateId } from "./types.ts";
import { notify } from "./ui.ts";

export type GateDecision =
	| { kind: "approve" }
	| { kind: "revise"; feedback: string }
	| { kind: "rewrite"; feedback: string }
	| { kind: "chapter_rework"; chapter: number; feedback: string }
	| { kind: "pause" }
	| { kind: "abort" };

export interface GateOptions {
	gate: GateId;
	summary: string;
	revisionRound?: number;
	maxRevisionRounds?: number;
	/** 产出缺失或不合格时禁止直接通过。 */
	allowApprove?: boolean;
	/** 全自动模式下是否允许通过；false 表示校验失败，自动模式应暂停。 */
	validationOk?: boolean;
}

export function gateArtifactPaths(gate: GateId, chapter?: number): string[] {
	switch (gate) {
		case "design":
			return ["design.md", "style-guide.md"];
		case "outline":
			return ["outline.md", "outline.json"];
		case "chapter": {
			const key = `ch${String(chapter ?? 1).padStart(3, "0")}`;
			return [
				`chapters/${key}/plan.md`,
				`chapters/${key}/continuity.md`,
				`chapters/${key}/final.md`,
			];
		}
		case "final":
			return ["reviews/final-review.md"];
	}
}

function readFiles(store: BookStore, paths: string[]): string {
	const parts: string[] = [];
	for (const rel of paths) {
		try {
			const path = resolveWithin(store.root, rel);
			const text = readFileSync(path, "utf8");
			parts.push(`\n\n===== ${rel} =====\n\n${text}`);
		} catch {
			// Missing optional files are fine.
		}
	}
	return parts.join("");
}

export async function runGate(ctx: ExtensionContext, store: BookStore, options: GateOptions): Promise<GateDecision> {
	if (!ctx.hasUI) {
		notify(ctx, "当前模式没有交互 UI，无法进行人工确认；请在 TUI 中运行 /book。", "error");
		return { kind: "pause" };
	}

	const book = store.book;
	const chapter = book.currentChapter;
	const maxRounds = options.maxRevisionRounds ?? book.config.defaults.maxRevisionRounds;
	const round = options.revisionRound ?? 0;
	const gateName =
		options.gate === "design"
			? "设计确认"
			: options.gate === "outline"
				? "大纲确认"
				: options.gate === "chapter"
					? `第 ${chapter} 章确认`
					: "终审确认";
	const title = `《${book.title}》${gateName}`;
	const summary = truncate(options.summary, 1200);
	const reviewText = readFiles(store, gateArtifactPaths("final", chapter));
	const hasVerdict = /VERDICT:\s*(PASS|REVISE)/i.test(reviewText);
	const verdict = /VERDICT:\s*REVISE/i.test(reviewText) ? "REVISE" : "PASS";
	const allowApprove = options.allowApprove !== false && (options.gate !== "final" || hasVerdict);

	if (book.config.defaults.fullAuto) {
		if (!allowApprove || options.validationOk === false) {
			notify(ctx, `全自动模式：${gateName} 的产出未通过校验，已暂停。请修复后继续。`, "error");
			return { kind: "pause" };
		}
		if (options.gate === "final" && verdict === "REVISE") {
			notify(ctx, "全自动模式：主编结论为 VERDICT: REVISE，将带问题交付。", "warning");
		} else {
			notify(ctx, `全自动模式：自动通过${gateName}。`, "info");
		}
		return { kind: "approve" };
	}

	while (true) {
		const roundHint = round > 0 ? `已修改 ${round}/${maxRounds} 轮` : "尚未修改";
		const optionsList: string[] = [];
		if (allowApprove) optionsList.push(options.gate === "final" ? "确认交付" : "通过");
		if (options.gate === "chapter") {
			optionsList.push("局部修改");
			optionsList.push("整章重写");
		} else {
			optionsList.push("提出修改");
		}
		if (options.gate === "outline") optionsList.push("调整章数与节奏");
		optionsList.push("暂停");
		optionsList.push("放弃本项目");
		if (options.gate === "final") {
			optionsList.push("指定章节返工");
			if (hasVerdict && verdict === "REVISE") optionsList.push("带问题交付（不推荐）");
		}

		const choice = await ctx.ui.select(
			`${title}\n\n${summary}\n\n（${roundHint}）`,
			optionsList,
		);
		if (!choice) return { kind: "pause" };

		if (choice === "通过" || choice === "确认交付") {
			if (options.gate === "final" && verdict === "REVISE") {
				notify(ctx, "主编结论为 VERDICT: REVISE，不能直接交付。请选择修改或“带问题交付”。", "warning");
				continue;
			}
			if (options.gate === "final") {
				const ok = await ctx.ui.confirm("确认交付", "确认后将导出成稿并标记项目完成。是否继续？");
				if (!ok) continue;
			}
			return { kind: "approve" };
		}

		if (choice === "带问题交付（不推荐）") {
			const ok = await ctx.ui.confirm("带问题交付", "主编认为仍需修改。确认忽略问题并交付？");
			if (ok) return { kind: "approve" };
			continue;
		}

		if (choice === "指定章节返工") {
			const raw = await ctx.ui.input("指定章节返工", `输入章节号（1-${book.chapterCount}）`);
			const chapterNo = Number(raw);
			if (!Number.isInteger(chapterNo) || chapterNo < 1 || chapterNo > book.chapterCount) {
				notify(ctx, "章节号无效，返回闸门。", "warning");
				continue;
			}
			const feedback = await ctx.ui.editor(`第 ${chapterNo} 章返工要求`, "");
			if (!feedback?.trim()) {
				notify(ctx, "没有收到返工要求，返回闸门。", "warning");
				continue;
			}
			return { kind: "chapter_rework", chapter: chapterNo, feedback: feedback.trim() };
		}



		if (choice === "暂停") return { kind: "pause" };
		if (choice === "放弃本项目") {
			const ok = await ctx.ui.confirm("放弃本项目", "确认终止当前项目？文件不会删除，但会进入暂停状态。");
			if (ok) return { kind: "abort" };
			continue;
		}

		if (choice === "局部修改" || choice === "提出修改" || choice === "调整章数与节奏") {
			if (round >= maxRounds) {
				const again = await ctx.ui.confirm("修改轮次已用完", `已达到 ${maxRounds} 轮修改上限。仍然继续修改？`);
				if (!again) continue;
			}
			const prompt =
				choice === "调整章数与节奏"
					? "请输入调整要求（章节数量、分卷、节奏、单章字数等）："
					: "请输入具体修改意见（越具体越好）：";
			const feedback = await ctx.ui.editor(prompt, "");
			if (!feedback?.trim()) {
				notify(ctx, "没有收到修改意见，返回闸门。", "warning");
				continue;
			}
			return { kind: "revise", feedback: feedback.trim() };
		}

		if (choice === "整章重写") {
			if (round >= maxRounds) {
				const again = await ctx.ui.confirm("修改轮次已用完", `已达到 ${maxRounds} 轮修改上限。仍然整章重写？`);
				if (!again) continue;
			}
			const feedback = await ctx.ui.editor("请输入整章重写要求（需要改变什么、保留什么）：", "");
			if (!feedback?.trim()) {
				notify(ctx, "没有收到重写要求，返回闸门。", "warning");
				continue;
			}
			return { kind: "rewrite", feedback: feedback.trim() };
		}
	}
}

export function gateSummary(summary: string, fallback: string): string {
	const text = summary.trim();
	if (text) return truncate(text, 1200);
	return truncate(fallback, 1200);
}

function truncate(text: string, max: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)}…`;
}
