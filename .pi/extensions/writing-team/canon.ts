import { existsSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { promoteRunArtifacts } from "./artifacts.ts";
import { ensureDir, timestampForId } from "./paths.ts";
import { roleOutputTargets } from "./roles.ts";
import type { BookStore } from "./state.ts";
import type { RunRecord } from "./types.ts";

/** Move a book-relative file/directory into archive/<timestamp>-<label>/. */
export function archiveBookPath(store: BookStore, path: string, label: string): string | undefined {
	const source = join(store.root, path);
	if (!existsSync(source)) return undefined;
	const destinationDir = ensureDir(join(store.root, "archive", `${timestampForId()}-${label}`));
	const destination = join(destinationDir, basename(path));
	renameSync(source, destination);
	return destination;
}

export function archiveBookPaths(store: BookStore, label: string, paths: string[]): string[] {
	const archived: string[] = [];
	for (const path of paths) {
		const destination = archiveBookPath(store, path, label);
		if (destination) archived.push(destination);
	}
	return archived;
}

/** Find the successful archivist run snapshot for a chapter (memory first, then index). */
export function findArchivistRun(store: BookStore, chapter: number): string | undefined {
	for (let i = store.book.runs.length - 1; i >= 0; i--) {
		const run = store.book.runs[i];
		if (isArchivistRun(run, chapter)) return run.id;
	}
	try {
		const lines = readFileSync(join(store.root, ".runs", "index.jsonl"), "utf8").trim().split("\n").reverse();
		for (const line of lines) {
			const run = JSON.parse(line) as RunRecord;
			if (isArchivistRun(run, chapter)) return run.id;
		}
	} catch {
		// index is optional
	}
	return undefined;
}

function isArchivistRun(run: RunRecord, chapter: number): boolean {
	return (
		run.role === "archivist" &&
		run.chapter === chapter &&
		run.status === "success" &&
		run.validation?.ok !== false
	);
}

export interface RestoreContinuityResult {
	runId?: string;
	promoted: string[];
	archived: boolean;
	warning?: string;
}

/**
 * Restore canonical continuity files to their state after `through` chapters.
 * `through <= 0` archives the whole continuity directory (fresh canon).
 */
export function restoreContinuityTo(store: BookStore, through: number): RestoreContinuityResult {
	if (through <= 0) {
		const archived = archiveBookPath(store, "continuity", "continuity-reset");
		return { promoted: [], archived: Boolean(archived) };
	}
	const runId = findArchivistRun(store, through);
	if (!runId) {
		return {
			promoted: [],
			archived: false,
			warning: `找不到第 ${through} 章档案快照，保留现有 continuity/。返工后请重点检查连续性档案是否重复。`,
		};
	}
	const promoted = promoteRunArtifacts(
		join(store.root, ".runs", runId),
		roleOutputTargets("archivist"),
		store.root,
	);
	if (promoted.length === 0) {
		return {
			runId,
			promoted,
			archived: false,
			warning: `第 ${through} 章档案快照为空，保留现有 continuity/。`,
		};
	}
	return { runId, promoted, archived: false };
}
