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
import type { ProgressUpdate, RoleRunOptions, RoleRunResult, RunUsage } from "./types.ts";

function emptyUsage(): RunUsage {
	return { input: 0, output: 0, total: 0, cost: 0 };
}

function addUsage(total: RunUsage, usage: any): void {
	if (!usage) return;
	const input = Number(usage.input) || 0;
	const output = Number(usage.output) || 0;
	const cacheRead = Number(usage.cacheRead) || 0;
	const cacheWrite = Number(usage.cacheWrite) || 0;
	total.input += input;
	total.output += output;
	total.total = (total.total ?? 0) + (Number(usage.totalTokens) || input + output + cacheRead + cacheWrite);
	total.cost = (total.cost ?? 0) + (Number(usage.cost?.total) || 0);
}

function describeTool(toolName: string, args: any): string {
	const a = args && typeof args === "object" ? args : {};
	switch (toolName) {
		case "read":
			return `读取 ${a.path ?? "文件"}`;
		case "grep":
			return `搜索「${a.pattern ?? ""}」${a.path ? ` @ ${a.path}` : ""}`;
		case "find":
			return `查找 ${a.pattern ?? ""}${a.path ? ` @ ${a.path}` : ""}`;
		case "ls":
			return `列出 ${a.path ?? "."}`;
		case "save_artifact":
			return `保存 ${a.target ?? "工件"}（${String(a.content ?? "").length} 字符）`;
		default:
			return toolName;
	}
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
	let emit: (update: ProgressUpdate) => void = (update) => options.onProgress?.(update);
	const artifactTool = createSaveArtifactTool(manager, (target, chars) => {
		options.onWrite?.(target, chars);
		emit({ kind: "tool", toolName: "save_artifact", detail: `已保存 ${target}（${chars} 字）` });
	});

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
	let lastContextAt = 0;
	let cachedContext: ReturnType<typeof session.getContextUsage> | undefined;
	emit = (update) => {
		const now = Date.now();
		if (update.kind !== "text" || now - lastContextAt >= 500) {
			try {
				cachedContext = session.getContextUsage();
			} catch {
				cachedContext = undefined;
			}
			lastContextAt = now;
		}
		options.onProgress?.({
			...update,
			usage: { input: usage.input, output: usage.output, total: usage.total, cost: usage.cost },
			contextTokens: cachedContext?.tokens ?? undefined,
			contextWindow: cachedContext?.contextWindow,
			contextPercent: cachedContext?.percent ?? undefined,
		});
	};
	const unsubscribe = session.subscribe((event: any) => {
		try {
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				const delta = String(event.assistantMessageEvent.delta ?? "");
				streamedChars += delta.length;
				preview = `${preview}${delta}`.slice(-160);
				emit({ kind: "text", chars: streamedChars, text: preview, detail: `生成中 ${streamedChars} 字` });
			} else if (event.type === "tool_execution_start") {
				emit({ kind: "tool", toolName: event.toolName, detail: describeTool(event.toolName, event.args) });
			} else if (event.type === "tool_execution_end") {
				const duration = event.durationMs ? ` · ${event.durationMs}ms` : "";
				emit({
					kind: "tool",
					toolName: event.toolName,
					detail: `${event.toolName} ${event.isError ? "失败" : "完成"}${duration}`,
				});
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				addUsage(usage, event.message.usage);
				emit({ kind: "usage", detail: "用量更新" });
			} else if (event.type === "agent_settled") {
				emit({ kind: "status", detail: "角色运行完成" });
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
