import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { countChars, ensureDir, resolveWithin, sha256, writeAtomic } from "./paths.ts";

const BLOCKED_TARGETS = new Set(["book.json", ".lock"]);

export interface ArtifactWriteResult {
	target: string;
	path: string;
	chars: number;
	sha256: string;
}

/**
 * Writes role artifacts into the run staging directory only.
 *
 * Official book files are updated by `commit()` after the whole run has been
 * validated. This keeps failed/aborted runs from corrupting the last good
 * version of an artifact.
 */
export class ArtifactManager {
	readonly bookRoot: string;
	readonly runDir: string;
	readonly targets: string[];
	readonly written = new Map<string, ArtifactWriteResult>();
	private readonly stagedContent = new Map<string, string>();

	constructor(bookRoot: string, runDir: string, targets: string[]) {
		this.bookRoot = bookRoot;
		this.runDir = runDir;
		this.targets = targets;
	}

	write(target: string, content: string, mode: "replace" | "append" = "replace"): ArtifactWriteResult {
		const normalized = target.replaceAll("\\", "/").replace(/^\.\//, "");
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

		const snapshot = resolveWithin(this.runDir, normalized);
		const canonical = resolveWithin(this.bookRoot, normalized);
		let finalContent = content;
		if (mode === "append") {
			const previous = existsSync(snapshot)
				? readFileSync(snapshot, "utf8")
				: existsSync(canonical)
					? readFileSync(canonical, "utf8")
					: "";
			finalContent = `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${content}`;
		}
		ensureDir(dirname(snapshot));
		writeAtomic(snapshot, finalContent);
		this.stagedContent.set(normalized, finalContent);
		const result: ArtifactWriteResult = {
			target: normalized,
			path: canonical,
			chars: countChars(finalContent),
			sha256: sha256(finalContent),
		};
		this.written.set(normalized, result);
		return result;
	}

	/** Promote staged artifacts into the official book files after validation. */
	commit(): ArtifactWriteResult[] {
		const results: ArtifactWriteResult[] = [];
		for (const [target, content] of this.stagedContent) {
			const canonical = resolveWithin(this.bookRoot, target);
			ensureDir(dirname(canonical));
			writeAtomic(canonical, content);
			const existing = this.written.get(target);
			if (existing) results.push(existing);
		}
		return results;
	}

	readStaged(target: string): string | undefined {
		try {
			const path = resolveWithin(this.runDir, target.replaceAll("\\", "/"));
			return existsSync(path) ? readFileSync(path, "utf8") : undefined;
		} catch {
			return undefined;
		}
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

/**
 * Promote run snapshots to official files. Used by tests and recovery paths
 * that validate outside the live ArtifactManager instance.
 */
export function promoteRunArtifacts(runDir: string, targets: string[], bookRoot: string): string[] {
	const promoted: string[] = [];
	for (const target of targets) {
		const normalized = target.replaceAll("\\", "/").replace(/^\.\//, "");
		const snapshot = resolveWithin(runDir, normalized);
		if (!existsSync(snapshot)) continue;
		const content = readFileSync(snapshot, "utf8");
		const canonical = resolveWithin(bookRoot, normalized);
		ensureDir(dirname(canonical));
		writeAtomic(canonical, content);
		promoted.push(normalized);
	}
	return promoted;
}

export function hasStagedArtifact(runDir: string, target: string): boolean {
	try {
		return existsSync(resolveWithin(runDir, target.replaceAll("\\", "/")));
	} catch {
		return false;
	}
}

export { chapterTargetWords, parseOutline, readOutlineManifest } from "./outline.ts";
export {
	hasBlockingContinuityIssues,
	parseContinuityReport,
	parseFinalReview,
	readContinuityReport,
	readFinalReview,
	readValidationTarget,
	requiredTargets,
	validateRoleOutputs,
} from "./validators.ts";
export type { ContinuityIssue, ContinuityReport, FinalReviewReport, ValidationContext } from "./validators.ts";
