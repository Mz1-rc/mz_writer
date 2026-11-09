import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chapterKey, countChars, ensureDir, fileStat, isStale, nowIso, readJson, slugify, timestampForId, writeJsonAtomic } from "./paths.ts";
import { DEFAULT_CONFIG, deepMerge } from "./config.ts";
import type {
	BookProject,
	GateId,
	GateRecord,
	Intake,
	OutlineManifest,
	Phase,
	RoleId,
	RunRecord,
	RunUsage,
	TeamConfig,
} from "./types.ts";

const ALLOWED_TRANSITIONS: Record<Phase, Phase[]> = {
	idle: ["intake"],
	intake: ["design"],
	design: ["design_gate"],
	design_gate: ["design", "bible", "outline"],
	bible: ["outline"],
	outline: ["outline_gate"],
	outline_gate: ["outline", "chapter_plan"],
	chapter_plan: ["draft"],
	draft: ["continuity"],
	continuity: ["revision", "line_edit"],
	revision: ["line_edit"],
	line_edit: ["reader", "chapter_gate"],
	reader: ["chapter_gate"],
	chapter_gate: ["revision", "chapter_plan", "archive"],
	archive: ["chapter_plan", "final_review"],
	final_review: ["final_gate"],
	final_gate: ["final_review", "chapter_plan", "export"],
	export: ["done"],
	done: ["export"],
	paused: [],
	error: [],
};

export interface BookSummary {
	slug: string;
	title: string;
	phase: Phase;
	updatedAt: string;
	path: string;
}

function emptyGate(): GateRecord {
	return { status: "pending" };
}

export function emptyUsage(): RunUsage {
	return { input: 0, output: 0, total: 0, cost: 0 };
}

export function booksRoot(workspace: string, config: TeamConfig): string {
	return resolve(workspace, config.storageRoot || "books");
}

