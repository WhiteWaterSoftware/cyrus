import { EventEmitter } from "node:events";
import {
	Codex,
	type Thread,
	type ThreadEvent,
	type ThreadItem,
	type ThreadOptions,
	type Usage,
} from "@openai/codex-sdk";
import type { CodexConfigValue } from "../types.js";
import type {
	CodexBackend,
	CodexUserInput,
	NormalizedCodexEvent,
	NormalizedCodexItem,
	NormalizedUsage,
	ResolvedCodexConfig,
} from "./types.js";

function toFiniteNumber(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeUsage(usage: Usage | null | undefined): NormalizedUsage {
	if (!usage) {
		return { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
	}
	return {
		input_tokens: toFiniteNumber(usage.input_tokens),
		output_tokens: toFiniteNumber(usage.output_tokens),
		cached_input_tokens: toFiniteNumber(usage.cached_input_tokens),
	};
}

/**
 * Map a Codex SDK `ThreadItem` to a {@link NormalizedCodexItem}. The SDK exec
 * field names already match the normalized shape, so this is largely a
 * pass-through; `web_search.action` is forwarded when the raw item carries it.
 */
function normalizeExecItem(item: ThreadItem): NormalizedCodexItem {
	const raw = item as unknown as Record<string, unknown>;
	switch (item.type) {
		case "agent_message":
			return { type: "agent_message", id: item.id, text: item.text };
		case "reasoning":
			return { type: "reasoning", id: item.id, text: item.text };
		case "command_execution":
			return {
				type: "command_execution",
				id: item.id,
				command: item.command,
				aggregated_output: item.aggregated_output,
				exit_code: item.exit_code,
				status: item.status,
			};
		case "file_change":
			return {
				type: "file_change",
				id: item.id,
				changes: item.changes,
				status: item.status,
			};
		case "mcp_tool_call":
			return {
				type: "mcp_tool_call",
				id: item.id,
				server: item.server,
				tool: item.tool,
				arguments: item.arguments,
				result: item.result,
				error: item.error,
				status: item.status,
			};
		case "web_search":
			return {
				type: "web_search",
				id: item.id,
				query: item.query,
				action:
					raw.action && typeof raw.action === "object"
						? (raw.action as Record<string, unknown>)
						: undefined,
			};
		case "todo_list":
			return { type: "todo_list", id: item.id, items: item.items };
		case "error":
			return { type: "error", id: item.id, message: item.message };
		default:
			return { type: "unknown", id: (raw.id as string) ?? "" };
	}
}

/**
 * Translate a Codex SDK `ThreadEvent` to a {@link NormalizedCodexEvent}, or
 * null for events the mapper does not consume (`item.updated`, `turn.started`).
 * Exported so the runner can reuse it for its backward-compatible
 * `handleEvent` test shim.
 */
export function normalizeExecEvent(
	event: ThreadEvent,
): NormalizedCodexEvent | null {
	switch (event.type) {
		case "thread.started":
			return { kind: "thread-started", threadId: event.thread_id };
		case "item.started":
			return { kind: "item-started", item: normalizeExecItem(event.item) };
		case "item.completed":
			return { kind: "item-completed", item: normalizeExecItem(event.item) };
		case "turn.completed":
			return { kind: "turn-completed", usage: normalizeUsage(event.usage) };
		case "turn.failed":
			return {
				kind: "turn-failed",
				message: event.error?.message || "Codex execution failed",
			};
		case "error":
			return { kind: "error", message: event.message };
		default:
			return null;
	}
}

/**
 * Backend that drives Codex through the `@openai/codex-sdk` (`codex exec`).
 * One process is spawned per turn and stdin is closed immediately, so there is
 * no mid-turn input channel: {@link supportsSteer} is false.
 */
export class ExecCodexBackend extends EventEmitter implements CodexBackend {
	readonly supportsSteer = false;

	private config: ResolvedCodexConfig | null = null;
	private thread: Thread | null = null;
	private abortController: AbortController | null = null;
	private turnActive = false;

	async open(config: ResolvedCodexConfig): Promise<{ threadId: string }> {
		this.config = config;
		const codex = new Codex({
			...(config.codexPath ? { codexPathOverride: config.codexPath } : {}),
			...(config.env ? { env: config.env } : {}),
			...(this.buildCodexConfig(config)
				? { config: this.buildCodexConfig(config) }
				: {}),
		});

		const threadOptions = this.buildThreadOptions(config);
		this.thread = config.resumeSessionId
			? codex.resumeThread(config.resumeSessionId, threadOptions)
			: codex.startThread(threadOptions);

		// The SDK assigns the real thread id only once the first turn streams a
		// `thread.started` event; surface the resume id (or empty) until then.
		return { threadId: config.resumeSessionId ?? "" };
	}

	async runTurn(input: CodexUserInput[]): Promise<void> {
		if (!this.thread || !this.config) {
			throw new Error("ExecCodexBackend.runTurn called before open()");
		}
		this.abortController = new AbortController();
		this.turnActive = true;
		try {
			const streamed = await this.thread.runStreamed(input, {
				signal: this.abortController.signal,
				...(this.config.outputSchema
					? { outputSchema: this.config.outputSchema }
					: {}),
			});
			for await (const event of streamed.events) {
				this.translateAndEmit(event);
			}
		} finally {
			this.turnActive = false;
		}
	}

	isTurnActive(): boolean {
		return this.turnActive;
	}

	async interrupt(): Promise<void> {
		this.abortController?.abort();
	}

	async close(): Promise<void> {
		this.abortController?.abort();
		this.abortController = null;
		this.thread = null;
	}

	private translateAndEmit(event: ThreadEvent): void {
		const normalized = normalizeExecEvent(event);
		if (normalized) {
			this.emit("event", normalized);
		}
	}

	private buildThreadOptions(config: ResolvedCodexConfig): ThreadOptions {
		return {
			model: config.model,
			sandboxMode: config.sandbox,
			workingDirectory: config.workingDirectory,
			skipGitRepoCheck: config.skipGitRepoCheck,
			approvalPolicy: config.approvalPolicy,
			...(config.modelReasoningEffort
				? { modelReasoningEffort: config.modelReasoningEffort }
				: {}),
			...(config.webSearchMode ? { webSearchMode: config.webSearchMode } : {}),
			...(config.additionalDirectories.length > 0
				? { additionalDirectories: config.additionalDirectories }
				: {}),
		};
	}

	private buildCodexConfig(
		config: ResolvedCodexConfig,
	): Record<string, CodexConfigValue> | undefined {
		const overrides: Record<string, CodexConfigValue> = config.configOverrides
			? { ...config.configOverrides }
			: {};
		if (config.developerInstructions) {
			overrides.developer_instructions = config.developerInstructions;
		}
		return Object.keys(overrides).length > 0 ? overrides : undefined;
	}
}
