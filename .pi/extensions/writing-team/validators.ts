import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chapterKey, countChars, resolveWithin } from "./paths.ts";
import { chapterTargetWords, parseOutline } from "./outline.ts";
import { roleOutputTargets } from "./roles.ts";
import type { BookProject, RoleId } from "./types.ts";

export interface ContinuityIssue {
	level: "blocker" | "major" | "minor";
	type?: string;
	quote?: string;
	conflict?: string;
	fix?: string;
}

export interface ContinuityReport {
	issues: ContinuityIssue[];
	summary?: string;
}

export interface FinalReviewReport {
	verdict: "PASS" | "REVISE";
	blockers?: string[];
	notes?: string;
}

export interface ValidationContext {
	role: RoleId;
	bookRoot: string;
	targets: string[];
	book: BookProject;
	chapter?: number;
	/** Run directory containing staged artifacts. Validation must prefer it. */
	runDir?: string;
}

function readFileSafe(path: string): string {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : "";
	} catch {
		return "";
	}
}

/**
 * Read an artifact for validation. Staged run outputs take precedence so an
 * invalid attempt never validates against the previous official artifact.
 */
export function readStagedTarget(ctx: ValidationContext, target: string): string {
	if (!ctx.runDir) return "";
	try {
		return readFileSafe(resolveWithin(ctx.runDir, target));
	} catch {
		return "";
	}
}

export function readValidationTarget(ctx: ValidationContext, target: string): string {
	const staged = readStagedTarget(ctx, target);
	if (staged) return staged;
	try {
		return readFileSafe(resolveWithin(ctx.bookRoot, target));
	} catch {
		return "";
	}
}

export function parseContinuityReport(text: string): { ok: true; report: ContinuityReport } | { ok: false; issues: string[] } {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { ok: false, issues: [`continuity.json 不是合法 JSON: ${(error as Error).message}`] };
	}
	if (!value || typeof value !== "object") return { ok: false, issues: ["continuity.json 必须是对象"] };
	const obj = value as Record<string, unknown>;
	if (!Array.isArray(obj.issues)) return { ok: false, issues: ["continuity.json 缺少 issues 数组"] };
	const issues: string[] = [];
	const report: ContinuityReport = { issues: [], summary: typeof obj.summary === "string" ? obj.summary : undefined };
	for (const [index, item] of obj.issues.entries()) {
		if (!item || typeof item !== "object") {
			issues.push(`continuity.json 第 ${index + 1} 个问题不是对象`);
			continue;
		}
		const raw = item as Record<string, unknown>;
		const level = String(raw.level ?? "").toLowerCase();
		if (level !== "blocker" && level !== "major" && level !== "minor") {
			issues.push(`continuity.json 第 ${index + 1} 个问题级别非法: ${String(raw.level ?? "")}`);
			continue;
		}
		report.issues.push({
			level: level as ContinuityIssue["level"],
			type: raw.type ? String(raw.type) : undefined,
			quote: raw.quote ? String(raw.quote) : undefined,
			conflict: raw.conflict ? String(raw.conflict) : undefined,
			fix: raw.fix ? String(raw.fix) : undefined,
		});
	}
	if (issues.length > 0) return { ok: false, issues };
	return { ok: true, report };
}

export function readContinuityReport(bookRoot: string, chapter: number): ContinuityReport | undefined {
	const text = (() => {
		try {
			return readFileSafe(resolveWithin(bookRoot, join("chapters", chapterKey(chapter), "continuity.json")));
		} catch {
			return "";
		}
	})();
	if (!text) return undefined;
	const parsed = parseContinuityReport(text);
	return parsed.ok ? parsed.report : undefined;
}

export function hasBlockingContinuityIssues(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (trimmed.startsWith("{")) {
		const parsed = parseContinuityReport(trimmed);
		if (parsed.ok) return parsed.report.issues.some((issue) => issue.level === "blocker");
	}
	return /\bblocker\b|严重冲突|重大冲突|必须修改|阻断/i.test(trimmed);
}

export function parseFinalReview(text: string): { ok: true; report: FinalReviewReport } | { ok: false; issues: string[] } {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { ok: false, issues: [`final-review.json 不是合法 JSON: ${(error as Error).message}`] };
	}
	if (!value || typeof value !== "object") return { ok: false, issues: ["final-review.json 必须是对象"] };
	const obj = value as Record<string, unknown>;
	const verdict = String(obj.verdict ?? "").toUpperCase();
	if (verdict !== "PASS" && verdict !== "REVISE") {
		return { ok: false, issues: ["final-review.json 的 verdict 必须是 PASS 或 REVISE"] };
	}
	return {
		ok: true,
		report: {
			verdict,
			blockers: Array.isArray(obj.blockers) ? obj.blockers.map(String) : undefined,
			notes: typeof obj.notes === "string" ? obj.notes : undefined,
		},
	};
}

export function readFinalReview(bookRoot: string): FinalReviewReport | undefined {
	const json = (() => {
		try {
			return readFileSafe(resolveWithin(bookRoot, "reviews/final-review.json"));
		} catch {
			return "";
		}
	})();
	if (json) {
		const parsed = parseFinalReview(json);
		if (parsed.ok) return parsed.report;
	}
	const markdown = (() => {
		try {
			return readFileSafe(resolveWithin(bookRoot, "reviews/final-review.md"));
		} catch {
			return "";
		}
	})();
	if (!markdown) return undefined;
	const match = markdown.match(/VERDICT:\s*(PASS|REVISE)/i);
	if (!match) return undefined;
	return { verdict: match[1].toUpperCase() as "PASS" | "REVISE" };
}

export function validateRoleOutputs(ctx: ValidationContext): { ok: boolean; issues: string[] } {
	const issues: string[] = [];
	const read = (target: string): string => readValidationTarget(ctx, target);
	const mustExist = (target: string): string => {
		// Required outputs must exist in this run's staging area; falling back to
		// an old official file would let a partial run pass validation.
		const text = ctx.runDir ? readStagedTarget(ctx, target) : read(target);
		if (!text.trim()) issues.push(`本次运行缺少或为空: ${target}`);
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
			const json = read(ctx.targets[1] ?? `chapters/${chapterKey(ctx.chapter ?? 1)}/continuity.json`);
			const parsed = parseContinuityReport(json);
			if (!parsed.ok) issues.push(...parsed.issues);
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
			const jsonTarget = ctx.targets[1];
			if (jsonTarget) {
				const parsed = parseFinalReview(read(jsonTarget));
				if (!parsed.ok) issues.push(...parsed.issues);
			}
			break;
		}
	}

	return { ok: issues.length === 0, issues };
}

export function requiredTargets(role: RoleId, chapter: number): string[] {
	return roleOutputTargets(role, chapter);
}
