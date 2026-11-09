import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	hasBlockingContinuityIssues,
	readOutlineManifest,
	validateRoleOutputs,
} from "./artifacts.ts";
import { effectiveThinkingLevel, isBetaReaderEnabled, isWorldbuilderEnabled, resolveModel, roleConfig } from "./config.ts";
import { gateForPhase, roleLabel, roleOutputTargets, rolePhase } from "./roles.ts";
import { buildSystemPrompt, buildTaskPrompt } from "./prompts.ts";
import {
	chapterKey,
	ensureDir,
	fileExists,
	nowIso,
	readText,
	resolveWithin,
	writeAtomic,
	writeJsonAtomic,
} from "./paths.ts";
import type { BookStore } from "./state.ts";
import type { BookProject, GateId, RoleId, RoleRunOptions, RoleRunResult, RunRecord, TeamConfig } from "./types.ts";

type RoleRunner = (options: RoleRunOptions) => Promise<RoleRunResult>;
import { runGate } from "./gates.ts";
import { exportManuscript } from "./export.ts";
import { notify, phaseLabel, updateStatus } from "./ui.ts";

interface RunRoleOptions {
	chapter?: number;
	feedback?: string;
	extraInstruction?: string;
	progressPrefix?: string;
}

interface RoleAttempt {
	result: RoleRunResult;
	runId: string;
	validation: { ok: boolean; issues: string[] };
}

export class WritingPipeline {
	readonly ctx: ExtensionContext;
	readonly store: BookStore;
	readonly config: TeamConfig;
	readonly abortController?: AbortController;
	private readonly roleRunner?: RoleRunner;

	constructor(
		ctx: ExtensionContext,
		store: BookStore,
		config: TeamConfig,
		abortController?: AbortController,
		roleRunner?: RoleRunner,
	) {
		this.ctx = ctx;
		this.store = store;
		this.config = config;
		this.abortController = abortController;
		this.roleRunner = roleRunner;
	}

	get book(): BookProject {
		return this.store.book;
	}

	/** Dispatch the next stage according to the persisted phase. */
	async next(): Promise<void> {
		const phase = this.book.phase;
		switch (phase) {
			case "design":
				await this.runDesign();
				return;
			case "design_gate":
				notify(this.ctx, "当前在「设计确认」闸门。请使用 /book approve 或 /book revise <意见>。", "info");
				return;
			case "bible":
				await this.runWorldbuilder();
				return;
			case "outline":
				await this.runOutline();
				return;
			case "outline_gate":
				notify(this.ctx, "当前在「大纲确认」闸门。请使用 /book approve 或 /book revise <意见>。", "info");
				return;
			case "chapter_plan":
				if (this.config.defaults.autoRunChapterPipeline) await this.runChapterPipeline();
				else await this.runChapterStep();
				return;
			case "draft":
			case "continuity":
			case "revision":
			case "line_edit":
			case "reader":
			case "archive":
				await this.runChapterStep();
				return;
			case "chapter_gate":
				await this.runChapterGate();
				return;
			case "final_review":
				await this.runFinalReview();
				return;
			case "final_gate":
				notify(this.ctx, "当前在「终审确认」闸门。请使用 /book approve 或 /book revise <意见>。", "info");
				return;
			case "export":
				await this.runExport();
				return;
			case "done":
				notify(this.ctx, `《${this.book.title}》已完成。`, "info");
				return;
			case "paused":
				notify(this.ctx, "项目已暂停。请使用 /book resume 恢复。", "info");
				return;
			case "error": {
				const prev = this.book.previousPhase;
				if (!prev) {
					notify(this.ctx, `上次运行出错：${this.book.lastError?.message ?? "未知错误"}。`, "error");
					return;
				}
				notify(this.ctx, `正在重试上次失败的阶段（${phaseLabel(prev)}）……`, "warning");
				this.book.phase = prev;
				this.book.previousPhase = undefined;
				this.book.lastError = undefined;
				this.store.save();
				await this.next();
				return;
			}
			case "idle":
			case "intake":
				notify(this.ctx, "请先使用 /book init 创建书籍项目。", "info");
				return;
		}
	}

