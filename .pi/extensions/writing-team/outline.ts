import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWithin } from "./paths.ts";
import type { BookProject, OutlineManifest } from "./types.ts";

/**
 * Structured outline parsing/validation.
 *
 * `outline.json` is the only machine-readable chapter manifest; the state
 * machine must never rely on prose in `outline.md`.
 */
export function parseOutline(text: string): { ok: true; manifest: OutlineManifest } | { ok: false; issues: string[] } {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { ok: false, issues: [`outline.json 不是合法 JSON: ${(error as Error).message}`] };
	}
	if (!value || typeof value !== "object") return { ok: false, issues: ["outline.json 必须是对象"] };
	const obj = value as Record<string, unknown>;
	const chapters = obj.chapters;
	if (!Array.isArray(chapters) || chapters.length === 0) return { ok: false, issues: ["outline.json 缺少 chapters 数组"] };
	const issues: string[] = [];
	const seen = new Set<number>();
	const normalized: OutlineManifest["chapters"] = [];
	for (const [index, item] of chapters.entries()) {
		if (!item || typeof item !== "object") {
			issues.push(`第 ${index + 1} 个章节不是对象`);
			continue;
		}
		const ch = item as Record<string, unknown>;
		const n = Number(ch.n);
		if (!Number.isInteger(n) || n < 1) {
			issues.push(`第 ${index + 1} 个章节的 n 非法`);
			continue;
		}
		if (seen.has(n)) issues.push(`章节号重复: ${n}`);
		seen.add(n);
		normalized.push({
			n,
			title: String(ch.title ?? ""),
			goal: String(ch.goal ?? ""),
			conflict: String(ch.conflict ?? ""),
			turn: String(ch.turn ?? ""),
			hook: String(ch.hook ?? ""),
			pov: String(ch.pov ?? ""),
			targetWords: Number(ch.targetWords) || 3000,
		});
	}
	normalized.sort((a, b) => a.n - b.n);
	const declaredCount = Number(obj.chapterCount);
	const chapterCount = Number.isFinite(declaredCount) && declaredCount > 0 ? declaredCount : normalized.length;

	if (chapterCount !== normalized.length) {
		issues.push(`outline.json 的 chapterCount=${chapterCount} 与 chapters 数量 ${normalized.length} 不一致`);
	}
	if (chapterCount > 1000) issues.push("chapterCount 超过 1000，疑似异常");
	for (const [index, chapter] of normalized.entries()) {
		if (chapter.n !== index + 1) {
			issues.push(`章节号必须从 1 连续递增；第 ${index + 1} 个章节为 ${chapter.n}`);
		}
	}
	if (issues.length > 0) return { ok: false, issues };

	return {
		ok: true,
		manifest: {
			chapterCount,
			acts: Array.isArray(obj.acts) ? (obj.acts as OutlineManifest["acts"]) : undefined,
			chapters: normalized,
		},
	};
}

export function readOutlineManifest(bookRoot: string): OutlineManifest | undefined {
	const text = (() => {
		try {
			const path = resolveWithin(bookRoot, "outline.json");
			return existsSync(path) ? readFileSync(path, "utf8") : "";
		} catch {
			return "";
		}
	})();
	if (!text) return undefined;
	const parsed = parseOutline(text);
	return parsed.ok ? parsed.manifest : undefined;
}

export function chapterTargetWords(bookRoot: string, book: BookProject, chapter: number): number {
	const text = (() => {
		try {
			return readFileSync(join(bookRoot, "outline.json"), "utf8");
		} catch {
			return "";
		}
	})();
	if (text) {
		const parsed = parseOutline(text);
		if (parsed.ok) {
			const item = parsed.manifest.chapters.find((ch) => ch.n === chapter);
			if (item?.targetWords) return item.targetWords;
		}
	}
	return book.intake.chapterWords || book.config.defaults.chapterWords;
}
