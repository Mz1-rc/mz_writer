import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { WritingTeamApp } from "./app.ts";
import { runIntake } from "./commands.ts";
import { WritingPipeline } from "./pipeline.ts";
import { gateForPhase, roleForPhase } from "./roles.ts";
import { updateStatus, notify } from "./ui.ts";
import { ROLE_IDS, type RoleId, type ThinkingLevel } from "./types.ts";

const ACTIONS = [
	"init",
	"status",
	"next",
	"step",
	"run_role",
	"approve",
	"revise",
	"abort",
	"export",
	"set_chapter",
	"configure",
	"pause",
	"resume",
] as const;

export function registerWritingTeamTool(pi: ExtensionAPI, app: WritingTeamApp): void {
	pi.registerTool({
		name: "writing_team",
		label: "写作团队",
		description:
			"驱动多 Agent 写作团队：初始化、推进阶段、运行指定角色、确认闸门、导出。一次调用只推进一个阶段或一个角色，禁止并行调用。",
		promptSnippet: "驱动多 Agent 写作团队按阶段写作、确认和导出",
		promptGuidelines: [
			"Use writing_team when the user asks to start, continue, review, or export a long-form writing project.",
			"Call writing_team with one action at a time; never run multiple writing_team calls in parallel.",
			"When writing_team returns a gate or a summary, ask the user to confirm before advancing again.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS),
			title: Type.Optional(Type.String({ description: "init 时的书名" })),
			role: Type.Optional(StringEnum(ROLE_IDS, { description: "run_role 时运行的角色" })),
			chapter: Type.Optional(Type.Number({ description: "章节号" })),
			feedback: Type.Optional(Type.String({ description: "修改意见" })),
			model: Type.Optional(Type.String({ description: "configure 时的模型 provider/id" })),
			thinkingLevel: Type.Optional(
				StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"], {
					description: "configure 时的思考等级",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action;
			try {
				switch (action) {
					case "init": {
						const intake = await runIntake(ctx as any, params.title ?? "");
						if (!intake) {
							return {
								content: [{ type: "text" as const, text: "用户取消了初始化。" }],
								details: { ok: false },
							};
						}
						const { store } = app.create(ctx, intake.title, intake.intake);
						store.transition("design");
						updateStatus(ctx, store);
						return toolResult(store);
					}
					case "status": {
						const { store } = app.ensure(ctx);
						return toolResult(store);
					}
					case "next": {
						return withPipeline(ctx, app, (pipeline) => pipeline.next());
					}
					case "step": {
						return withPipeline(ctx, app, (pipeline) => pipeline.step());
					}
					case "run_role": {
						const role = params.role as RoleId | undefined;
						if (!role || !ROLE_IDS.includes(role)) throw new Error("run_role 需要有效的 role 参数");
						return withPipeline(ctx, app, async (pipeline) => {
							const expected = roleForPhase(pipeline.book.phase);
							if (expected !== role) {
								throw new Error(
									`当前阶段「${pipeline.book.phase}」应运行 ${expected ?? "无"}，而不是 ${role}。`,
								);
							}
							await runRole(pipeline, role);
						});
					}
					case "approve": {
						return withPipeline(ctx, app, async (pipeline) => {
							if (!gateForPhase(pipeline.book.phase)) throw new Error("当前阶段不是闸门");
							await pipeline.approveCurrentGate(params.feedback);
						});
					}
					case "revise": {
						if (!params.feedback?.trim()) throw new Error("revise 需要 feedback 参数");
						return withPipeline(ctx, app, async (pipeline) => {
							if (!gateForPhase(pipeline.book.phase)) throw new Error("当前阶段不是闸门");
							await pipeline.reviseCurrentGate(params.feedback!.trim());
						});
					}
					case "abort": {
						if (app.abortCurrent()) {
							return {
								content: [{ type: "text" as const, text: "已请求中止当前角色运行。" }],
								details: { ok: true, aborted: true },
							};
						}
						return {
							content: [{ type: "text" as const, text: "当前没有由本会话发起的运行。" }],
							details: { ok: false },
						};
					}
					case "export": {
						return withPipeline(ctx, app, (pipeline) => pipeline.runExport());
					}
					case "set_chapter": {
						return withPipeline(ctx, app, async (pipeline) => {
							if (!params.chapter) throw new Error("set_chapter 需要 chapter 参数");
							pipeline.setChapter(params.chapter);
						});
					}
					case "configure": {
						const { store } = app.ensure(ctx);
						const role = params.role as RoleId | undefined;
						if (!role || !ROLE_IDS.includes(role)) throw new Error("configure 需要有效的 role 参数");
						const current = store.book.config.roles[role] ?? {};
						store.book.config.roles[role] = {
							...current,
							model: params.model?.trim() || current.model,
							thinkingLevel: (params.thinkingLevel as ThinkingLevel | undefined) ?? current.thinkingLevel,
						};
						store.save();
						return toolResult(store);
					}
					case "pause": {
						const { store } = app.ensure(ctx);
						store.pause();
						updateStatus(ctx, store);
						return toolResult(store);
					}
					case "resume": {
						const { store } = app.ensure(ctx);
						store.resume();
						updateStatus(ctx, store);
						return toolResult(store);
					}
					default:
						throw new Error(`未知 action: ${action}`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, message, "error");
				return {
					content: [{ type: "text" as const, text: message }],
					details: { ok: false, error: message },
				};
			}
		},
	});
}

async function withPipeline(
	ctx: ExtensionToolContext,
	app: WritingTeamApp,
	fn: (pipeline: WritingPipeline) => Promise<void>,
) {
	const { store, config } = app.ensure(ctx);
	const controller = new AbortController();
	app.currentAbort = controller;
	const pipeline = new WritingPipeline(ctx, store, config, controller);
	try {
		await fn(pipeline);
		updateStatus(ctx, store);
		return toolResult(store);
	} finally {
		if (app.currentAbort === controller) app.currentAbort = undefined;
	}
}

function toolResult(store: import("./state.ts").BookStore) {
	const book = store.book;
	const text = [
		`《${book.title}》`,
		`阶段：${book.phase}`,
		`章节：第 ${book.currentChapter}/${book.chapterCount || "?"} 章`,
		`字数：${book.stats.words}`,
		`闸门：设计=${book.gates.design.status}, 大纲=${book.gates.outline.status}, 终审=${book.gates.final.status}`,
		book.lastError ? `最近错误：${book.lastError.message}` : "",
	]
		.filter(Boolean)
		.join("\n");
	return {
		content: [{ type: "text" as const, text }],
		details: {
			ok: true,
			slug: book.slug,
			title: book.title,
			phase: book.phase,
			currentChapter: book.currentChapter,
			chapterCount: book.chapterCount,
			words: book.stats.words,
			gates: book.gates,
			root: store.root,
			lastError: book.lastError,
		},
	};
}

async function runRole(pipeline: WritingPipeline, role: RoleId): Promise<void> {
	switch (role) {
		case "architect":
			await pipeline.runDesign();
			return;
		case "worldbuilder":
			await pipeline.runWorldbuilder();
			return;
		case "outliner":
			await pipeline.runOutline();
			return;
		case "chapter_planner":
			await pipeline.runChapterPlanner();
			return;
		case "writer":
			await pipeline.runWriter();
			return;
		case "continuity_editor":
			await pipeline.runContinuity();
			return;
		case "reviser":
			await pipeline.runReviser();
			return;
		case "line_editor":
			await pipeline.runLineEditor();
			return;
		case "beta_reader":
			await pipeline.runBetaReader();
			return;
		case "archivist":
			await pipeline.runArchivist();
			return;
		case "chief_editor":
			await pipeline.runFinalReview();
			return;
	}
}