	/** Run exactly one role (or one gate) and stop. */
	async step(): Promise<void> {
		const phase = this.book.phase;
		switch (phase) {
			case "design":
				await this.runDesign();
				return;
			case "bible":
				await this.runWorldbuilder();
				return;
			case "outline":
				await this.runOutline();
				return;
			case "chapter_plan":
			case "draft":
			case "continuity":
			case "revision":
			case "line_edit":
			case "reader":
			case "archive":
				await this.runChapterStep();
				return;
			case "chapter_gate":
				await this.runChapterGate();
				return;
			case "final_review":
				await this.runFinalReview();
				return;
			case "export":
				await this.runExport();
				return;
			case "design_gate":
			case "outline_gate":
			case "final_gate":
				notify(this.ctx, `当前在「${phaseLabel(phase)}」闸门。请使用 /book approve 或 /book revise <意见>。`, "info");
				return;
			case "paused":
				notify(this.ctx, "项目已暂停。请使用 /book resume 恢复。", "info");
				return;
			case "error": {
				const prev = this.book.previousPhase;
				if (!prev) {
					notify(this.ctx, `上次运行出错：${this.book.lastError?.message ?? "未知错误"}。`, "error");
					return;
				}
				this.book.phase = prev;
				this.book.previousPhase = undefined;
				this.book.lastError = undefined;
				this.store.save();
				notify(this.ctx, `正在重试上次失败的阶段（${phaseLabel(prev)}）……`, "warning");
				await this.step();
				return;
			}
			default:
				notify(this.ctx, `当前阶段「${phaseLabel(phase)}」没有可执行步骤。`, "warning");
				return;
		}
	}

	// ---------------------------------------------------------------------
	// Design / world / outline
	// ---------------------------------------------------------------------

	async runDesign(feedback?: string): Promise<void> {
		let round = feedback ? 1 : 0;
		while (true) {
			const attempt = await this.runRoleWithRetry("architect", { feedback });
			this.store.transition("design_gate");
			const decision = await runGate(this.ctx, this.store, {
				gate: "design",
				summary: this.gateSummaryFor("design", attempt),
				revisionRound: round,
				maxRevisionRounds: this.config.defaults.maxRevisionRounds,
				allowApprove:
					(readText(join(this.store.root, "design.md")) ?? "").trim().length > 0 &&
					(readText(join(this.store.root, "style-guide.md")) ?? "").trim().length > 0,
			});
			if (decision.kind === "approve") {
				this.store.recordGate("design", "approved", { runId: attempt.runId });
				const next = isWorldbuilderEnabled(this.config, this.book.intake.genre) ? "bible" : "outline";
				this.store.transition(next);
				notify(this.ctx, "设计已确认。", "info");
				return;
			}
			if (decision.kind === "pause" || decision.kind === "abort") {
				this.store.pause();
				notify(this.ctx, decision.kind === "abort" ? "项目已暂停，文件保留。" : "项目已暂停。", "info");
				return;
			}
			if (decision.kind === "revise" || decision.kind === "rewrite") {
				this.store.recordGate("design", "rejected", { feedback: decision.feedback, runId: attempt.runId });
				feedback = decision.feedback;
				round++;
				continue;
			}
		}
	}

	async runWorldbuilder(): Promise<void> {
		await this.runRoleWithRetry("worldbuilder");
		this.store.transition("outline");
		notify(this.ctx, "世界观设定已完成，可以生成大纲。", "info");
	}

