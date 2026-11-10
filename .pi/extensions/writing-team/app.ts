import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadTeamConfig } from "./config.ts";
import { BookStore, createBook, listBooks, type BookSummary } from "./state.ts";
import type { Intake, TeamConfig } from "./types.ts";

export interface BackgroundJob {
	label: string;
	startedAt: number;
	controller: AbortController;
	done: boolean;
	error?: string;
}

export class WritingTeamApp {
	active?: BookStore;
	agentDir: string;
	currentJob?: BackgroundJob;
	currentAbort?: AbortController;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	baseConfig(ctx: ExtensionContext): TeamConfig {
		return loadTeamConfig(ctx.cwd, undefined, this.agentDir);
	}

	configFor(ctx: ExtensionContext, store: BookStore): TeamConfig {
		return loadTeamConfig(ctx.cwd, store.book.config, this.agentDir);
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
		return { store, config };
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

	/**
	 * Run a pipeline in the background so the Pi command handler returns
	 * immediately. Only one job may run at a time; this is the same single-flight
	 * guarantee as the role runner.
	 */
	startJob(label: string, runner: (controller: AbortController) => Promise<void>): BackgroundJob {
		if (this.isBusy()) throw new Error(this.busyMessage());
		const controller = new AbortController();
		const job: BackgroundJob = {
			label,
			startedAt: Date.now(),
			controller,
			done: false,
		};
		this.currentJob = job;
		this.currentAbort = controller;
		void (async () => {
			try {
				await runner(controller);
			} catch (error) {
				job.error = error instanceof Error ? error.message : String(error);
			} finally {
				job.done = true;
				if (this.currentJob === job) this.currentJob = undefined;
				if (this.currentAbort === controller) this.currentAbort = undefined;
			}
		})();
		return job;
	}

	abortCurrent(): boolean {
		if (!this.currentAbort) return false;
		this.currentAbort.abort();
		this.currentAbort = undefined;
		return true;
	}
}
