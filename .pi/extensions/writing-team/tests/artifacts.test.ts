import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactManager, hasBlockingContinuityIssues, parseOutline } from "../artifacts.ts";

test("artifact manager writes only allowed targets", () => {
	const root = mkdtempSync(join(tmpdir(), "wt-art-"));
	try {
		const manager = new ArtifactManager(root, join(root, ".runs", "r1"), ["design.md", "outline.json"]);
		const result = manager.write("design.md", "# 设计\n内容");
		assert.equal(result.chars, 4);
		assert.equal(readFileSync(join(root, "design.md"), "utf8"), "# 设计\n内容");
		assert.ok(existsSync(join(root, ".runs", "r1", "design.md")));
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
