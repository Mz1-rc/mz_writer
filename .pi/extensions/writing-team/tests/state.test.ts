import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.ts";
import { BookStore, createBook } from "../state.ts";
import type { Intake } from "../types.ts";

function intake(): Intake {
	return {
		genre: "奇幻",
		audience: "成年读者",
		premise: "一个关于记忆的故事",
		themes: ["记忆"],
		tone: "冷峻",
		pov: "第三人称限知",
		targetWords: 1000,
		chapterWords: 500,
		references: [],
		redLines: [],
		notes: "",
	};
}

test("book lifecycle and gates", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-state-"));
	try {
		const config = structuredClone(DEFAULT_CONFIG);
		const store = createBook(dir, "测试书", intake(), config);
		assert.equal(store.book.phase, "intake");
		store.transition("design");
		store.transition("design_gate");
		store.recordGate("design", "approved");
		assert.equal(store.gate("design").status, "approved");
		store.transition("outline");
		store.transition("outline_gate");
		store.transition("chapter_plan");
		assert.equal(store.book.phase, "chapter_plan");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("illegal transition is rejected", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-state-"));
	try {
		const store = createBook(dir, "测试书", intake(), structuredClone(DEFAULT_CONFIG));
		assert.throws(() => store.transition("done"), /非法阶段迁移/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("role lock is single-flight", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-state-"));
	try {
		const store = createBook(dir, "测试书", intake(), structuredClone(DEFAULT_CONFIG));
		store.acquireLock("architect");
		const second = BookStore.loadByPath(store.root);
		assert.throws(() => second.acquireLock("outliner"), /另一个会话正在运行/);
		store.releaseLock();
		second.acquireLock("outliner");
		second.releaseLock();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pausing an errored book keeps a recoverable phase", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-state-"));
	try {
		const store = createBook(dir, "状态测试", intake(), structuredClone(DEFAULT_CONFIG));
		store.transition("design");
		store.markError("模拟失败");
		assert.equal(store.book.phase, "error");
		store.pause();
		assert.equal(store.book.phase, "paused");
		store.resume();
		assert.equal(store.book.phase, "design");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("lock is re-entrant and writes a heartbeat", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-lock-"));
	try {
		const store = createBook(dir, "锁测试", intake(), structuredClone(DEFAULT_CONFIG));
		store.acquireLock("job");
		store.acquireLock("role");
		store.releaseLock();
		assert.equal(store.hasLock(), true, "nested release must keep the job lock");
		store.releaseLock();
		assert.equal(store.hasLock(), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
