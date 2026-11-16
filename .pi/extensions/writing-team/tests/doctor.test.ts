import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.ts";
import { runDoctor } from "../doctor.ts";
import { computeGateHash } from "../gate-hash.ts";
import { createBook } from "../state.ts";
import type { Intake } from "../types.ts";

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

test("doctor detects artifacts modified after approval", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-doctor-"));
	try {
		const store = createBook(dir, "体检测试", intake(), structuredClone(DEFAULT_CONFIG));
		store.book.phase = "design_gate";
		writeFileSync(join(store.root, "design.md"), "设计".repeat(500));
		writeFileSync(join(store.root, "style-guide.md"), "文风".repeat(100));
		store.recordGate("design", "approved", { artifactHash: computeGateHash(store.root, "design") });
		store.save();

		assert.equal(runDoctor(store).some((issue) => issue.message.includes("确认后被修改")), false);
		writeFileSync(join(store.root, "design.md"), "被外部改过的设计".repeat(100));
		assert.equal(runDoctor(store).some((issue) => issue.message.includes("确认后被修改")), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
