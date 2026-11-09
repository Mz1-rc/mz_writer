import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadTeamConfig } from "./config.ts";
import { BookStore, createBook, listBooks, type BookSummary } from "./state.ts";
import type { Intake, TeamConfig } from "./types.ts";

export class WritingTeamApp {
	active?: BookStore;
	agentDir: string;
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

	abortCurrent(): boolean {
		if (!this.currentAbort) return false;
		this.currentAbort.abort();
		this.currentAbort = undefined;
		return true;
	}
}
