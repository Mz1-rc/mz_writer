import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WritingTeamApp } from "../app.ts";
import { DEFAULT_CONFIG } from "../config.ts";
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

test("runExclusive holds the book lock and is single-flight", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-lock-"));
	try {
		const store = createBook(dir, "锁测试", intake(), structuredClone(DEFAULT_CONFIG));
		const app = new WritingTeamApp("/tmp/does-not-matter");
		let during = false;
		await app.runExclusive(
			"test",
			async () => {
				during = store.hasLock();
				assert.equal(app.isBusy(), true);
				await new Promise((resolve) => setTimeout(resolve, 5));
			},
			store,
		);
		assert.equal(during, true);
		assert.equal(store.hasLock(), false);
		assert.equal(app.isBusy(), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
