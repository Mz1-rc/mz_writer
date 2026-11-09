import assert from "node:assert/strict";
import test from "node:test";
import { roleOutputTargets, rolePhase } from "../roles.ts";

test("chapter outputs expand", () => {
	assert.deepEqual(roleOutputTargets("writer", 3), ["chapters/ch003/draft.md"]);
	assert.deepEqual(roleOutputTargets("architect", 1), ["design.md", "style-guide.md"]);
});

test("role phases", () => {
	assert.equal(rolePhase("writer"), "draft");
	assert.equal(rolePhase("chief_editor"), "final_review");
});
