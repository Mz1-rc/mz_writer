import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chapterKey, countChars, ensureDir, resolveWithin, sha256, writeAtomic } from "./paths.ts";
import { roleOutputTargets } from "./roles.ts";
import type { BookProject, OutlineManifest, RoleId } from "./types.ts";

const BLOCKED_TARGETS = new Set(["book.json", ".lock"]);

export interface ArtifactWriteResult {
	target: string;
	path: string;
	chars: number;
	sha256: string;
}

export class ArtifactManager {
	readonly bookRoot: string;
	readonly runDir: string;
	readonly targets: string[];
	readonly written = new Map<string, ArtifactWriteResult>();

	constructor(bookRoot: string, runDir: string, targets: string[]) {
		this.bookRoot = bookRoot;
		this.runDir = runDir;
		this.targets = targets;
	}

	write(target: string, content: string, mode: "replace" | "append" = "replace"): ArtifactWriteResult {
		const normalized = target.replaceAll("\\", "/");
		if (BLOCKED_TARGETS.has(normalized)) throw new Error(`禁止写入 ${target}`);
		if (!this.targets.includes(normalized)) {
			throw new Error(`该角色不能写入 ${target}；允许：${this.targets.join(", ")}`);
		}
		if (!content || !content.trim()) throw new Error("内容为空，拒绝写入");
		if (normalized.endsWith(".json")) {
			if (mode === "append") throw new Error("JSON 工件不支持 append，请一次写入完整 JSON");
			try {
				JSON.parse(content);
			} catch (error) {
				throw new Error(`${target} 不是合法 JSON: ${(error as Error).message}`);
			}
		}

		const canonical = resolveWithin(this.bookRoot, normalized);
		const snapshot = resolveWithin(this.runDir, normalized);
		let finalContent = content;
		if (mode === "append") {
			const previous = existsSync(snapshot) ? readFileSync(snapshot, "utf8") : existsSync(canonical) ? readFileSync(canonical, "utf8") : "";
			finalContent = `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${content}`;
		}
		ensureDir(dirname(canonical));
		ensureDir(dirname(snapshot));
		writeAtomic(snapshot, finalContent);
		writeAtomic(canonical, finalContent);
		const result: ArtifactWriteResult = {
			target: normalized,
			path: canonical,
			chars: countChars(finalContent),
			sha256: sha256(finalContent),
		};
		this.written.set(normalized, result);
		return result;
	}

	read(target: string): string | undefined {
		try {
			const path = resolveWithin(this.bookRoot, target);
			return existsSync(path) ? readFileSync(path, "utf8") : undefined;
		} catch {
			return undefined;
		}
	}
}

export interface ValidationContext {
	role: RoleId;
	bookRoot: string;
	targets: string[];
	book: BookProject;
	chapter?: number;
}

export function validateRoleOutputs(ctx: ValidationContext): { ok: boolean; issues: string[] } {
	const issues: string[] = [];
	const read = (target: string): string => {
		try {
			const path = resolveWithin(ctx.bookRoot, target);
			return existsSync(path) ? readFileSync(path, "utf8") : "";
		} catch {
			return "";
		}
	};
	const mustExist = (target: string): string => {
		const text = read(target);
		if (!text.trim()) issues.push(`缺少或为空: ${target}`);
		return text;
	};

	for (const target of ctx.targets) mustExist(target);

	const targetWords = ctx.chapter ? chapterTargetWords(ctx.bookRoot, ctx.book, ctx.chapter) : ctx.book.config.defaults.chapterWords;

	switch (ctx.role) {
		case "architect": {
			const design = read("design.md");
			if (countChars(design) < 800) issues.push("design.md 少于 800 字，可能不完整");
			const style = read("style-guide.md");
			if (countChars(style) < 100) issues.push("style-guide.md 少于 100 字");
			break;
		}
		case "worldbuilder": {
			if (countChars(read("bible.md")) < 500) issues.push("bible.md 少于 500 字");
			break;
		}
		case "outliner": {
			const parsed = parseOutline(read("outline.json"));
			if (!parsed.ok) issues.push(...parsed.issues);
			else {
				if (parsed.manifest.chapterCount !== parsed.manifest.chapters.length) {
					issues.push("outline.json 的 chapterCount 与 chapters 数量不一致");
				}
				for (const chapter of parsed.manifest.chapters) {
					for (const key of ["title", "goal", "conflict", "turn", "hook"] as const) {
						if (!String(chapter[key] ?? "").trim()) issues.push(`第 ${chapter.n} 章缺少 ${key}`);
					}
				}
			}
			break;
		}
		case "chapter_planner": {
			const plan = read(ctx.targets[0]);
			if (countChars(plan) < 300) issues.push("plan.md 少于 300 字");
			break;
		}
		case "writer": {
			const draft = read(ctx.targets[0]);
			if (countChars(draft) < targetWords * 0.7) {
				issues.push(`draft.md 字数 ${countChars(draft)}，低于目标 ${targetWords} 的 70%`);
			}
			if (/TODO|待补|未完待续|\[待定\]/i.test(draft)) issues.push("draft.md 存在占位符或未完成标记");
			break;
		}
		case "continuity_editor": {
			const report = read(ctx.targets[0]);
			if (countChars(report) < 100 && !/无问题|未发现|no issues/i.test(report)) issues.push("continuity.md 内容过短");
			if (!/blocker|major|minor|无问题|未发现|no issues/i.test(report)) {
				issues.push("continuity.md 未包含问题级别或“无问题”结论");
			}
			break;
		}
		case "reviser": {
			const draft = read(join("chapters", chapterKey(ctx.chapter ?? 1), "draft.md"));
			const revised = read(ctx.targets[0]);
			if (draft && countChars(revised) < countChars(draft) * 0.85) issues.push("revised.md 明显短于 draft.md");
			break;
		}
		case "line_editor": {
			const final = read(ctx.targets[0]);
			if (countChars(final) < targetWords * 0.7) issues.push(`final.md 字数 ${countChars(final)}，低于目标 ${targetWords} 的 70%`);
			break;
		}
		case "beta_reader": {
			if (countChars(read(ctx.targets[0])) < 100) issues.push("reader-report.md 内容过短");
			break;
		}
		case "archivist": {
			for (const required of ["continuity/characters.md", "continuity/timeline.md", "continuity/summaries.md"]) {
				if (!read(required).trim()) issues.push(`档案更新缺少 ${required}`);
			}
			break;
		}
		case "chief_editor": {
			const review = read(ctx.targets[0]);
			if (!/VERDICT:\s*(PASS|REVISE)/i.test(review)) issues.push("final-review.md 缺少 VERDICT: PASS/REVISE");
			break;
		}
	}

	return { ok: issues.length === 0, issues };
}

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
	const chapterCount = Number(obj.chapterCount) || normalized.length;
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
	return book.config.defaults.chapterWords;
}


export function requiredTargets(role: RoleId, chapter: number): string[] {
	return roleOutputTargets(role, chapter);
}

export function hasBlockingContinuityIssues(text: string): boolean {
	return /\bblocker\b|\bmajor\b|严重|重大|必须修改|阻断/i.test(text);
}
