import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, deepMerge, diffConfig, isWorldbuilderEnabled, loadTeamConfig } from "../config.ts";
import { BookStore, createBook } from "../state.ts";
import type { Intake } from "../types.ts";

test("deep merge keeps defaults", () => {
	const merged = deepMerge(DEFAULT_CONFIG, { defaults: { chapterWords: 5000 }, roles: { writer: { model: "x/y" } } });
	assert.equal(merged.defaults.chapterWords, 5000);
	assert.equal(merged.defaults.maxRevisionRounds, DEFAULT_CONFIG.defaults.maxRevisionRounds);
	assert.equal(merged.roles.writer?.model, "x/y");
});

test("worldbuilder auto detection", () => {
	assert.equal(isWorldbuilderEnabled(DEFAULT_CONFIG, "东方奇幻"), true);
	assert.equal(isWorldbuilderEnabled(DEFAULT_CONFIG, "都市爱情"), false);
	assert.equal(isWorldbuilderEnabled({ ...DEFAULT_CONFIG, defaults: { ...DEFAULT_CONFIG.defaults, enableWorldbuilder: "always" } }, "都市"), true);
});

test("load config from project file", () => {
	const config = loadTeamConfig(process.cwd(), { defaults: { chapterWords: 1234 } });
	assert.equal(config.defaults.chapterWords, 1234);
});

function intake(): Intake {
	return {
		genre: "都市",
		audience: "成年读者",
		premise: "测试",
		themes: [],
		tone: "冷静",
		pov: "第三人称",
		targetWords: 1000,
		chapterWords: 500,
		references: [],
		redLines: [],
		notes: "",
	};
}

test("diffConfig keeps only real overrides", () => {
	assert.deepEqual(diffConfig({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } }), { b: { c: 3 } });
	assert.equal(diffConfig({ a: 1 }, { a: 1 }), undefined);
});

test("book config stores overrides and does not shadow later project config", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-config-"));
	const agentDir = mkdtempSync(join(tmpdir(), "wt-agent-"));
	try {
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi", "writing-team.json"), JSON.stringify({ defaults: { chapterWords: 2000 } }));
		const base = loadTeamConfig(dir, undefined, agentDir);
		const store = createBook(dir, "配置测试", intake(), base);
		store.book.config.defaults.fullAuto = true;
		store.save();

		const raw = JSON.parse(readFileSync(join(store.root, "book.json"), "utf8"));
		assert.equal(raw.config.defaults.fullAuto, true);
		assert.equal(raw.config.defaults.chapterWords, undefined, "inherited values must not be snapshotted");

		writeFileSync(join(dir, ".pi", "writing-team.json"), JSON.stringify({ defaults: { chapterWords: 3000 } }));
		const nextBase = loadTeamConfig(dir, undefined, agentDir);
		const reloaded = BookStore.load(dir, nextBase, store.book.slug);
		assert.equal(reloaded.book.config.defaults.chapterWords, 3000, "later project config must apply");
		assert.equal(reloaded.book.config.defaults.fullAuto, true, "book override must survive");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});