	async runOutline(feedback?: string): Promise<void> {
		let round = feedback ? 1 : 0;
		while (true) {
			const attempt = await this.runRoleWithRetry("outliner", { feedback });
			this.store.transition("outline_gate");
			const manifestBeforeGate = readOutlineManifest(this.store.root);
			const decision = await runGate(this.ctx, this.store, {
				gate: "outline",
				summary: this.gateSummaryFor("outline", attempt),
				revisionRound: round,
				maxRevisionRounds: this.config.defaults.maxRevisionRounds,
				allowApprove: Boolean(manifestBeforeGate) && (readText(join(this.store.root, "outline.md")) ?? "").trim().length > 0,
			});
			if (decision.kind === "approve") {
				const manifest = readOutlineManifest(this.store.root);
				if (!manifest) {
					notify(this.ctx, "大纲 JSON 无法解析，不能通过。已停留在「大纲确认」闸门，请使用 /book revise 让大纲师重新输出。", "error");
					return;
				}
				this.store.recordGate("outline", "approved", { runId: attempt.runId });
				this.book.chapterCount = manifest.chapterCount;
				this.book.currentChapter = 1;
				for (const chapter of manifest.chapters) {
					const key = chapterKey(chapter.n);
					this.book.gates.chapters[key] ??= { status: "pending" };
				}
				this.store.save();
				this.store.transition("chapter_plan");
				notify(this.ctx, `大纲已确认：${manifest.chapterCount} 章。`, "info");
				return;
			}
			if (decision.kind === "pause" || decision.kind === "abort") {
				this.store.pause();
				notify(this.ctx, decision.kind === "abort" ? "项目已暂停，文件保留。" : "项目已暂停。", "info");
				return;
			}
			if (decision.kind === "revise" || decision.kind === "rewrite") {
				this.store.recordGate("outline", "rejected", { feedback: decision.feedback, runId: attempt.runId });
				feedback = decision.feedback;
				round++;
				continue;
			}
		}
	}

	// ---------------------------------------------------------------------
	// Chapter loop
	// ---------------------------------------------------------------------

	async runChapterPipeline(reworkForFinal = false): Promise<void> {
		this.ensureChapterContext();
		await this.runChapterPlanner();
		await this.runWriter();
		await this.runContinuity();
		if (this.book.phase === "revision") await this.runReviser();
		await this.runLineEditor();
		if (isBetaReaderEnabled(this.config)) await this.runBetaReader();
		await this.runChapterGate(reworkForFinal);
	}

	async runChapterStep(): Promise<void> {
		this.ensureChapterContext();
		switch (this.book.phase) {
			case "chapter_plan":
				await this.runChapterPlanner();
				return;
			case "draft":
				await this.runWriter();
				return;
			case "continuity":
				await this.runContinuity();
				return;
			case "revision":
				await this.runReviser();
				return;
			case "line_edit":
				await this.runLineEditor();
				return;
			case "reader":
				await this.runBetaReader();
				return;
			case "chapter_gate":
				await this.runChapterGate();
				return;
			case "archive":
				await this.runArchivist();
				return;
			default:
				notify(this.ctx, `当前阶段「${phaseLabel(this.book.phase)}」没有可执行的单步角色。`, "warning");
				return;
		}
	}

	async runChapterPlanner(feedback?: string): Promise<void> {
		this.ensureChapterContext();
		this.assertValid(await this.runRoleWithRetry("chapter_planner", { chapter: this.book.currentChapter, feedback }), "chapter_planner");
		this.store.transition("draft");
	}

	async runWriter(feedback?: string): Promise<void> {
		this.ensureChapterContext();
		this.assertValid(await this.runRoleWithRetry("writer", { chapter: this.book.currentChapter, feedback }), "writer");
		this.store.transition("continuity");
	}

	async runContinuity(): Promise<void> {
		this.ensureChapterContext();
		const chapter = this.book.currentChapter;
		this.assertValid(await this.runRoleWithRetry("continuity_editor", { chapter }), "continuity_editor");
		const report = readText(join(this.store.root, "chapters", chapterKey(chapter), "continuity.md")) ?? "";
		if (hasBlockingContinuityIssues(report)) this.store.transition("revision");
		else this.store.transition("line_edit");
	}

	async runReviser(feedback?: string): Promise<void> {
		this.ensureChapterContext();
		this.assertValid(await this.runRoleWithRetry("reviser", { chapter: this.book.currentChapter, feedback }), "reviser");
		this.store.transition("line_edit");
	}

	async runLineEditor(feedback?: string): Promise<void> {
		this.ensureChapterContext();
		this.assertValid(await this.runRoleWithRetry("line_editor", { chapter: this.book.currentChapter, feedback }), "line_editor");
		this.store.refreshStats();
		if (isBetaReaderEnabled(this.config)) this.store.transition("reader");
		else this.store.transition("chapter_gate");
	}

	async runBetaReader(): Promise<void> {
		this.ensureChapterContext();
		this.assertValid(await this.runRoleWithRetry("beta_reader", { chapter: this.book.currentChapter }), "beta_reader");
		this.store.transition("chapter_gate");
	}

