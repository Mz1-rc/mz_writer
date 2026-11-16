import { expandChapterPlaceholder } from "./paths.ts";
import type { GateId, Phase, RoleId, RoleMeta } from "./types.ts";

export const ROLES: Record<RoleId, RoleMeta> = {
	architect: {
		id: "architect",
		label: "故事架构师",
		description: "确定题材、卖点、主题、结构、人物弧、文风与红线",
		outputs: ["design.md", "style-guide.md"],
		phase: "design",
		needsChapter: false,
		gate: "design",
		enabledByDefault: true,
	},
	worldbuilder: {
		id: "worldbuilder",
		label: "世界观设定师",
		description: "构建世界规则、势力、地点、术语与年表",
		outputs: ["bible.md"],
		phase: "bible",
		needsChapter: false,
		enabledByDefault: true,
	},
	outliner: {
		id: "outliner",
		label: "大纲师",
		description: "生成分卷分章大纲与结构化章节清单",
		outputs: ["outline.md", "outline.json"],
		phase: "outline",
		needsChapter: false,
		gate: "outline",
		enabledByDefault: true,
	},
	chapter_planner: {
		id: "chapter_planner",
		label: "章节规划师",
		description: "把大纲拆成场景节拍、POV 与连续性引用",
		outputs: ["chapters/{chapter}/plan.md"],
		phase: "chapter_plan",
		needsChapter: true,
		enabledByDefault: true,
	},
	writer: {
		id: "writer",
		label: "执笔作者",
		description: "根据章节规划和设定写初稿",
		outputs: ["chapters/{chapter}/draft.md"],
		phase: "draft",
		needsChapter: true,
		enabledByDefault: true,
	},
	continuity_editor: {
		id: "continuity_editor",
		label: "连续性编辑",
		description: "检查事实、时间线、人物状态、伏笔与设定冲突",
		outputs: ["chapters/{chapter}/continuity.md", "chapters/{chapter}/continuity.json"],
		phase: "continuity",
		needsChapter: true,
		enabledByDefault: true,
	},
	reviser: {
		id: "reviser",
		label: "修订作者",
		description: "按连续性意见和编辑意见改写章节",
		outputs: ["chapters/{chapter}/revised.md"],
		phase: "revision",
		needsChapter: true,
		enabledByDefault: true,
	},
	line_editor: {
		id: "line_editor",
		label: "文字编辑",
		description: "打磨语言、节奏、对白与文风，产出章节定稿",
		outputs: ["chapters/{chapter}/final.md"],
		phase: "line_edit",
		needsChapter: true,
		enabledByDefault: true,
	},
	beta_reader: {
		id: "beta_reader",
		label: "读者代表",
		description: "以目标读者视角给出体验报告",
		outputs: ["chapters/{chapter}/reader-report.md"],
		phase: "reader",
		needsChapter: true,
		enabledByDefault: false,
	},
	archivist: {
		id: "archivist",
		label: "档案管理员",
		description: "更新人物、时间线、伏笔和章节摘要",
		outputs: [
			"continuity/characters.md",
			"continuity/timeline.md",
			"continuity/threads.md",
			"continuity/world.md",
			"continuity/summaries.md",
		],
		phase: "archive",
		needsChapter: true,
		enabledByDefault: true,
	},
	chief_editor: {
		id: "chief_editor",
		label: "主编",
		description: "全书终审，给出 PASS/REVISE 结论和问题清单",
		outputs: ["reviews/final-review.md", "reviews/final-review.json"],
		phase: "final_review",
		needsChapter: false,
		gate: "final",
		enabledByDefault: true,
	},
};

export const ROLE_ORDER: RoleId[] = [
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
];

export const CHAPTER_ROLES: RoleId[] = [
	"chapter_planner",
	"writer",
	"continuity_editor",
	"reviser",
	"line_editor",
	"beta_reader",
];

export function roleMeta(role: RoleId): RoleMeta {
	return ROLES[role];
}

export function roleOutputTargets(role: RoleId, chapter?: number): string[] {
	const n = chapter ?? 1;
	return ROLES[role].outputs.map((target) => expandChapterPlaceholder(target, n));
}

export function rolePhase(role: RoleId): Phase {
	return ROLES[role].phase;
}

export function producingRoleForGate(gate: GateId): RoleId {
	switch (gate) {
		case "design":
			return "architect";
		case "outline":
			return "outliner";
		case "chapter":
			return "line_editor";
		case "final":
			return "chief_editor";
	}
}

export function gatePhase(gate: GateId): Phase {
	switch (gate) {
		case "design":
			return "design_gate";
		case "outline":
			return "outline_gate";
		case "chapter":
			return "chapter_gate";
		case "final":
			return "final_gate";
	}
}

export function gateForPhase(phase: Phase): GateId | undefined {
	switch (phase) {
		case "design_gate":
			return "design";
		case "outline_gate":
			return "outline";
		case "chapter_gate":
			return "chapter";
		case "final_gate":
			return "final";
		default:
			return undefined;
	}
}

export function roleForPhase(phase: Phase): RoleId | undefined {
	switch (phase) {
		case "design":
			return "architect";
		case "bible":
			return "worldbuilder";
		case "outline":
			return "outliner";
		case "chapter_plan":
			return "chapter_planner";
		case "draft":
			return "writer";
		case "continuity":
			return "continuity_editor";
		case "revision":
			return "reviser";
		case "line_edit":
			return "line_editor";
		case "reader":
			return "beta_reader";
		case "archive":
			return "archivist";
		case "final_review":
			return "chief_editor";
		default:
			return undefined;
	}
}

export function roleLabel(role: RoleId): string {
	return ROLES[role].label;
}
