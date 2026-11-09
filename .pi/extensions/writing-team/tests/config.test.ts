import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, deepMerge, isWorldbuilderEnabled, loadTeamConfig } from "../config.ts";

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