	async runChapterGate(reworkForFinal = false): Promise<void> {
		this.ensureChapterContext();
		const chapter = this.book.currentChapter;
		const key = chapterKey(chapter);
		let round = 0;
		const finalForAuto = readText(join(this.store.root, "chapters", key, "final.md")) ?? "";
		if (finalForAuto.trim() && this.autoApproveChapterGate()) {
			this.store.recordGate("chapter", "approved", { chapter, feedback: "chapterGate 配置自动通过" });
			this.store.refreshStats();
			this.store.transition("archive");
			await this.runArchivist(reworkForFinal);
			return;
		}

		while (true) {
			const finalText = readText(join(this.store.root, "chapters", key, "final.md")) ?? "";
			const continuity = readText(join(this.store.root, "chapters", key, "continuity.md")) ?? "";
			const reader = readText(join(this.store.root, "chapters", key, "reader-report.md")) ?? "";
			const decision = await runGate(this.ctx, this.store, {
				gate: "chapter",
				allowApprove: finalText.trim().length > 0,
				summary: [
					`第 ${chapter} 章《${this.store.chapterTitle(chapter)}》`,
					`字数：约 ${finalText.length} 字符`,
					continuity ? `连续性报告：${continuity.slice(0, 300)}` : "",
					reader ? `读者报告：${reader.slice(0, 300)}` : "",
					finalText ? `开头：${finalText.slice(0, 300)}` : "",
				]
					.filter(Boolean)
					.join("\n\n"),
				revisionRound: round,
				maxRevisionRounds: this.config.defaults.maxRevisionRounds,
			});

			if (decision.kind === "approve") {
				this.store.recordGate("chapter", "approved", { chapter });
				this.store.refreshStats();
				this.store.transition("archive");
				await this.runArchivist(reworkForFinal);
				return;
			}
			if (decision.kind === "pause" || decision.kind === "abort") {
				this.store.pause();
				notify(this.ctx, decision.kind === "abort" ? "项目已暂停，文件保留。" : "项目已暂停。", "info");
				return;
			}
			if (decision.kind === "revise") {
				this.store.recordGate("chapter", "rejected", { chapter, feedback: decision.feedback });
				round++;
				await this.runReviser(decision.feedback);
				await this.runLineEditor();
				if (isBetaReaderEnabled(this.config)) await this.runBetaReader();
				continue;
			}
			if (decision.kind === "rewrite") {
				this.store.recordGate("chapter", "rejected", { chapter, feedback: decision.feedback });
				round++;
				await this.runChapterPlanner(decision.feedback);
				await this.runWriter();
				await this.runContinuity();
				if (this.book.phase === "revision") await this.runReviser();
				await this.runLineEditor();
				if (isBetaReaderEnabled(this.config)) await this.runBetaReader();
				continue;
			}
		}
	}

	async runArchivist(reworkForFinal = false): Promise<void> {
		this.ensureChapterContext();
		this.assertValid(await this.runRoleWithRetry("archivist", { chapter: this.book.currentChapter }), "archivist");
		this.store.refreshStats();
		if (reworkForFinal) {
			this.store.transition("final_review");
			return;
		}
		if (this.book.currentChapter < this.book.chapterCount) {
			this.book.currentChapter += 1;
			this.store.transition("chapter_plan");
			notify(
				this.ctx,
				`第 ${this.book.currentChapter - 1} 章已完成。下一章：第 ${this.book.currentChapter} 章《${this.store.chapterTitle(this.book.currentChapter)}》。`,
				"info",
			);
		} else {
			this.store.transition("final_review");
			notify(this.ctx, "全书章节已完成，进入终审。", "info");
		}
	}

	// ---------------------------------------------------------------------
	// Final review / export
	// ---------------------------------------------------------------------

