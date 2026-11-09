/**
 * Shared types for the writing-team extension.
 *
 * Keep this module free of Pi imports so state/prompt modules can be tested
 * with plain Node.js.
 */

export const ROLE_IDS = [
	"architect",
	"worldbuilder",
	"outliner",
	"chapter_planner",
	"writer",
	"continuity_editor",
	"reviser",
	"line_editor",
	"beta_reader",
	"archivist",
	"chief_editor",
] as const;

export type RoleId = (typeof ROLE_IDS)[number];

export const GATE_IDS = ["design", "outline", "chapter", "final"] as const;
export type GateId = (typeof GATE_IDS)[number];

export type Phase =
	| "idle"
	| "intake"
	| "design"
	| "design_gate"
	| "bible"
	| "outline"
	| "outline_gate"
	| "chapter_plan"
	| "draft"
	| "continuity"
	| "revision"
	| "line_edit"
	| "reader"
	| "chapter_gate"
	| "archive"
	| "final_review"
	| "final_gate"
	| "export"
	| "done"
	| "paused"
	| "error";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RoleConfig {
	enabled?: boolean;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface TeamConfig {
	language: string;
	storageRoot: string;
	defaults: {
		thinkingLevel: ThinkingLevel;
		maxRevisionRounds: number;
		autoRunChapterPipeline: boolean;
		chapterGate: "each" | "milestone" | "none";
		enableWorldbuilder: "auto" | "always" | "never";
		enableBetaReader: boolean;
		chapterWords: number;
		totalWords: number;
		/** 全自动模式：跳过人工闸门确认（仍执行产出校验）。 */
		fullAuto: boolean;
	};
	roles: Partial<Record<RoleId, RoleConfig>>;
}

export interface Intake {
	genre: string;
	audience: string;
	premise: string;
	themes: string[];
	tone: string;
	pov: string;
	targetWords: number;
	chapterWords: number;
	references: string[];
	redLines: string[];
	notes: string;
}

export interface GateRecord {
	status: "pending" | "approved" | "rejected";
	decidedAt?: string;
	feedback?: string;
	artifactVersion?: string;
}

export interface RunUsage {
	input: number;
	output: number;
	/** 供应商报告的 total tokens；缺失时用 input + output。 */
	total?: number;
	cost?: number;
}

export interface RunRecord {
	id: string;
	role: RoleId;
	phase: Phase;
	chapter?: number;
	status: "running" | "success" | "error" | "aborted" | "interrupted";
	startedAt: string;
	endedAt?: string;
	model?: string;
	thinkingLevel?: string;
	inputFiles: string[];
	outputFiles: string[];
	revisionOf?: string;
	feedback?: string;
	usage?: RunUsage;
	error?: string;
	validation?: { ok: boolean; issues: string[] };
}

export interface OutlineChapter {
	n: number;
	title: string;
	goal: string;
	conflict: string;
	turn: string;
	hook: string;
	pov: string;
	targetWords: number;
}

export interface OutlineManifest {
	chapterCount: number;
	acts?: Array<{ name: string; chapters: number[] }>;
	chapters: OutlineChapter[];
}

export interface BookProject {
	schemaVersion: 1;
	slug: string;
	title: string;
	language: string;
	createdAt: string;
	updatedAt: string;

	phase: Phase;
	previousPhase?: Phase;
	currentChapter: number;
	chapterCount: number;

	intake: Intake;
	config: TeamConfig;

	gates: {
		design: GateRecord;
		outline: GateRecord;
		chapters: Record<string, GateRecord>;
		final: GateRecord;
	};

	stats: {
		words: number;
		chaptersCompleted: number;
		totalUsage: RunUsage;
	};

	runs: RunRecord[];
	lastError?: { runId: string; message: string; at: string };
}

export interface RoleMeta {
	id: RoleId;
	label: string;
	description: string;
	/** Static output targets. Chapter roles use the chapter placeholder `{chapter}`. */
	outputs: string[];
	/** Phase used while this role runs. */
	phase: Phase;
	needsChapter: boolean;
	gate?: GateId;
	enabledByDefault: boolean;
}

export interface ProgressUpdate {
	kind: "text" | "tool" | "usage" | "status";
	text?: string;
	chars?: number;
	toolName?: string;
	/** 面向用户的操作详情，例如“读取 chapters/ch001/final.md”。 */
	detail?: string;
	/** 子 Agent 当前上下文 token 数。 */
	contextTokens?: number;
	contextWindow?: number;
	contextPercent?: number;
	/** 当前子 Agent 目前为止的累计用量（不是整个项目）。 */
	usage?: RunUsage;
}

export interface RoleRunResult {
	finalText: string;
	usage: RunUsage;
	outputs: string[];
	model?: string;
	thinkingLevel?: string;
}

export interface RoleRunOptions {
	bookRoot: string;
	role: RoleId;
	systemPrompt: string;
	taskPrompt: string;
	targets: string[];
	runDir: string;
	model?: unknown;
	thinkingLevel?: ThinkingLevel;
	signal?: AbortSignal;
	onProgress?: (update: ProgressUpdate) => void;
	onWrite?: (target: string, chars: number) => void;
}
