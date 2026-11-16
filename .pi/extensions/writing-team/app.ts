import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadTeamConfig } from "./config.ts";
import { BookStore, createBook, listBooks, type BookSummary } from "./state.ts";
import type { Intake, TeamConfig } from "./types.ts";

export interface BackgroundJob {
	label: string;
	startedAt: number;
	controller: AbortController;
	done: boolean;
	background: boolean;
	error?: string;
}

export interface JobResult {
	label: string;
	startedAt: number;
	endedAt: number;
	error?: string;
	background: boolean;
}

export class WritingTeamApp {
	active?: BookStore;
	agentDir: string;
	currentJob?: BackgroundJob;
	currentAbort?: AbortController;
	lastJob?: JobResult;
	private lockedStores = new Set<BookStore>();

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	baseConfig(ctx: ExtensionContext): TeamConfig {
		return loadTeamConfig(ctx.cwd, undefined, this.agentDir);
	}

	/** Effective config already includes book-level overrides. */
	configFor(_ctx: ExtensionContext, store: BookStore): TeamConfig {
		return store.book.config;
	}

	ensure(ctx: ExtensionContext, slug?: string): { store: BookStore; config: TeamConfig } {
		if (!this.active || (slug && this.active.book.slug !== slug)) {
			if (slug) {
				this.active = BookStore.load(ctx.cwd, this.baseConfig(ctx), slug);
			} else if (!this.active) {
				this.active = BookStore.load(ctx.cwd, this.baseConfig(ctx));
			}
		}
		if (!this.active) throw new Error("没有可用的书籍项目");
		return { store: this.active, config: this.configFor(ctx, this.active) };
	}

	setActive(store: BookStore): void {
		this.active = store;
	}

	create(ctx: ExtensionContext, title: string, intake: Intake): { store: BookStore; config: TeamConfig } {
		const config = this.baseConfig(ctx);
		const store = createBook(ctx.cwd, title, intake, config);
		this.active = store;
		return { store, config: store.book.config };
	}

	list(ctx: ExtensionContext): BookSummary[] {
		return listBooks(ctx.cwd, this.baseConfig(ctx));
	}

	isBusy(): boolean {
		return Boolean(this.currentJob && !this.currentJob.done);
	}

	busyMessage(): string {
		const job = this.currentJob;
		if (!job || job.done) return "";
		const seconds = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
		return `后台任务运行中：${job.label}（已运行 ${seconds}s）。可使用 /book status 查看，/book abort 中止。`;
	}

	private beginJob(label: string, store?: BookStore): BackgroundJob {
		if (this.isBusy()) throw new Error(this.busyMessage());
		const controller = new AbortController();
		const job: BackgroundJob = {
			label,
			startedAt: Date.now(),
			controller,
			done: false,
			background: true,
		};
		if (store) {
			store.acquireLock(label);
			this.lockedStores.add(store);
		}
		this.currentJob = job;
		this.currentAbort = controller;
		return job;
	}

	private finishJob(job: BackgroundJob, store?: BookStore): void {
		job.done = true;
		if (store) {
			store.releaseLock();
			this.lockedStores.delete(store);
		}
		this.lastJob = {
			label: job.label,
			startedAt: job.startedAt,
			endedAt: Date.now(),
			error: job.error,
			background: job.background,
		};
		if (this.currentJob === job) this.currentJob = undefined;
		if (this.currentAbort === job.controller) this.currentAbort = undefined;
	}

	/**
	 * Run a pipeline in the background so the Pi command handler returns
	 * immediately. Only one job may run at a time; the book lock is held for the
	 * whole job, not just per role.
	 */
	startJob(label: string, runner: (controller: AbortController) => Promise<void>, store?: BookStore): BackgroundJob {
		const job = this.beginJob(label, store);
		void (async () => {
			try {
				await runner(job.controller);
			} catch (error) {
				job.error = error instanceof Error ? error.message : String(error);
			} finally {
				this.finishJob(job, store);
			}
		})();
		return job;
	}

	/** Run a (usually short) pipeline action under the same exclusive lock. */
	async runExclusive<T>(
		label: string,
		runner: (controller: AbortController) => Promise<T>,
		store?: BookStore,
	): Promise<T> {
		const job = this.beginJob(label, store);
		job.background = false;
		try {
			return await runner(job.controller);
		} catch (error) {
			job.error = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			this.finishJob(job, store);
		}
	}

	/** Run a short synchronous mutation under the book's cross-process lock. */
	withBookLock<T>(store: BookStore, fn: () => T): T {
		store.acquireLock("book-mutation");
		try {
			return fn();
		} finally {
			store.releaseLock();
		}
	}

	abortCurrent(): boolean {
		if (!this.currentAbort) return false;
		this.currentAbort.abort();
		this.currentAbort = undefined;
		return true;
	}

	/** Release every held lock (session shutdown / emergency). */
	releaseLocks(): void {
		for (const store of this.lockedStores) store.forceReleaseLock();
		this.lockedStores.clear();
	}

	shutdown(): void {
		this.abortCurrent();
		this.releaseLocks();
	}
}
