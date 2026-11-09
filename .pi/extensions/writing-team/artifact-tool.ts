import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ArtifactManager } from "./artifacts.ts";

export function createSaveArtifactTool(
	manager: ArtifactManager,
	onWrite?: (target: string, chars: number) => void,
): ToolDefinition {
	return {
		name: "save_artifact",
		label: "保存工件",
		description:
			"把本角色的产出写入指定文件。只能写入本次运行允许的目标；正文必须通过此工具保存，不要在回复中粘贴全文。",
		parameters: Type.Object({
			target: Type.String({ description: `允许的目标：${manager.targets.join(", ")}` }),
			content: Type.String({ description: "完整正文。长章节可分多次 append。" }),
			mode: Type.Optional(
				Type.Union([Type.Literal("replace"), Type.Literal("append")], { description: "默认 replace" }),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params: { target: string; content: string; mode?: "replace" | "append" }) {
			const result = manager.write(params.target, params.content, params.mode ?? "replace");
			onWrite?.(result.target, result.chars);
			return {
				content: [
					{
						type: "text" as const,
						text: `已保存 ${result.target}（${result.chars} 字，sha256 ${result.sha256.slice(0, 12)}）`,
					},
				],
				details: result,
			};
		},
	};
}