	async runFinalReview(feedback?: string): Promise<void> {
		let round = feedback ? 1 : 0;
		while (true) {
			const attempt = await this.runRoleWithRetry("chief_editor", { feedback });
			this.store.transition("final_gate");
			const decision = await runGate(this.ctx, this.store, {
				gate: "final",
				summary: this.gateSummaryFor("final", attempt),
				revisionRound: round,
				maxRevisionRounds: this.config.defaults.maxRevisionRounds,
			});
			if (decision.kind === "approve") {
				this.store.recordGate("final", "approved", { runId: attempt.runId });
				this.store.transition("export");
				await this.runExport();
				return;
			}
			if (decision.kind === "pause" || decision.kind === "abort") {
				this.store.pause();
				notify(this.ctx, decision.kind === "abort" ? "项目已暂停，文件保留。" : "项目已暂停。", "info");
				return;
			}
			if (decision.kind === "chapter_rework") {
				this.store.recordGate("final", "rejected", { feedback: decision.feedback, runId: attempt.runId });
				this.book.currentChapter = decision.chapter;
				this.store.transition("chapter_plan");
				notify(this.ctx, `开始返工第 ${decision.chapter} 章。`, "info");
				await this.runChapterPipeline(true);
				await this.runFinalReview();
				return;
			}
			if (decision.kind === "revise") {
				this.store.recordGate("final", "rejected", { feedback: decision.feedback, runId: attempt.runId });
				feedback = decision.feedback;
				round++;
				continue;
			}
		}
	}

	async runExport(): Promise<void> {
		this.store.transition("export");
		const result = await exportManuscript(this.store);
		this.store.refreshStats();
		this.store.transition("done");
		if (result.missing.length) {
			notify(this.ctx, `导出完成，但缺少第 ${result.missing.join("、")} 章正文。`, "warning");
		}
		notify(this.ctx, `已导出：${result.path}（${result.chapters} 章，约 ${result.words} 字）`, "info");
	}

	// ---------------------------------------------------------------------
	// Gate shortcuts used by commands
	// ---------------------------------------------------------------------

	async approveCurrentGate(feedback?: string): Promise<void> {
		const gate = gateForPhase(this.book.phase);
		if (!gate) throw new Error(`当前阶段「${phaseLabel(this.book.phase)}」不是闸门`);
		switch (gate) {
			case "design": {
				this.store.recordGate("design", "approved", { feedback });
				this.store.transition(isWorldbuilderEnabled(this.config, this.book.intake.genre) ? "bible" : "outline");
				await this.next();
				return;
			}
			case "outline": {
				const manifest = readOutlineManifest(this.store.root);
				if (!manifest) throw new Error("大纲 JSON 无法解析，不能通过");
				if (!(readText(join(this.store.root, "outline.md")) ?? "").trim()) throw new Error("outline.md 缺失，不能通过");
				this.store.recordGate("outline", "approved", { feedback });
				this.book.chapterCount = manifest.chapterCount;
				this.book.currentChapter = 1;
				for (const chapter of manifest.chapters) {
					this.book.gates.chapters[chapterKey(chapter.n)] ??= { status: "pending" };
				}
				this.store.save();
				this.store.transition("chapter_plan");
				await this.next();
				return;
			}
			case "chapter": {
				if (!(readText(join(this.store.root, "chapters", chapterKey(this.book.currentChapter), "final.md")) ?? "").trim()) {
					throw new Error("本章 final.md 缺失，不能通过章节确认");
				}
				this.store.recordGate("chapter", "approved", { chapter: this.book.currentChapter, feedback });
				this.store.refreshStats();
				this.store.transition("archive");
				await this.runArchivist();
				return;
			}
			case "final": {
				const review = readText(join(this.store.root, "reviews", "final-review.md")) ?? "";
				if (!/VERDICT:\s*PASS/i.test(review)) {
					throw new Error("终审结论不是 VERDICT: PASS，不能直接通过；请先修改或指定章节返工");
				}
				this.store.recordGate("final", "approved", { feedback });
				this.store.transition("export");
				await this.runExport();
				return;
			}
		}
	}

	async reviseCurrentGate(feedback: string): Promise<void> {
		const gate = gateForPhase(this.book.phase);
		if (!gate) throw new Error(`当前阶段「${phaseLabel(this.book.phase)}」不是闸门`);
		if (gate === "design") {
			await this.runDesign(feedback);
			return;
		}
		if (gate === "outline") {
			await this.runOutline(feedback);
			return;
		}
		if (gate === "chapter") {
			this.store.recordGate("chapter", "rejected", { chapter: this.book.currentChapter, feedback });
			await this.runReviser(feedback);
			await this.runLineEditor();
			if (isBetaReaderEnabled(this.config)) await this.runBetaReader();
			await this.runChapterGate();
			return;
		}
		await this.runFinalReview(feedback);
	}

