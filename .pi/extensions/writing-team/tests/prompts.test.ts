import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.ts";
import { buildSystemPrompt, buildTaskPrompt } from "../prompts.ts";
import { roleInputs } from "../role-specs.ts";
import { createBook } from "../state.ts";
import type { Intake } from "../types.ts";

function intake(): Intake {
	return {
		genre: "都市悬疑",
		audience: "成年读者",
		premise: "侦探发现记忆被篡改",
		themes: ["记忆", "身份"],
		tone: "冷峻",
		pov: "第三人称限知",
		targetWords: 8000,
		chapterWords: 777,
		references: ["参考作品甲", "参考作品乙"],
		redLines: ["不写露骨暴力"],
		notes: "这是一条必须传达给架构师的补充说明",
	};
}

test("task prompt carries references, notes and chapter words", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-prompts-"));
	try {
		const store = createBook(dir, "提示词测试", intake(), structuredClone(DEFAULT_CONFIG));
		const prompt = buildTaskPrompt({
			role: "architect",
			book: store.book,
			bookRoot: store.root,
			config: store.book.config,
		});
		assert.match(prompt, /参考作品甲/);
		assert.match(prompt, /参考作品乙/);
		assert.match(prompt, /必须传达给架构师/);
		assert.match(prompt, /单章目标字数：777/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("system prompt combines common rules and role prompt", () => {
	const prompt = buildSystemPrompt("writer");
	assert.match(prompt, /事实优先级/);
	assert.match(prompt, /执笔作者/);
});

test("role inputs are shared by prompt and run records", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-inputs-"));
	try {
		const store = createBook(dir, "输入测试", intake(), structuredClone(DEFAULT_CONFIG));
		writeFileSync(join(store.root, "design.md"), "设计");
		const inputs = roleInputs("worldbuilder", store.root, 1).map((item) => item.path);
		assert.deepEqual(inputs, ["design.md"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
