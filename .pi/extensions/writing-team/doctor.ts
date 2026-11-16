import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOutline } from "./artifacts.ts";
import { computeGateHash } from "./gate-hash.ts";
import { chapterKey } from "./paths.ts";
import type { BookStore } from "./state.ts";

export interface DoctorIssue {
	level: "error" | "warning" | "info";
	message: string;
}

export function runDoctor(store: BookStore): DoctorIssue[] {
	const issues: DoctorIssue[] = [];
	const book = store.book;

	if (!existsSync(store.bookPath)) issues.push({ level: "error", message: "book.json 缺失" });
	if (store.hasLock()) {
		const lockPath = join(store.root, ".lock");
		try {
			const info = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
			issues.push({ level: "warning", message: `.lock 存在（pid ${info.pid ?? "未知"}）；如果确认没有进程运行，可删除后重试。` });
		} catch {
			issues.push({ level: "warning", message: ".lock 存在且无法解析；确认没有进程运行后可删除。" });
		}
	}
	for (const run of book.runs) {
		if (run.status === "running") {
			if (store.isLockLive()) {
				issues.push({ level: "info", message: `运行 ${run.id}（${run.role}）仍在进行中（锁存活）。` });
			} else {
				issues.push({ level: "error", message: `运行 ${run.id} 仍标记为 running，可能是异常退出。` });
			}
		}
		if (run.status === "error") {
			issues.push({ level: "warning", message: `运行 ${run.id}（${run.role}）失败：${run.error ?? "未知错误"}` });
		}
	}

	const designExpected = !["intake", "idle", "design"].includes(book.phase);
	if (designExpected && !existsSync(join(store.root, "design.md"))) {
		issues.push({ level: "error", message: "缺少 design.md" });
	}
	if (["outline_gate", "chapter_plan", "draft", "continuity", "revision", "line_edit", "reader", "chapter_gate", "archive", "final_review", "final_gate", "export", "done"].includes(book.phase)) {
		const outlinePath = join(store.root, "outline.json");
		if (!existsSync(outlinePath)) {
			issues.push({ level: "error", message: "缺少 outline.json" });
		} else {
			const parsed = parseOutline(readFileSync(outlinePath, "utf8"));
			if (!parsed.ok) issues.push({ level: "error", message: `outline.json 非法：${parsed.issues.join("; ")}` });
			else if (parsed.manifest.chapterCount !== book.chapterCount) {
				issues.push({ level: "warning", message: `book.chapterCount=${book.chapterCount} 与大纲 ${parsed.manifest.chapterCount} 不一致` });
			}
		}
	}

	if (book.chapterCount > 0) {
		for (let n = 1; n <= book.chapterCount; n++) {
			const key = chapterKey(n);
			const gate = book.gates.chapters[key];
			if (gate?.status === "approved" && !existsSync(join(store.root, "chapters", key, "final.md"))) {
				issues.push({ level: "error", message: `第 ${n} 章已确认，但 final.md 缺失` });
			}
			if (n === book.currentChapter && book.phase === "chapter_gate" && !existsSync(join(store.root, "chapters", key, "final.md"))) {
				issues.push({ level: "error", message: `第 ${n} 章在确认阶段，但 final.md 缺失` });
			}
		}
	}

	checkGateHash(store, issues, "design", "设计", book.gates.design);
	checkGateHash(store, issues, "outline", "大纲", book.gates.outline);
	checkGateHash(store, issues, "final", "终审", book.gates.final);

	if (book.chapterCount > 0) {
		for (let n = 1; n <= book.chapterCount; n++) {
			const key = chapterKey(n);
			checkGateHash(store, issues, "chapter", `第 ${n} 章`, book.gates.chapters[key], n);
			if (n <= book.continuityThrough && !existsSync(join(store.root, "continuity", "characters.md"))) {
				issues.push({ level: "error", message: `连续性档案声称可信到第 ${book.continuityThrough} 章，但 continuity/characters.md 缺失` });
				break;
			}
		}
	}
	if (book.continuityThrough > book.chapterCount) {
		issues.push({ level: "warning", message: `continuityThrough=${book.continuityThrough} 超过 chapterCount=${book.chapterCount}` });
	}
	for (let n = book.continuityThrough + 1; n <= book.chapterCount; n++) {
		if (book.gates.chapters[chapterKey(n)]?.status === "approved") {
			issues.push({ level: "error", message: `第 ${n} 章已确认，但连续性档案只到第 ${book.continuityThrough} 章` });
		}
	}

	if (book.phase === "final_gate" && !existsSync(join(store.root, "reviews", "final-review.md"))) {
		issues.push({ level: "error", message: "缺少 reviews/final-review.md" });
	}
	if (book.phase === "done" && !existsSync(join(store.root, "exports"))) {
		issues.push({ level: "warning", message: "项目已完成，但 exports/ 不存在" });
	}
	if (issues.length === 0) issues.push({ level: "info", message: "状态与文件检查通过。" });
	return issues;
}

function checkGateHash(
	store: BookStore,
	issues: DoctorIssue[],
	gate: "design" | "outline" | "chapter" | "final",
	label: string,
	record: { status: string; artifactHash?: string } | undefined,
	chapter?: number,
): void {
	if (!record || record.status !== "approved") return;
	if (!record.artifactHash) {
		issues.push({ level: "warning", message: `${label}已确认，但没有记录工件哈希（可能是旧版本审批）。` });
		return;
	}
	const current = computeGateHash(store.root, gate, chapter ?? 1);
	if (!current) {
		issues.push({ level: "error", message: `${label}已确认，但审批工件缺失。` });
		return;
	}
	if (current !== record.artifactHash) {
		issues.push({ level: "error", message: `${label}的工件在确认后被修改，请重新确认或回滚。` });
	}
}