	setChapter(n: number): void {
		if (!Number.isInteger(n) || n < 1) throw new Error("章节号必须是正整数");
		if (this.book.chapterCount > 0 && n > this.book.chapterCount) throw new Error(`章节号超出范围（1-${this.book.chapterCount}）`);
		this.book.currentChapter = n;
		if (!["chapter_plan", "draft", "continuity", "revision", "line_edit", "reader", "chapter_gate", "archive"].includes(this.book.phase)) {
			this.book.phase = "chapter_plan";
		}
		this.store.save();
	}

	rewind(phase: "design" | "outline" | "chapter_plan" | "final_review"): void {
		this.book.previousPhase = undefined;
		this.book.phase = phase;
		const resetChapterGates = () => {
			for (const gate of Object.values(this.book.gates.chapters)) {
				gate.status = "pending";
				gate.decidedAt = undefined;
				gate.artifactVersion = undefined;
			}
		};
		if (phase === "design") {
			this.book.gates.design = { status: "pending" };
			this.book.gates.outline = { status: "pending" };
			this.book.gates.final = { status: "pending" };
			resetChapterGates();
			this.book.chapterCount = 0;
			this.book.currentChapter = 1;
		} else if (phase === "outline") {
			this.book.gates.outline = { status: "pending" };
			this.book.gates.final = { status: "pending" };
			resetChapterGates();
			this.book.chapterCount = 0;
			this.book.currentChapter = 1;
		} else if (phase === "chapter_plan") {
			this.book.gates.final = { status: "pending" };
			const key = chapterKey(this.book.currentChapter);
			this.book.gates.chapters[key] = { status: "pending" };
			this.store.refreshStats();
		} else {
			this.book.gates.final = { status: "pending" };
		}
		this.store.save();
	}

	// ---------------------------------------------------------------------
	// Role execution
	// ---------------------------------------------------------------------

	private async runRoleWithRetry(role: RoleId, options: RunRoleOptions = {}): Promise<RoleAttempt> {
		let attempt = await this.runRoleOnce(role, options);
		if (attempt.validation.ok || this.effectiveSignal()?.aborted) return attempt;
		notify(this.ctx, `${roleLabel(role)} 的输出未通过校验，正在让同一角色补全一次……`, "warning");
		const repair = [
			"## 上一次输出未通过校验",
			...attempt.validation.issues.map((issue) => `- ${issue}`),
			"请修正这些问题，并重新通过 save_artifact 保存完整工件。",
		].join("\n");
		attempt = await this.runRoleOnce(role, { ...options, extraInstruction: repair });
		return attempt;
	}

