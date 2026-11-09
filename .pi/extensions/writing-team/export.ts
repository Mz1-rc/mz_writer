import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chapterKey, countChars, ensureDir, timestampForId, writeAtomic } from "./paths.ts";
import type { BookStore } from "./state.ts";

export interface ExportResult {
	path: string;
	chapters: number;
	words: number;
	missing: number[];
}

export async function exportManuscript(store: BookStore): Promise<ExportResult> {
	const book = store.book;
	const manifest = store.outline();
	const chapterCount = manifest?.chapterCount ?? book.chapterCount;
	const parts: string[] = [];
	const missing: number[] = [];
	let words = 0;
	let chapters = 0;

	const toc: string[] = [];
	const body: string[] = [];

	for (let n = 1; n <= chapterCount; n++) {
		const key = chapterKey(n);
		const title = (Array.isArray(manifest?.chapters) ? manifest.chapters : []).find((ch) => ch.n === n)?.title ?? store.chapterTitle(n);
		const candidates = [
			join(store.root, "chapters", key, "final.md"),
			join(store.root, "chapters", key, "revised.md"),
			join(store.root, "chapters", key, "draft.md"),
		];
		const path = candidates.find((candidate) => existsSync(candidate));
		if (!path) {
			missing.push(n);
			continue;
		}
		const text = readFileSync(path, "utf8").trim();
		if (!text) {
			missing.push(n);
			continue;
		}
		chapters++;
		words += countChars(text);
		toc.push(`${n}. ${title}`);
		body.push(`\n\n# 第 ${n} 章 ${title}\n\n${text}`);
	}

	parts.push(`# ${book.title}`);
	parts.push(
		[
			book.intake.genre ? `- 题材：${book.intake.genre}` : "",
			book.intake.audience ? `- 目标读者：${book.intake.audience}` : "",
			book.intake.premise ? `- 核心卖点：${book.intake.premise}` : "",
			`- 章节：${chapters}/${chapterCount}`,
			`- 字数：约 ${words.toLocaleString()}`,
			`- 导出时间：${new Date().toLocaleString()}`,
		]
			.filter(Boolean)
			.join("\n"),
	);
	if (toc.length) parts.push(`\n## 目录\n\n${toc.join("\n")}`);
	parts.push(body.join(""));

	const dir = ensureDir(join(store.root, "exports"));
	const filename = `${book.slug}-${timestampForId()}.md`;
	const path = join(dir, filename);
	const content = `${parts.join("\n")}\n`;
	writeAtomic(path, content);
	writeAtomic(join(dir, "latest.md"), content);
	return { path, chapters, words, missing };
}
