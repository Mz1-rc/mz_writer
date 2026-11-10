import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.ts";
import { WritingPipeline } from "../pipeline.ts";
import { createBook } from "../state.ts";
import type { Intake, RoleRunOptions, RoleRunResult } from "../types.ts";

function intake(): Intake {
	return {
		genre: "都市悬疑",
		audience: "成年读者",
		premise: "侦探发现记忆被篡改",
		themes: ["记忆", "身份"],
		tone: "冷峻",
		pov: "第三人称限知",
		targetWords: 800,
		chapterWords: 400,
		references: [],
		redLines: [],
		notes: "",
	};
}

function contentFor(role: string, target: string): string {
	if (target.endsWith("outline.json")) {
		return JSON.stringify({
			chapterCount: 2,
			chapters: [1, 2].map((n) => ({
				n,
				title: `第 ${n} 章`,
				goal: "推进主线",
				conflict: "主角受阻",
				turn: "出现反转",
				hook: "留下悬念",
				pov: "他",
				targetWords: 400,
			})),
		});
	}
	if (target.endsWith("final-review.md")) return "VERDICT: PASS\n\n终审通过。";
	if (target.endsWith("continuity.md")) return "## 问题清单\n\n无问题";
	if (target.includes("continuity/")) return `${role}\n${"档案".repeat(80)}`;
	if (target.endsWith("style-guide.md")) return `风格指南\n${"风格".repeat(100)}`;
	if (target.endsWith("design.md")) return `设计\n${"设计内容".repeat(300)}`;
	if (target.endsWith("bible.md")) return `设定\n${"世界".repeat(200)}`;
	if (target.endsWith("plan.md")) return `计划\n${"场景".repeat(200)}`;
	if (target.endsWith("draft.md")) return `初稿\n${"正文".repeat(300)}`;
	if (target.endsWith("revised.md")) return `修订\n${"修订".repeat(300)}`;
	if (target.endsWith("final.md")) return `定稿\n${"定稿".repeat(300)}`;
	if (target.endsWith("reader-report.md")) return `读者报告\n${"体验".repeat(100)}`;
	return `# ${role}\n${"内容".repeat(200)}`;
}

test("fake runner completes the whole pipeline with gates, never in parallel", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-pipe-test-"));
	try {
		const config = structuredClone(DEFAULT_CONFIG);
		config.defaults.thinkingLevel = "off";
		config.defaults.enableWorldbuilder = "never";
		config.defaults.enableBetaReader = false;
		config.defaults.autoRunChapterPipeline = true;
		config.defaults.maxRevisionRounds = 1;
		config.defaults.chapterWords = 400;
		config.defaults.totalWords = 800;
		const store = createBook(dir, "测试短篇", intake(), config);
		store.transition("design");

		let active = 0;
		let maxActive = 0;
		const fakeRunner = async (options: RoleRunOptions): Promise<RoleRunResult> => {
			active++;
			maxActive = Math.max(maxActive, active);
			try {
				await new Promise((resolve) => setTimeout(resolve, 1));
				for (const target of options.targets) {
					const path = join(options.bookRoot, target);
					mkdirSync(dirname(path), { recursive: true });
					writeFileSync(path, contentFor(options.role, target));
					if (!existsSync(path)) throw new Error(`fake did not write ${target}`);
				}
				return {
					finalText: `${options.role} done`,
					usage: { input: 1, output: 1, cost: 0 },
					outputs: options.targets,
					model: "fake/model",
					thinkingLevel: "off",
				};
			} finally {
				active--;
			}
		};

		const notified: string[] = [];
		const ui = {
			input: async () => "1",
			editor: async (_title: string, prefill?: string) => prefill ?? "",
			select: async (_title: string, options: string[]) => {
				if (options.includes("带问题交付（不推荐）")) return "带问题交付（不推荐）";
				if (options.includes("确认交付")) return "确认交付";
				return options[0];
			},
			confirm: async () => true,
			notify: (message: string) => notified.push(message),
			setStatus: () => {},
			setWidget: () => {},
		};
		const ctx = {
			cwd: dir,
			ui,
			hasUI: true,
			mode: "tui",
			signal: undefined,
			isIdle: () => true,
			scopedModels: [],
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
			sessionManager: {},
			model: undefined,
		};

		for (let i = 0; i < 15; i++) {
			if (store.book.phase === "done") break;
			const pipeline = new WritingPipeline(ctx as any, store, config, undefined, fakeRunner);
			await pipeline.next();
			if (store.book.phase === "design_gate" || store.book.phase === "outline_gate" || store.book.phase === "chapter_gate" || store.book.phase === "final_gate") {
				throw new Error(`pipeline stopped at gate ${store.book.phase}`);
			}
		}

		assert.equal(store.book.phase, "done");
		assert.equal(maxActive, 1, "roles must never run concurrently");
		assert.equal(store.book.stats.chaptersCompleted, 2);
		assert.ok(existsSync(join(store.root, "exports", "latest.md")));
		const exported = readFileSync(join(store.root, "exports", "latest.md"), "utf8");
		assert.match(exported, /第 1 章/);
		assert.match(exported, /第 2 章/);
		assert.ok(notified.some((message) => message.includes("已导出")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("full-auto mode completes without any gate UI", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-auto-test-"));
	try {
		const config = structuredClone(DEFAULT_CONFIG);
		config.defaults.thinkingLevel = "off";
		config.defaults.enableWorldbuilder = "never";
		config.defaults.enableBetaReader = false;
		config.defaults.autoRunChapterPipeline = true;
		config.defaults.chapterGate = "each";
		config.defaults.chapterWords = 400;
		config.defaults.totalWords = 800;
		config.defaults.fullAuto = true;
		const store = createBook(dir, "全自动测试", intake(), config);
		store.transition("design");

		const fakeRunner = async (options: RoleRunOptions): Promise<RoleRunResult> => {
			for (const target of options.targets) {
				const path = join(options.bookRoot, target);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, contentFor(options.role, target));
			}
			return {
				finalText: `${options.role} done`,
				usage: { input: 10, output: 5, cost: 0.001 },
				outputs: options.targets,
				model: "fake/model",
				thinkingLevel: "off",
			};
		};

		let selectCalls = 0;
		const ui = {
			input: async () => "1",
			editor: async (_title: string, prefill?: string) => prefill ?? "",
			select: async () => {
				selectCalls++;
				throw new Error("full-auto must not show a gate");
			},
			confirm: async () => {
				throw new Error("full-auto must not show a confirmation");
			},
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
		};
		const ctx = {
			cwd: dir,
			ui,
			hasUI: true,
			mode: "tui",
			signal: undefined,
			isIdle: () => true,
			scopedModels: [],
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
			sessionManager: {},
			model: undefined,
		};

		const pipeline = new WritingPipeline(ctx as any, store, config, undefined, fakeRunner);
		await pipeline.runNextAction();

		assert.equal(store.book.phase, "done");
		assert.equal(selectCalls, 0);
		assert.equal(store.book.stats.chaptersCompleted, 2);
		assert.ok(existsSync(join(store.root, "exports", "latest.md")));
		assert.ok((store.book.stats.totalUsage.input ?? 0) > 0);
		assert.ok((store.book.stats.totalUsage.output ?? 0) > 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