	private async runRoleOnce(role: RoleId, options: RunRoleOptions): Promise<RoleAttempt> {
		const chapter = this.book.currentChapter;
		const needsChapter = ["chapter_planner", "writer", "continuity_editor", "reviser", "line_editor", "beta_reader", "archivist"].includes(role);
		const actualChapter = options.chapter ?? (needsChapter ? chapter : undefined);
		const phase = rolePhase(role);
		this.store.acquireLock(role);
		let run: RunRecord | undefined;
		try {
			this.store.transition(phase);
			const targets = roleOutputTargets(role, actualChapter ?? chapter);
			const inputFiles = this.existingInputFiles(role, actualChapter ?? chapter);
			run = this.store.beginRun(role, phase, {
				chapter: actualChapter,
				feedback: options.feedback,
				inputFiles,
			});
			const runDir = ensureDir(join(this.store.root, ".runs", run.id));
			let task = buildTaskPrompt({
				role,
				book: this.book,
				bookRoot: this.store.root,
				config: this.config,
				chapter: actualChapter,
				feedback: options.feedback,
			});
			if (options.extraInstruction?.trim()) task += `\n\n${options.extraInstruction.trim()}`;
			const system = buildSystemPrompt(role);
			writeAtomic(join(runDir, "prompt.md"), `# SYSTEM\n\n${system}\n\n# TASK\n\n${task}\n`);
			writeJsonAtomic(join(runDir, "meta.json"), {
				runId: run.id,
				role,
				phase,
				chapter: actualChapter,
				feedback: options.feedback,
				targets,
				inputFiles,
				startedAt: run.startedAt,
			});

			const cfg = roleConfig(this.config, role);
			const resolved = resolveModel(this.ctx, cfg.model);
			if (resolved.warning) notify(this.ctx, resolved.warning, "warning");
			const thinking = effectiveThinkingLevel(this.config, role);
			let lastStatus = 0;
			const progressPrefix = options.progressPrefix ?? roleLabel(role);

			const runner = this.roleRunner ?? (await import("./runner.ts")).runRole;
			const result = await runner({
				bookRoot: this.store.root,
				role,
				systemPrompt: system,
				taskPrompt: task,
				targets,
				runDir,
				model: resolved.model ?? this.ctx.model,
				thinkingLevel: thinking,
				signal: this.effectiveSignal(),
				onProgress: (update) => {
					const now = Date.now();
					if (now - lastStatus < 150) return;
					lastStatus = now;
					if (update.kind === "text") {
						updateStatus(this.ctx, this.store, `${progressPrefix} · 已生成 ${update.chars ?? 0} 字`);
					} else if (update.kind === "tool" && update.toolName && update.toolName !== "save_artifact") {
						updateStatus(this.ctx, this.store, `${progressPrefix} · 正在使用 ${update.toolName}`);
					}
				},
				onWrite: (target, chars) => {
					updateStatus(this.ctx, this.store, `${progressPrefix} · 已保存 ${target} (${chars} 字)`);
				},
			});

			const validation = validateRoleOutputs({
				role,
				bookRoot: this.store.root,
				targets,
				book: this.book,
				chapter: actualChapter,
			});
			this.store.finishRun(run.id, {
				status: "success",
				outputFiles: result.outputs.length ? result.outputs : validation.ok ? targets : [],
				usage: result.usage,
				model: result.model,
				thinkingLevel: result.thinkingLevel,
				validation,
			});
			writeJsonAtomic(join(runDir, "meta.json"), {
				runId: run.id,
				role,
				phase,
				chapter: actualChapter,
				feedback: options.feedback,
				targets,
				inputFiles,
				startedAt: run.startedAt,
				endedAt: nowIso(),
				model: result.model,
				thinkingLevel: result.thinkingLevel,
				usage: result.usage,
				validation,
				summary: result.finalText,
			});
			// Also keep a human-readable copy of the final summary.
			appendFileSync(join(runDir, "output.md"), `${result.finalText}\n`, "utf8");
			updateStatus(this.ctx, this.store);
			return { result, runId: run.id, validation };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = Boolean(this.effectiveSignal()?.aborted) || /aborted|abort/i.test(message);
			if (run) {
				this.store.finishRun(run.id, {
					status: aborted ? "aborted" : "error",
					error: message,
				});
				if (!aborted) this.store.markError(message, run.id);
			}
			throw error;
		} finally {
			this.store.releaseLock();
		}
	}

	private autoApproveChapterGate(): boolean {
		const mode = this.config.defaults.chapterGate;
		if (mode === "each") return false;
		if (mode === "none") return true;
		// "milestone": every third chapter and the final chapter.
		return this.book.currentChapter % 3 === 0 || this.book.currentChapter === this.book.chapterCount;
	}

	private assertValid(attempt: RoleAttempt, role: RoleId): void {
		if (attempt.validation.ok) return;
		const message = `${roleLabel(role)} 输出未通过校验：${attempt.validation.issues.join("；")}`;
		this.store.markError(message, attempt.runId);
		throw new Error(message);
	}

