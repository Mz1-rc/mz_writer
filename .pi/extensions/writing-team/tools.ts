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
	"set_auto",
	"run_all",
] as const;

export function registerWritingTeamTool(pi: ExtensionAPI, app: WritingTeamApp): void {
	pi.registerTool({
		name: "writing_team",
		label: "写作团队",
		description:
			"驱动多 Agent 写作团队：初始化、推进阶段、运行指定角色、确认闸门、导出。耗时 action 会在后台启动并立即返回，可用 status 查看进度；一次只允许一个后台任务。",
		promptSnippet: "驱动多 Agent 写作团队按阶段写作、确认和导出",
		promptGuidelines: [
			"Use writing_team when the user asks to start, continue, review, or export a long-form writing project.",
			"Call writing_team with one action at a time; never run multiple writing_team calls in parallel.",
			"Long-running writing_team actions return immediately after starting a background job; use status to inspect progress.",
			"After starting a background job, do not start another writing_team action in the same turn; report the job to the user and wait.",
			"Use writing_team set_auto and run_all only when the user explicitly asks for fully automatic operation without gate confirmations.",
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
			auto: Type.Optional(Type.Boolean({ description: "set_auto 时是否开启全自动模式" })),
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
						return toolResult(store, app);
					}
					case "status": {
						const { store } = app.ensure(ctx);
						return toolResult(store, app);
					}
					case "next": {
						return startToolPipeline(ctx, app, "推进下一阶段", (pipeline) => pipeline.next());
					}
					case "step": {
						return startToolPipeline(ctx, app, "运行下一步", (pipeline) => pipeline.step());
					}
					case "run_role": {
						const role = params.role as RoleId | undefined;
						if (!role || !ROLE_IDS.includes(role)) throw new Error("run_role 需要有效的 role 参数");
						const { store } = app.ensure(ctx);
						const expected = roleForPhase(store.book.phase);
						if (expected !== role) {
							throw new Error(`当前阶段「${store.book.phase}」应运行 ${expected ?? "无"}，而不是 ${role}。`);
						}
						return startToolPipeline(ctx, app, `运行角色 ${role}`, async (pipeline) => {
							if (roleForPhase(pipeline.book.phase) !== role) {
								throw new Error(`当前阶段已变化，不能运行 ${role}。`);
							}
							await runRole(pipeline, role);
						});
					}
					case "approve": {
						const { store } = app.ensure(ctx);
						if (!gateForPhase(store.book.phase)) throw new Error("当前阶段不是闸门");
						return startToolPipeline(ctx, app, "通过闸门", (pipeline) => pipeline.approveCurrentGate(params.feedback));
					}
					case "revise": {
						if (!params.feedback?.trim()) throw new Error("revise 需要 feedback 参数");
						const { store } = app.ensure(ctx);
						if (!gateForPhase(store.book.phase)) throw new Error("当前阶段不是闸门");
						return startToolPipeline(ctx, app, "按意见重跑", (pipeline) => pipeline.reviseCurrentGate(params.feedback!.trim()));
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
						if (app.isBusy()) throw new Error(app.busyMessage());
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
						return toolResult(store, app);
					}
					case "pause": {
						if (app.isBusy()) throw new Error(app.busyMessage());
						const { store } = app.ensure(ctx);
						store.pause();
						updateStatus(ctx, store);
						return toolResult(store, app);
					}
					case "resume": {
						if (app.isBusy()) throw new Error(app.busyMessage());
						const { store } = app.ensure(ctx);
						store.resume();
						updateStatus(ctx, store);
						return toolResult(store, app);
					}
					case "set_auto": {
						const { store } = app.ensure(ctx);
						store.book.config.defaults.fullAuto = params.auto ?? true;
						store.save();
						updateStatus(ctx, store);
						return toolResult(store, app);
					}
					case "run_all": {
						if (app.isBusy()) throw new Error(app.busyMessage());
						const { store } = app.ensure(ctx);
						if (!store.book.config.defaults.fullAuto) {
							store.book.config.defaults.fullAuto = true;
							store.save();
							notify(ctx, "已自动开启全自动模式，开始运行剩余流程。", "warning");
						}
						return startToolPipeline(ctx, app, "全自动运行", (pipeline) => pipeline.runAll());
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

function startToolPipeline(
	ctx: ExtensionToolContext,
	app: WritingTeamApp,
	label: string,
	fn: (pipeline: WritingPipeline) => Promise<void>,
) {
	const { store, config } = app.ensure(ctx);
	app.startJob(label, async (controller) => {
		const pipeline = new WritingPipeline(ctx, store, config, controller, undefined, false);
		try {
			await fn(pipeline);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, controller.signal.aborted ? "后台任务已中止。" : message, controller.signal.aborted ? "warning" : "error");
		} finally {
			updateStatus(ctx, store);
		}
	});
	updateStatus(ctx, store);
	return toolResult(store, app, `⏳ 后台任务已启动：${label}。可使用 status 查看进度。`);
}

async function withPipeline(
	ctx: ExtensionToolContext,
	app: WritingTeamApp,
	fn: (pipeline: WritingPipeline) => Promise<void>,
) {
	if (app.isBusy()) throw new Error(app.busyMessage());
	const { store, config } = app.ensure(ctx);
	const controller = new AbortController();
	app.currentAbort = controller;
	const pipeline = new WritingPipeline(ctx, store, config, controller);
	try {
		await fn(pipeline);
		updateStatus(ctx, store);
		return toolResult(store, app);
	} finally {
		if (app.currentAbort === controller) app.currentAbort = undefined;
	}
}

function toolResult(store: import("./state.ts").BookStore, app?: WritingTeamApp, note?: string) {
	const book = store.book;
	const totalTokens = book.stats.totalUsage?.total ?? (book.stats.totalUsage?.input ?? 0) + (book.stats.totalUsage?.output ?? 0);
	const text = [
		note ?? "",
		`《${book.title}》`,
		`阶段：${book.phase}`,
		`章节：第 ${book.currentChapter}/${book.chapterCount || "?"} 章`,
		`字数：${book.stats.words}`,
		`Token：总 ${totalTokens}（入 ${book.stats.totalUsage?.input ?? 0} / 出 ${book.stats.totalUsage?.output ?? 0}）`,
		`模式：${book.config.defaults.fullAuto ? "全自动" : "人工确认"}`,
		`闸门：设计=${book.gates.design.status}, 大纲=${book.gates.outline.status}, 终审=${book.gates.final.status}`,
		book.lastError ? `最近错误：${book.lastError.message}` : "",
		app?.currentJob ? `后台任务：${app.currentJob.label}（${Math.max(0, Math.round((Date.now() - app.currentJob.startedAt) / 1000))}s）` : "",
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
			totalTokens,
			fullAuto: book.config.defaults.fullAuto,
			gates: book.gates,
			root: store.root,
			lastError: book.lastError,
			job: app?.currentJob
				? {
						label: app.currentJob.label,
						startedAt: app.currentJob.startedAt,
						done: app.currentJob.done,
					}
				: undefined,
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

