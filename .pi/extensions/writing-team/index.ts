import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WritingTeamApp } from "./app.ts";
import { registerBookCommand } from "./commands.ts";
import { registerWritingTeamTool } from "./tools.ts";
import { clearStatus, updateStatus } from "./ui.ts";

/**
 * Multi-agent writing team for Pi.
 *
 * The main session is the producer/coordinator. Each role runs in its own
 * nested in-memory AgentSession, one at a time, and writes only its declared
 * artifacts. Human gates are handled by the main session UI.
 */
export default function writingTeamExtension(pi: ExtensionAPI): void {
	const app = new WritingTeamApp(getAgentDir());

	registerBookCommand(pi, app);
	registerWritingTeamTool(pi, app);

	pi.on("session_start", async (_event, ctx) => {
		try {
			const { store } = app.ensure(ctx);
			updateStatus(ctx, store);
		} catch {
			// No book yet: this is a normal first-run state.
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		app.shutdown();
		clearStatus(ctx);
	});
}
