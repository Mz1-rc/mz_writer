import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactManager, hasBlockingContinuityIssues, parseOutline, validateRoleOutputs } from "../artifacts.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import { createBook } from "../state.ts";
import type { Intake } from "../types.ts";

test("artifact manager writes only allowed targets", () => {
	const root = mkdtempSync(join(tmpdir(), "wt-art-"));
	try {
		const manager = new ArtifactManager(root, join(root, ".runs", "r1"), ["design.md", "outline.json"]);
		const result = manager.write("design.md", "# 设计\n内容");
		assert.equal(result.chars, 4);
		// Two-phase commit: official files are untouched until commit().
		assert.equal(existsSync(join(root, "design.md")), false);
		assert.equal(readFileSync(join(root, ".runs", "r1", "design.md"), "utf8"), "# 设计\n内容");
		manager.commit();
		assert.equal(readFileSync(join(root, "design.md"), "utf8"), "# 设计\n内容");
		assert.throws(() => manager.write("style-guide.md", "x"), /不能写入/);
		assert.throws(() => manager.write("design.md", ""), /内容为空/);
		assert.throws(() => manager.write("outline.json", "{bad", "replace"), /不是合法 JSON/);
		assert.doesNotThrow(() => manager.write("outline.json", '{"chapters":[]}'));
		assert.throws(() => manager.write("outline.json", "{}", "append"), /不支持 append/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("outline parser validates structure", () => {
	const ok = parseOutline(JSON.stringify({ chapterCount: 1, chapters: [{ n: 1, title: "t", goal: "g", conflict: "c", turn: "x", hook: "h" }] }));
	assert.equal(ok.ok, true);
	const bad = parseOutline("{not json");
	assert.equal(bad.ok, false);
});

test("blocking continuity detection", () => {
	assert.equal(hasBlockingContinuityIssues("无问题"), false);
	assert.equal(hasBlockingContinuityIssues("[blocker] 时间线冲突"), true);
	assert.equal(hasBlockingContinuityIssues("[minor] 措辞不一致"), false);
});

test("outline chapter numbers must be contiguous", () => {
	const bad = parseOutline(
		JSON.stringify({
			chapterCount: 2,
			chapters: [
				{ n: 1, title: "t", goal: "g", conflict: "c", turn: "x", hook: "h" },
				{ n: 3, title: "t", goal: "g", conflict: "c", turn: "x", hook: "h" },
			],
		}),
	);
	assert.equal(bad.ok, false);
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

test("validation reads staged output and does not touch official files", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-stage-"));
	try {
		const store = createBook(dir, "暂存测试", intake(), structuredClone(DEFAULT_CONFIG));
		store.book.chapterCount = 1;
		const target = "chapters/ch001/draft.md";
		const runDir = join(store.root, ".runs", "r1");
		const manager = new ArtifactManager(store.root, runDir, [target]);
		manager.write(target, "太短");
		const validation = validateRoleOutputs({
			role: "writer",
			bookRoot: store.root,
			targets: [target],
			book: store.book,
			chapter: 1,
			runDir,
		});
		assert.equal(validation.ok, false);
		assert.equal(existsSync(join(store.root, target)), false, "failed run must not promote");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
