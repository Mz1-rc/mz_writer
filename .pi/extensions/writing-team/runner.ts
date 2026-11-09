import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ArtifactManager } from "./artifacts.ts";
import { createSaveArtifactTool } from "./artifact-tool.ts";
import { ensureDir } from "./paths.ts";
import type { RoleRunOptions, RoleRunResult, RunUsage } from "./types.ts";

function emptyUsage(): RunUsage {
	return { input: 0, output: 0, cost: 0 };
}

function addUsage(total: RunUsage, usage: any): void {
	if (!usage) return;
	total.input += Number(usage.input) || 0;
	total.output += Number(usage.output) || 0;
	total.cost = (total.cost ?? 0) + (Number(usage.cost?.total) || 0);
}

/**
 * Run exactly one role in an isolated, in-memory AgentSession.
 *
 * This function never starts two sessions. The pipeline awaits it before
 * starting the next role, and the role has no tools that could spawn another
 * Pi process.
 */
export async function runRole(options: RoleRunOptions): Promise<RoleRunResult> {
	ensureDir(options.runDir);
	// The chief editor may need to read every chapter. Enable compaction there so
	// long books degrade gracefully instead of overflowing the context window.
	const compaction =
		options.role === "chief_editor"
			? { enabled: true, reserveTokens: 16384, keepRecentTokens: 30000 }
			: { enabled: false };
	const settings = SettingsManager.inMemory({
		compaction,
		retry: { enabled: true, maxRetries: 2 },
	} as any);
	const agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd: options.bookRoot,
		agentDir,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: options.systemPrompt,
		appendSystemPrompt: [],
	});
	await loader.reload();

	const manager = new ArtifactManager(options.bookRoot, options.runDir, options.targets);
	const artifactTool = createSaveArtifactTool(manager, options.onWrite);

	const { session } = await createAgentSession({
		cwd: options.bookRoot,
		agentDir,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(options.bookRoot),
		settingsManager: settings,
		model: options.model as any,
		thinkingLevel: options.thinkingLevel as any,
		tools: ["read", "grep", "find", "ls", "save_artifact"],
		customTools: [artifactTool],
	});

	let streamedChars = 0;
	let preview = "";
	const usage = emptyUsage();
	const unsubscribe = session.subscribe((event: any) => {
		try {
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				const delta = String(event.assistantMessageEvent.delta ?? "");
				streamedChars += delta.length;
				preview = `${preview}${delta}`.slice(-160);
				options.onProgress?.({ kind: "text", chars: streamedChars, text: preview });
			} else if (event.type === "tool_execution_start") {
				options.onProgress?.({ kind: "tool", toolName: event.toolName });
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				addUsage(usage, event.message.usage);
			}
		} catch {
			// Progress observers must never break the role run.
		}
	});

	const onAbort = () => {
		void session.abort().catch(() => undefined);
	};
	if (options.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		await session.prompt(options.taskPrompt);
		const finalText = session.getLastAssistantText() ?? "";
		const model = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
		return {
			finalText,
			usage,
			outputs: [...manager.written.keys()],
			model,
			thinkingLevel: session.thinkingLevel,
		};
	} finally {
		if (options.signal) options.signal.removeEventListener("abort", onAbort);
		unsubscribe();
		session.dispose();
	}
}