	private existingInputFiles(role: RoleId, chapter: number): string[] {
		const ch = chapterKey(chapter);
		const prev = chapter > 1 ? chapterKey(chapter - 1) : undefined;
		const candidates: string[] = [];
		const add = (path: string) => {
			if (fileExists(join(this.store.root, path))) candidates.push(path);
		};
		switch (role) {
			case "architect":
				break;
			case "worldbuilder":
				add("design.md");
				add("style-guide.md");
				break;
			case "outliner":
				add("design.md");
				add("style-guide.md");
				add("bible.md");
				break;
			case "chapter_planner":
				add("design.md");
				add("style-guide.md");
				add("bible.md");
				add("outline.md");
				add("outline.json");
				add("continuity/characters.md");
				add("continuity/timeline.md");
				add("continuity/threads.md");
				if (prev) add(`chapters/${prev}/final.md`);
				break;
			case "writer":
				add(`chapters/${ch}/plan.md`);
				add("design.md");
				add("style-guide.md");
				add("bible.md");
				add("outline.md");
				add("continuity/characters.md");
				add("continuity/timeline.md");
				add("continuity/threads.md");
				if (prev) add(`chapters/${prev}/final.md`);
				break;
			case "continuity_editor":
				add(`chapters/${ch}/draft.md`);
				add(`chapters/${ch}/plan.md`);
				add("design.md");
				add("bible.md");
				add("outline.md");
				add("continuity/characters.md");
				add("continuity/timeline.md");
				add("continuity/threads.md");
				add("continuity/world.md");
				if (prev) add(`chapters/${prev}/final.md`);
				break;
			case "reviser":
				add(`chapters/${ch}/draft.md`);
				add(`chapters/${ch}/continuity.md`);
				add(`chapters/${ch}/plan.md`);
				add("style-guide.md");
				add("continuity/characters.md");
				add("continuity/timeline.md");
				break;
			case "line_editor":
				add(`chapters/${ch}/revised.md`);
				add(`chapters/${ch}/draft.md`);
				add(`chapters/${ch}/plan.md`);
				add("style-guide.md");
				add("design.md");
				break;
			case "beta_reader":
				add(`chapters/${ch}/final.md`);
				add("design.md");
				add("outline.md");
				break;
			case "archivist":
				add(`chapters/${ch}/final.md`);
				add(`chapters/${ch}/plan.md`);
				add("bible.md");
				add("continuity/characters.md");
				add("continuity/timeline.md");
				add("continuity/threads.md");
				add("continuity/world.md");
				add("continuity/summaries.md");
				break;
			case "chief_editor":
				add("design.md");
				add("outline.md");
				add("outline.json");
				add("continuity/summaries.md");
				add("continuity/characters.md");
				add("continuity/timeline.md");
				add("continuity/threads.md");
				for (let n = 1; n <= this.book.chapterCount; n++) {
					add(`chapters/${chapterKey(n)}/final.md`);
				}
				break;
		}
		return candidates;
	}

	private gateSummaryFor(gate: GateId, attempt: RoleAttempt): string {
		const parts: string[] = [];
		if (attempt.result.finalText.trim()) parts.push(attempt.result.finalText.trim());
		if (!attempt.validation.ok) parts.push(`⚠ 校验问题：\n${attempt.validation.issues.map((i) => `- ${i}`).join("\n")}`);
		const primary =
			gate === "design"
				? "design.md"
				: gate === "outline"
					? "outline.md"
					: gate === "chapter"
						? `chapters/${chapterKey(this.book.currentChapter)}/final.md`
						: "reviews/final-review.md";
		try {
			const text = readFileSync(resolveWithin(this.store.root, primary), "utf8");
			if (!parts.length) parts.push(text.slice(0, 800));
			else if (gate === "outline") {
				const manifest = readOutlineManifest(this.store.root);
				if (manifest) {
					parts.push(
						`章节数：${manifest.chapterCount}\n` +
							manifest.chapters.slice(0, 30).map((ch) => `${ch.n}. ${ch.title} — ${ch.goal}`).join("\n"),
					);
				}
			}
		} catch {
			// ignore
		}
		return parts.join("\n\n");
	}

	private effectiveSignal(): AbortSignal | undefined {
		const signals = [this.ctx.signal, this.abortController?.signal].filter(Boolean) as AbortSignal[];
		if (signals.length === 0) return undefined;
		if (signals.length === 1) return signals[0];
		try {
			return AbortSignal.any(signals);
		} catch {
			return signals[0];
		}
	}

	private ensureChapterContext(): void {
		if (this.book.chapterCount <= 0) throw new Error("还没有确认的大纲，无法开始章节写作");
		if (this.book.currentChapter < 1 || this.book.currentChapter > this.book.chapterCount) {
			throw new Error(`当前章节号 ${this.book.currentChapter} 超出范围`);
		}
	}
}
