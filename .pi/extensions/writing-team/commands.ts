import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WritingTeamApp } from "./app.ts";
import { runDoctor } from "./doctor.ts";
import { roleForPhase, roleLabel } from "./roles.ts";
import { WritingPipeline } from "./pipeline.ts";
import { formatTokens, phaseLabel, updateStatus, notify } from "./ui.ts";
import { ROLE_IDS, type RoleId, type ThinkingLevel } from "./types.ts";

const SUBCOMMANDS = [
	"init",
	"status",
	"next",
	"step",
	"run",
	"approve",
	"revise",
	"chapter",
	"rewind",
	"models",
	"config",
	"auto",
	"auto-run",
	"pause",
	"resume",
	"abort",
	"export",
	"doctor",
	"open",
	"help",
];

export function registerBookCommand(pi: ExtensionAPI, app: WritingTeamApp): void {
	pi.registerCommand("book", {
		description: "多 Agent 写作团队：初始化、推进、确认、导出",
		getArgumentCompletions(prefix: string) {
			const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			await handleBookCommand(args, ctx, app);
		},
	});
}

export async function handleBookCommand(args: string, ctx: ExtensionCommandContext, app: WritingTeamApp): Promise<void> {
	const trimmed = args.trim();
	const firstSpace = trimmed.indexOf(" ");
	const sub = (firstSpace >= 0 ? trimmed.slice(0, firstSpace) : trimmed) || "status";
	const rest = firstSpace >= 0 ? trimmed.slice(firstSpace + 1).trim() : "";

	try {
		switch (sub) {
			case "init":
				await initBook(ctx, app, rest);
				return;
			case "status":
				showStatus(ctx, app);
				return;
			case "next":
				startPipeline(ctx, app, "推进下一阶段", (pipeline) => pipeline.runNextAction());
				return;
			case "step":
				startPipeline(ctx, app, "运行下一步", (pipeline) => pipeline.step());
				return;
			case "run":
				startPipeline(ctx, app, `运行角色 ${rest || "(当前阶段)"}`, (pipeline) => runSpecificRole(pipeline, rest));
				return;
			case "approve":
				startPipeline(ctx, app, "通过闸门", async (pipeline) => {
					await pipeline.approveCurrentGate(rest || undefined);
					if (pipeline.book.config.defaults.fullAuto) await pipeline.runAll();
				});
				return;
			case "revise":
				if (!rest) throw new Error("用法：/book revise <修改意见>");
				startPipeline(ctx, app, "按意见重跑", async (pipeline) => {
					await pipeline.reviseCurrentGate(rest);
					if (pipeline.book.config.defaults.fullAuto) await pipeline.runAll();
				});
				return;
			case "chapter":
				await withPipeline(ctx, app, async (pipeline) => {
					const n = Number(rest);
					pipeline.setChapter(n);
					notify(ctx, `当前章节切换为第 ${n} 章《${pipeline.store.chapterTitle(n)}》。`, "info");
				});
				return;
			case "rewind":
				await rewind(ctx, app, rest);
				return;
			case "models":
				await configureRoleModel(ctx, app);
				return;
			case "config":
				showConfig(ctx, app);
				return;
			case "auto":
				setAutoMode(ctx, app, rest);
				return;
			case "auto-run":
				await runAll(ctx, app);
				return;
			case "pause":
				await withPipeline(ctx, app, async (pipeline) => {
					pipeline.store.pause();
					notify(ctx, "项目已暂停。", "info");
				});
				return;
			case "resume":
				await withPipeline(ctx, app, async (pipeline) => {
					pipeline.store.resume();
					notify(ctx, "项目已恢复。", "info");
					updateStatus(ctx, pipeline.store);
				});
				return;
			case "abort":
				await abortCurrent(ctx, app);
				return;
			case "export":
				await withPipeline(ctx, app, (pipeline) => pipeline.runExport());
				return;
			case "doctor":
				doctor(ctx, app);
				return;
			case "open":
				openBook(ctx, app, rest);
				return;
			case "help":
				showHelp(ctx);
				return;
			default:
				notify(ctx, `未知子命令：${sub}。使用 /book help 查看用法。`, "error");
				return;
		}
	} catch (error) {
		notify(ctx, error instanceof Error ? error.message : String(error), "error");
	}
}

