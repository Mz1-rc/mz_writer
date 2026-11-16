import { homedir } from "node:os";
import { join } from "node:path";
import { readJson } from "./paths.ts";
import type { DeepPartial, RoleConfig, RoleId, TeamConfig, ThinkingLevel } from "./types.ts";

export const DEFAULT_CONFIG: TeamConfig = {
	language: "zh-CN",
	storageRoot: "books",
	defaults: {
		thinkingLevel: "high",
		maxRevisionRounds: 3,
		autoRunChapterPipeline: true,
		chapterGate: "each",
		enableWorldbuilder: "auto",
		enableBetaReader: false,
		chapterWords: 3200,
		totalWords: 80000,
		fullAuto: false,
		keepRuns: 200,
	},
	roles: {},
};

export function defaultAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(base: T, patch: unknown): T {
	if (!isPlainObject(base) || !isPlainObject(patch)) {
		return (patch === undefined ? base : patch) as T;
	}
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		const existing = out[key];
		out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
	}
	return out as T;
}

export function loadTeamConfig(
	workspace: string,
	bookOverrides?: DeepPartial<TeamConfig> | undefined,
	agentDir?: string,
): TeamConfig {
	const globalPath = join(agentDir ?? defaultAgentDir(), "writing-team.json");
	const projectPath = join(workspace, ".pi", "writing-team.json");
	let config = deepMerge(DEFAULT_CONFIG, readJson<Partial<TeamConfig>>(globalPath) ?? {});
	config = deepMerge(config, readJson<Partial<TeamConfig>>(projectPath) ?? {});
	if (bookOverrides) config = deepMerge(config, bookOverrides);
	// Never let a config file point outside the workspace or use an unsupported root.
	if (!config.storageRoot || config.storageRoot.includes("..") || config.storageRoot.startsWith("/")) {
		config.storageRoot = DEFAULT_CONFIG.storageRoot;
	}
	return config;
}

/**
 * Compute the minimal override object that turns `base` into `current`.
 * Used so book.json does not persist a full config snapshot that would shadow
 * later global/project configuration changes.
 */
export function diffConfig(base: unknown, current: unknown): DeepPartial<TeamConfig> | undefined {
	if (current === undefined) return undefined;
	if (!isPlainObject(base) || !isPlainObject(current)) {
		return JSON.stringify(base) === JSON.stringify(current) ? undefined : (current as DeepPartial<TeamConfig>);
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(current)) {
		if (value === undefined) continue;
		const baseValue = (base as Record<string, unknown>)[key];
		if (isPlainObject(value) && isPlainObject(baseValue)) {
			const nested = diffConfig(baseValue, value);
			if (nested && Object.keys(nested).length > 0) out[key] = nested;
			continue;
		}
		if (JSON.stringify(baseValue) !== JSON.stringify(value)) out[key] = value;
	}
	if (Object.keys(out).length === 0) return undefined;
	return out as DeepPartial<TeamConfig>;
}

/** Merge a book-level override on top of an effective base config. */
export function mergeBookConfig(base: TeamConfig, overrides: DeepPartial<TeamConfig> | undefined): TeamConfig {
	return overrides ? deepMerge(base, overrides) : structuredClone(base);
}

export function roleConfig(config: TeamConfig, role: RoleId): RoleConfig {
	return config.roles[role] ?? {};
}

export function effectiveThinkingLevel(config: TeamConfig, role: RoleId): ThinkingLevel {
	return roleConfig(config, role).thinkingLevel ?? config.defaults.thinkingLevel;
}

/** Match a configured model id against the model registry. */
export function resolveModel(ctx: any, modelId: string | undefined): { model?: any; warning?: string } {
	if (!modelId) return {};
	const registry = ctx?.modelRegistry;
	if (!registry) return { warning: `没有可用的模型注册表，忽略模型配置 ${modelId}` };
	const candidates: any[] = [];
	const scoped = Array.isArray(ctx?.scopedModels) ? ctx.scopedModels : [];
	for (const item of scoped) {
		if (item?.model) candidates.push(item.model);
	}
	try {
		candidates.push(...(registry.getAll?.() ?? []));
	} catch {
		// ignore registry failures and fall through
	}
	const normalized = modelId.trim();
	for (const model of candidates) {
		const full = `${model.provider}/${model.id}`;
		if (full === normalized || model.id === normalized) return { model };
	}
	if (normalized.includes("/")) {
		const slash = normalized.indexOf("/");
		const provider = normalized.slice(0, slash);
		const id = normalized.slice(slash + 1);
		const found = registry.find?.(provider, id);
		if (found) return { model: found };
	}
	return { warning: `未找到模型 ${modelId}，将回退到主会话模型` };
}

export function isWorldbuilderEnabled(config: TeamConfig, genre: string): boolean {
	const mode = config.defaults.enableWorldbuilder;
	if (mode === "always") return true;
	if (mode === "never") return false;
	return /奇幻|玄幻|科幻|架空|历史|末世|废土|蒸汽|仙侠|悬疑|超自然|fantasy|sci-fi|science fiction|historical/i.test(
		genre,
	);
}

export function isBetaReaderEnabled(config: TeamConfig): boolean {
	return config.defaults.enableBetaReader === true;
}
