import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chapterKey, sha256 } from "./paths.ts";
import type { GateId } from "./types.ts";

/** Artifact files whose contents define a gate's approved version. */
export function gateArtifactPaths(gate: GateId, chapter = 1): string[] {
	switch (gate) {
		case "design":
			return ["design.md", "style-guide.md"];
		case "outline":
			return ["outline.md", "outline.json"];
		case "chapter": {
			const key = chapterKey(chapter);
			return [`chapters/${key}/final.md`];
		}
		case "final":
			return ["reviews/final-review.md", "reviews/final-review.json"];
	}
}

/** Hash of all existing gate artifacts; undefined when nothing exists yet. */
export function computeGateHash(bookRoot: string, gate: GateId, chapter = 1): string | undefined {
	const parts: string[] = [];
	for (const rel of gateArtifactPaths(gate, chapter)) {
		const path = join(bookRoot, rel);
		if (!existsSync(path)) continue;
		parts.push(`===== ${rel} =====\n${readFileSync(path, "utf8")}`);
	}
	if (parts.length === 0) return undefined;
	return sha256(parts.join("\n\n"));
}
