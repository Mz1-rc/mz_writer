import assert from "node:assert/strict";
import test from "node:test";
import { WritingTeamApp } from "../app.ts";

test("background jobs are single-flight and non-blocking", async () => {
	const app = new WritingTeamApp("/tmp/does-not-matter");
	let release: (() => void) | undefined;
	const job = app.startJob("test-job", async () => {
		await new Promise<void>((resolve) => {
			release = resolve;
		});
	});
	assert.equal(app.isBusy(), true);
	assert.equal(job.done, false);
	assert.throws(() => app.startJob("second", async () => undefined), /后台任务运行中/);
	release?.();
	for (let i = 0; i < 20 && app.isBusy(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(app.isBusy(), false);
	assert.equal(job.done, true);
});

test("abortCurrent aborts the running controller", () => {
	const app = new WritingTeamApp("/tmp/does-not-matter");
	let signal: AbortSignal | undefined;
	app.startJob("abort-test", async (controller) => {
		signal = controller.signal;
		await new Promise<void>((resolve) => {
			controller.signal.addEventListener("abort", () => resolve(), { once: true });
		});
	});
	assert.equal(signal?.aborted, false);
	assert.equal(app.abortCurrent(), true);
	assert.equal(signal?.aborted, true);
});