export function listBooks(workspace: string, config: TeamConfig): BookSummary[] {
	const root = booksRoot(workspace, config);
	if (!existsSync(root)) return [];
	const out: BookSummary[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const path = join(root, entry.name, "book.json");
		const book = readJson<BookProject>(path);
		if (!book || book.schemaVersion !== 1) continue;
		out.push({ slug: book.slug, title: book.title, phase: book.phase, updatedAt: book.updatedAt, path });
	}
	return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createBook(
	workspace: string,
	title: string,
	intake: Intake,
	config: TeamConfig,
): BookStore {
	const root = booksRoot(workspace, config);
	ensureDir(root);
	let slug = slugify(title || "未命名作品");
	let bookRoot = join(root, slug);
	if (existsSync(bookRoot)) {
		slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
		bookRoot = join(root, slug);
	}
	ensureDir(bookRoot);
	const now = nowIso();
	const book: BookProject = {
		schemaVersion: 1,
		slug,
		title: title.trim() || "未命名作品",
		language: config.language,
		createdAt: now,
		updatedAt: now,
		phase: "intake",
		currentChapter: 1,
		chapterCount: 0,
		intake,
		config,
		gates: {
			design: emptyGate(),
			outline: emptyGate(),
			chapters: {},
			final: emptyGate(),
		},
		stats: {
			words: 0,
			chaptersCompleted: 0,
			totalUsage: emptyUsage(),
		},
		runs: [],
	};
	const store = new BookStore(bookRoot, book);
	store.save();
	return store;
}

export class BookStore {
	readonly root: string;
	book: BookProject;
	private lockHeld = false;

	constructor(root: string, book: BookProject) {
		this.root = root;
		this.book = book;
	}

	static load(workspace: string, config: TeamConfig, slug?: string): BookStore {
		const summaries = listBooks(workspace, config);
		if (summaries.length === 0) throw new Error("当前没有书籍项目，请先运行 /book init");
		let chosen: BookSummary | undefined;
		if (slug) chosen = summaries.find((s) => s.slug === slug);
		else chosen = summaries[0];
		if (!chosen) throw new Error(`找不到书籍项目: ${slug}`);
		const book = readJson<BookProject>(join(chosen.path));
		if (!book || book.schemaVersion !== 1) throw new Error(`书籍状态文件损坏: ${chosen.path}`);
		normalizeBookConfig(book);
		const store = new BookStore(join(booksRoot(workspace, config), chosen.slug), book);
		store.markInterruptedRuns();
		return store;
	}

	static loadByPath(root: string): BookStore {
		const book = readJson<BookProject>(join(root, "book.json"));
		if (!book || book.schemaVersion !== 1) throw new Error(`书籍状态文件损坏: ${root}`);
		normalizeBookConfig(book);
		const store = new BookStore(root, book);
		store.markInterruptedRuns();
		return store;
	}

	get bookPath(): string {
		return join(this.root, "book.json");
	}

	get phase(): Phase {
		return this.book.phase;
	}

	get chapter(): number {
		return this.book.currentChapter;
	}

	save(): void {
		this.book.updatedAt = nowIso();
		writeJsonAtomic(this.bookPath, this.book);
	}

	transition(next: Phase): void {
		const current = this.book.phase;
		if (next === current) return;
		if (next === "paused") {
			if (current === "paused") return;
			this.book.previousPhase = current;
			this.book.phase = "paused";
			this.save();
			return;
		}
		if (current === "paused" && this.book.previousPhase) {
			this.book.phase = this.book.previousPhase;
			this.book.previousPhase = undefined;
			if (this.book.phase === next) {
				this.save();
				return;
			}
		}
		if (next === "error") {
			if (current === "error") return;
			this.book.previousPhase = current;
			this.book.phase = "error";
			this.save();
			return;
		}
		if (current === "error" && this.book.previousPhase) {
			this.book.phase = this.book.previousPhase;
			this.book.previousPhase = undefined;
			if (this.book.phase === next) {
				this.save();
				return;
			}
		}
		const allowed = ALLOWED_TRANSITIONS[this.book.phase] ?? [];
		if (!allowed.includes(next)) {
			throw new Error(`非法阶段迁移: ${this.book.phase} -> ${next}`);
		}
		this.book.phase = next;
		this.save();
	}

	canTransition(next: Phase): boolean {
		if (next === this.book.phase) return true;
		if (next === "paused" || next === "error") return true;
		return (ALLOWED_TRANSITIONS[this.book.phase] ?? []).includes(next);
	}

	pause(): void {
		this.transition("paused");
	}

	resume(): void {
		if (this.book.phase !== "paused" || !this.book.previousPhase) {
			throw new Error("当前不处于暂停状态");
		}
		this.book.phase = this.book.previousPhase;
		this.book.previousPhase = undefined;
		this.save();
	}

	markError(message: string, runId?: string): void {
		this.book.lastError = { runId: runId ?? "unknown", message, at: nowIso() };
		this.transition("error");
		this.save();
	}

	clearError(): void {
		this.book.lastError = undefined;
		this.save();
	}

	markInterruptedRuns(): void {
		if (this.isLockLive()) return;
		let changed = false;
		for (const run of this.book.runs) {
			if (run.status === "running") {
				run.status = "interrupted";
				run.endedAt = nowIso();
				run.error = "进程在运行结束前退出";
				changed = true;
			}
		}
		if (changed) this.save();
	}

	beginRun(role: RoleId, phase: Phase, options: { chapter?: number; feedback?: string; inputFiles: string[] }): RunRecord {
		if (this.book.phase !== phase) this.transition(phase);
		const id = `${timestampForId()}-${role}-${Math.random().toString(36).slice(2, 6)}`;
		const run: RunRecord = {
			id,
			role,
			phase,
			chapter: options.chapter,
			status: "running",
			startedAt: nowIso(),
			inputFiles: options.inputFiles,
			outputFiles: [],
			feedback: options.feedback,
		};
		this.book.runs.push(run);
		this.save();
		return run;
	}

	finishRun(
		id: string,
		patch: Partial<Pick<RunRecord, "status" | "outputFiles" | "usage" | "error" | "model" | "thinkingLevel" | "validation">> & {
			revisionOf?: string;
		},
	): void {
		const run = this.book.runs.find((item) => item.id === id);
		if (!run) return;
		Object.assign(run, patch);
		run.endedAt = nowIso();
		if (run.usage) {
			const usage = this.book.stats.totalUsage;
			usage.total = (usage.total ?? usage.input + usage.output) + (run.usage.total ?? run.usage.input + run.usage.output);
			usage.input += run.usage.input;
			usage.output += run.usage.output;
			usage.cost = (usage.cost ?? 0) + (run.usage.cost ?? 0);
		}
		this.save();
	}

	getRun(id: string): RunRecord | undefined {
		return this.book.runs.find((run) => run.id === id);
	}

	lastRunFor(role: RoleId, chapter?: number): RunRecord | undefined {
		for (let i = this.book.runs.length - 1; i >= 0; i--) {
			const run = this.book.runs[i];
			if (run.role === role && (chapter === undefined || run.chapter === chapter)) return run;
		}
		return undefined;
	}

	gate(gate: GateId, chapter?: number): GateRecord {
		if (gate === "chapter") {
			const key = chapterKey(chapter ?? this.book.currentChapter);
			this.book.gates.chapters[key] ??= emptyGate();
			return this.book.gates.chapters[key];
		}
		return this.book.gates[gate];
	}

	recordGate(gate: GateId, status: GateRecord["status"], options: { chapter?: number; feedback?: string; runId?: string } = {}): void {
		const record = this.gate(gate, options.chapter);
		record.status = status;
		record.decidedAt = nowIso();
		record.feedback = options.feedback;
		record.artifactVersion = options.runId;
		this.save();
	}

	chapterTitle(n: number): string {
		const manifest = this.outline();
		const chapters = Array.isArray(manifest?.chapters) ? manifest.chapters : [];
		return chapters.find((ch) => ch.n === n)?.title ?? `第 ${n} 章`;
	}

	chapterTargetWords(n: number): number {
		const manifest = this.outline();
		const chapters = Array.isArray(manifest?.chapters) ? manifest.chapters : [];
		return chapters.find((ch) => ch.n === n)?.targetWords ?? this.book.config.defaults.chapterWords;
	}

	outline(): OutlineManifest | undefined {
		return readJson<OutlineManifest>(join(this.root, "outline.json"));
	}

	refreshStats(): void {
		const manifest = this.outline();
		const chapterCount = manifest?.chapterCount ?? this.book.chapterCount;
		let words = 0;
		let completed = 0;
		for (let n = 1; n <= chapterCount; n++) {
			const key = chapterKey(n);
			const finalPath = join(this.root, "chapters", key, "final.md");
			const draftPath = join(this.root, "chapters", key, "draft.md");
			const text = readTextSafe(finalPath) ?? readTextSafe(draftPath) ?? "";
			words += countChars(text);
			if (this.book.gates.chapters[key]?.status === "approved") completed++;
		}
		this.book.stats.words = words;
		this.book.stats.chaptersCompleted = completed;
		this.save();
	}

	acquireLock(role: RoleId): void {
		if (this.lockHeld) return;
		const path = join(this.root, ".lock");
		if (existsSync(path)) {
			const info = readJson<{ pid?: number; startedAt?: string; role?: string }>(path);
			const stat = fileStat(path);
			const alive = info?.pid ? isProcessAlive(info.pid) : false;
			const stale = stat ? isStale(stat.mtimeMs) : true;
			if (alive && !stale) {
				throw new Error(
					`另一个会话正在运行（pid ${info?.pid}，角色 ${info?.role ?? "未知"}）。请等待其完成，或删除 ${path}（确认无进程使用后）。`,
				);
			}
			try {
				unlinkSync(path);
			} catch {
				// ignore
			}
		}
		writeFileSync(path, JSON.stringify({ pid: process.pid, role, startedAt: nowIso() }, null, 2), { encoding: "utf8", flag: "wx" });
		this.lockHeld = true;
	}

	releaseLock(): void {
		if (!this.lockHeld) return;
		try {
			unlinkSync(join(this.root, ".lock"));
		} catch {
			// ignore
		}
		this.lockHeld = false;
	}

	hasLock(): boolean {
		return existsSync(join(this.root, ".lock"));
	}

	isLockLive(): boolean {
		const path = join(this.root, ".lock");
		if (!existsSync(path)) return false;
		const info = readJson<{ pid?: number }>(path);
		const stat = fileStat(path);
		if (!info?.pid || !stat) return false;
		return isProcessAlive(info.pid) && !isStale(stat.mtimeMs);
	}
}

function normalizeBookConfig(book: BookProject): void {
	if (!book.config || typeof book.config !== "object") {
		book.config = structuredClone(DEFAULT_CONFIG);
		return;
	}
	book.config = deepMerge(DEFAULT_CONFIG, book.config);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readTextSafe(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}