function startPipeline(
	ctx: ExtensionCommandContext,
	app: WritingTeamApp,
	label: string,
	fn: (pipeline: WritingPipeline) => Promise<void>,
): void {
	const { store, config } = app.ensure(ctx);
	app.startJob(
		label,
		async (controller) => {
			const pipeline = new WritingPipeline(ctx, store, config, controller, undefined, false);
			try {
				await fn(pipeline);
				notify(ctx, `✅ ${label}完成（${phaseLabel(pipeline.book.phase)}）。`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (controller.signal.aborted) {
					notify(ctx, "后台任务已中止。", "warning");
				} else {
					notify(ctx, message, "error");
				}
			} finally {
				updateStatus(ctx, store);
			}
		},
		store,
	);
	notify(ctx, `⏳ 已启动后台任务：${label}。使用 /book status 查看进度。`, "info");
}

async function withPipeline(
	ctx: ExtensionCommandContext,
	app: WritingTeamApp,
	fn: (pipeline: WritingPipeline) => Promise<void>,
): Promise<void> {
	const { store, config } = app.ensure(ctx);
	await app.runExclusive(
		"命令操作",
		async (controller) => {
			const pipeline = new WritingPipeline(ctx, store, config, controller);
			try {
				await fn(pipeline);
			} finally {
				updateStatus(ctx, store);
			}
		},
		store,
	);
}

async function initBook(ctx: ExtensionCommandContext, app: WritingTeamApp, titleArg: string): Promise<void> {
	if (!ctx.hasUI) throw new Error("初始化需要交互 UI，请在 TUI 中运行");
	if (app.isBusy()) throw new Error(app.busyMessage());
	const existing = app.list(ctx);
	if (existing.length > 0) {
		const ok = await ctx.ui.confirm("已有书籍项目", `当前已有 ${existing.length} 个项目。仍然创建新书？`);
		if (!ok) return;
	}
	const intake = await runIntake(ctx, titleArg);
	if (!intake) return;
	const { store } = app.create(ctx, intake.title, intake.intake);
	store.transition("design");
	updateStatus(ctx, store);
	notify(ctx, `已创建《${store.book.title}》。运行 /book next 开始设计。`, "info");
}

export async function runIntake(
	ctx: ExtensionCommandContext,
	titleArg: string,
): Promise<{ title: string; intake: import("./types.ts").Intake } | undefined> {
	const title =
		titleArg.trim() ||
		(await ctx.ui.input("书名", "例如：长夜将明"))?.trim() ||
		"";
	if (!title) {
		notify(ctx, "已取消创建。", "info");
		return undefined;
	}

	const genre = (await ctx.ui.input("题材 / 类型", "例如：东方奇幻 + 悬疑"))?.trim() || "未指定";
	const audience = (await ctx.ui.input("目标读者", "例如：18–35 岁，偏好强情节与人物成长"))?.trim() || "通用读者";
	const premise = (await ctx.ui.editor("核心卖点 / 一句话故事", ""))?.trim() || "";
	const themesRaw = (await ctx.ui.input("主题（逗号分隔）", "例如：记忆、背叛、选择"))?.trim() || "";
	const tone = (await ctx.ui.input("整体基调", "例如：冷峻、克制、偶有温情"))?.trim() || "未指定";
	const pov = (await ctx.ui.input("叙事视角", "例如：第三人称限知，双主角交替"))?.trim() || "第三人称限知";
	const totalRaw = (await ctx.ui.input("总字数目标", "80000"))?.trim() || "80000";
	const chapterRaw = (await ctx.ui.input("单章目标字数", "3200"))?.trim() || "3200";
	const refsRaw = (await ctx.ui.input("参考作品（逗号分隔，可留空）", "例如：某作品、某作者"))?.trim() || "";
	const redRaw = (await ctx.ui.input("内容红线（逗号分隔，可留空）", "例如：不写露骨暴力"))?.trim() || "";
	const notes = (await ctx.ui.editor("补充说明（可留空）", ""))?.trim() || "";

	const totalWords = Number(totalRaw) || 80000;
	const chapterWords = Number(chapterRaw) || 3200;
	return {
		title,
		intake: {
			genre,
			audience,
			premise,
			themes: splitList(themesRaw),
			tone,
			pov,
			targetWords: totalWords,
			chapterWords,
			references: splitList(refsRaw),
			redLines: splitList(redRaw),
			notes,
		},
	};
}

function showStatus(ctx: ExtensionCommandContext, app: WritingTeamApp): void {
	let store;
	let config;
	try {
		({ store, config } = app.ensure(ctx));
	} catch (error) {
		notify(ctx, error instanceof Error ? error.message : String(error), "info");
		return;
	}
	const book = store.book;
	const gateText = (g: { status: string }) => (g.status === "approved" ? "已确认" : g.status === "rejected" ? "待修改" : "待确认");
	const currentRun = [...book.runs].reverse().find((run) => run.status === "running");
	const lines = [
		`《${book.title}》`,
		`项目：${book.slug}`,
		`阶段：${phaseLabel(book.phase)}`,
		`连续性档案：可信到第 ${book.continuityThrough} 章`,
		`章节：第 ${book.currentChapter}/${book.chapterCount || "?"} 章`,
		`字数：${book.stats.words.toLocaleString()}（已完成 ${book.stats.chaptersCompleted} 章）`,
		`闸门：设计 ${gateText(book.gates.design)} / 大纲 ${gateText(book.gates.outline)} / 终审 ${gateText(book.gates.final)}`,
		currentRun ? `运行中：${roleLabel(currentRun.role)}（${currentRun.startedAt}）` : "运行中：无",
		app.currentJob ? `后台任务：${app.currentJob.label}（已运行 ${Math.max(0, Math.round((Date.now() - app.currentJob.startedAt) / 1000))}s）` : "",
		book.lastError ? `最近错误：${book.lastError.message}` : "",
		app.lastJob?.error ? `最近后台任务错误：${app.lastJob.error}` : "",
		`目录：${store.root}`,
		`模式：${book.config.defaults.fullAuto ? "⚡ 全自动（闸门自动通过）" : "人工确认"}`,
		`Token：总 ${formatTokens(book.stats.totalUsage?.total ?? ((book.stats.totalUsage?.input ?? 0) + (book.stats.totalUsage?.output ?? 0)))}（入 ${formatTokens(book.stats.totalUsage?.input)} / 出 ${formatTokens(book.stats.totalUsage?.output)}）`,
		`模型覆盖：${Object.entries(config.roles)
			.filter(([, value]) => value?.model)
			.map(([key, value]) => `${key}=${value?.model}`)
			.join(", ") || "无（继承主会话）"}`,
	].filter(Boolean);
	updateStatus(ctx, store);
	if (ctx.hasUI) {
		void ctx.ui.editor("写作团队状态（Esc 关闭）", lines.join("\n"));
	} else {
		notify(ctx, lines.join(" | "), "info");
	}
}

async function runSpecificRole(pipeline: WritingPipeline, roleArg: string): Promise<void> {
	const role = roleArg.trim() as RoleId;
	if (!ROLE_IDS.includes(role)) {
		throw new Error(`未知角色：${roleArg}。可用：${ROLE_IDS.join(", ")}`);
	}
	const currentRole = roleForPhase(pipeline.book.phase);
	if (currentRole !== role) {
		throw new Error(
			`当前阶段不能直接运行 ${role}。当前应运行：${currentRole ?? "无（请使用 /book next 或先通过闸门）"}`,
		);
	}
	await pipeline.runRoleById(role);
}

async function rewind(ctx: ExtensionCommandContext, app: WritingTeamApp, arg: string): Promise<void> {
	if (app.isBusy()) throw new Error(app.busyMessage());
	const { store, config } = app.ensure(ctx);
	const target = arg.trim();
	const allowed = ["design", "outline", "chapter_plan", "final_review"] as const;
	if (!allowed.includes(target as (typeof allowed)[number])) {
		throw new Error(`用法：/book rewind <${allowed.join("|")}>`);
	}
	const ok = await ctx.ui.confirm("回滚阶段", `确认回滚到 ${target}？旧章节与连续性档案会移动到 archive/，不会删除。`);
	if (!ok) return;
	await app.runExclusive(
		`回滚到 ${target}`,
		async (controller) => {
			const pipeline = new WritingPipeline(ctx, store, config, controller);
			pipeline.rewind(target as (typeof allowed)[number]);
			updateStatus(ctx, store);
		},
		store,
	);
	notify(ctx, `已回滚到 ${target}。`, "info");
}

async function configureRoleModel(ctx: ExtensionCommandContext, app: WritingTeamApp): Promise<void> {
	if (app.isBusy()) throw new Error(app.busyMessage());
	const { store, config } = app.ensure(ctx);
	const roleLabels = ROLE_IDS.map((role) => `${roleLabel(role)}（${role}）`);
	const roleChoice = await ctx.ui.select("为哪个角色配置模型？", roleLabels);
	if (!roleChoice) return;
	const role = ROLE_IDS[roleLabels.indexOf(roleChoice)];
	const available = (() => {
		const scoped = ctx.scopedModels.map((item) => item.model);
		if (scoped.length) return scoped;
		try {
			return ctx.modelRegistry.getAvailable();
		} catch {
			return [];
		}
	})();
	const modelOptions = ["继承主会话模型", ...available.map((model: any) => `${model.provider}/${model.id}`)];
	const modelChoice = await ctx.ui.select(`为 ${roleLabel(role)} 选择模型`, modelOptions);
	if (!modelChoice) return;
	const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const levelChoice = await ctx.ui.select("选择思考等级", levels);
	if (!levelChoice) return;
	const current = store.book.config.roles[role] ?? {};
	const next: typeof current = { ...current, thinkingLevel: levelChoice as ThinkingLevel };
	if (modelChoice === "继承主会话模型") delete next.model;
	else next.model = modelChoice;
	app.withBookLock(store, () => {
		store.book.config.roles[role] = next;
		store.save();
	});
	notify(ctx, `${roleLabel(role)} 已设置为 ${modelChoice} / ${levelChoice}。`, "info");
}

function showConfig(ctx: ExtensionCommandContext, app: WritingTeamApp): void {
	const { config } = app.ensure(ctx);
	if (!ctx.hasUI) {
		notify(ctx, JSON.stringify(config, null, 2), "info");
		return;
	}
	void ctx.ui.editor("写作团队配置（只读；修改请编辑 .pi/writing-team.json 或 book.json）", JSON.stringify(config, null, 2));
}

async function abortCurrent(ctx: ExtensionCommandContext, app: WritingTeamApp): Promise<void> {
	if (app.abortCurrent()) {
		notify(ctx, "已请求中止当前角色运行。", "warning");
		return;
	}
	notify(ctx, "当前没有由本会话发起的运行。若角色在其他终端运行，请在那里按 Esc 或等待完成。", "info");
}

function doctor(ctx: ExtensionCommandContext, app: WritingTeamApp): void {
	const { store } = app.ensure(ctx);
	const issues = runDoctor(store);
	const text = issues.map((issue) => `[${issue.level}] ${issue.message}`).join("\n");
	if (ctx.hasUI) void ctx.ui.editor("写作团队体检（Esc 关闭）", text);
	else notify(ctx, text, issues.some((i) => i.level === "error") ? "error" : "info");
}

function openBook(ctx: ExtensionCommandContext, app: WritingTeamApp, slug: string): void {
	if (slug && app.isBusy()) throw new Error(app.busyMessage());
	const list = app.list(ctx);
	if (!slug) {
		notify(ctx, list.length ? `可用项目：\n${list.map((b) => `${b.slug} — ${b.title}`).join("\n")}` : "没有书籍项目。", "info");
		return;
	}
	const { store } = app.ensure(ctx, slug);
	updateStatus(ctx, store);
	notify(ctx, `已打开《${store.book.title}》。`, "info");
}

function showHelp(ctx: ExtensionCommandContext): void {
	const text = [
		"/book init [书名]     创建书籍并进入需求访谈",
		"/book status          查看状态",
		"/book next            后台推进下一阶段（可用 status 查看）",
		"/book step            只运行下一个角色/闸门",
		"/book run <role>      运行当前阶段对应的角色",
		"/book approve         通过当前闸门并继续",
		"/book revise <意见>   带修改意见重跑当前闸门产物",
		"/book chapter <n>     切换当前章节",
		"/book rewind <阶段>   回滚到 design / outline / chapter_plan / final_review",
		"/book models          为角色配置模型与思考等级",
		"/book config          查看配置",
		"/book auto on|off     开启/关闭全自动模式（闸门不确认）",
		"/book auto-run        全自动跑完剩余流程",
		"/book pause|resume    暂停 / 恢复",
		"/book abort           中止当前角色运行",
		"/book export          导出 Markdown 成稿",
		"/book doctor          状态与文件体检",
		"/book open [slug]     列出或切换书籍项目",
		"/book help            显示帮助",
		"",
		`角色：${ROLE_IDS.join(", ")}`,
	].join("\n");
	notify(ctx, text, "info");
}

async function setAutoMode(ctx: ExtensionCommandContext, app: WritingTeamApp, arg: string): Promise<void> {
	if (app.isBusy()) throw new Error(app.busyMessage());
	const { store } = app.ensure(ctx);
	const value = arg.trim().toLowerCase();
	if (value !== "on" && value !== "true" && value !== "1" && value !== "off" && value !== "false" && value !== "0") {
		notify(ctx, `全自动模式当前为 ${store.book.config.defaults.fullAuto ? "开启" : "关闭"}。用法：/book auto on|off`, "info");
		return;
	}
	app.withBookLock(store, () => {
		store.book.config.defaults.fullAuto = value === "on" || value === "true" || value === "1";
		store.save();
	});
	updateStatus(ctx, store);
	notify(
		ctx,
		store.book.config.defaults.fullAuto
			? "⚡ 全自动模式已开启：闸门将自动通过，产出校验失败时会暂停。"
			: "全自动模式已关闭：闸门需要人工确认。",
		"info",
	);
}

async function runAll(ctx: ExtensionCommandContext, app: WritingTeamApp): Promise<void> {
	if (app.isBusy()) throw new Error(app.busyMessage());
	const { store } = app.ensure(ctx);
	if (!store.book.config.defaults.fullAuto) {
		app.withBookLock(store, () => {
			store.book.config.defaults.fullAuto = true;
			store.save();
		});
		notify(ctx, "⚡ 已自动开启全自动模式并开始运行。", "warning");
	}
	startPipeline(ctx, app, "全自动运行", (pipeline) => pipeline.runAll());
}

function splitList(text: string): string[] {
	return text
		.split(/[,，、\n]/)
		.map((item) => item.trim())
		.filter(Boolean);
}
