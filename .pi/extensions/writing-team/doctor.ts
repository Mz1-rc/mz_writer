import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOutline } from "./artifacts.ts";
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
			issues.push({ level: "error", message: `运行 ${run.id} 仍标记为 running，可能是异常退出。` });
		}
		if (run.status === "error") {
			issues.push({ level: "warning", message: `运行 ${run.id}（${run.role}）失败：${run.error ?? "未知错误"}` });
		}
	}

	if (book.phase !== "intake" && book.phase !== "idle" && !existsSync(join(store.root, "design.md"))) {
		issues.push({ level: "error", message: "缺少 design.md" });
	}
	if (["outline", "outline_gate", "chapter_plan", "draft", "continuity", "revision", "line_edit", "reader", "chapter_gate", "archive", "final_review", "final_gate", "export", "done"].includes(book.phase)) {
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

	if (book.phase === "final_gate" && !existsSync(join(store.root, "reviews", "final-review.md"))) {
		issues.push({ level: "error", message: "缺少 reviews/final-review.md" });
	}
	if (book.phase === "done" && !existsSync(join(store.root, "exports"))) {
		issues.push({ level: "warning", message: "项目已完成，但 exports/ 不存在" });
	}
	if (issues.length === 0) issues.push({ level: "info", message: "状态与文件检查通过。" });
	return issues;
}
