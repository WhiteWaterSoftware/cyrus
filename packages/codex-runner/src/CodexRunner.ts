import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { IAgentRunner, IMessageFormatter, SDKMessage } from "cyrus-core";
import { AppServerCodexBackend } from "./backend/AppServerCodexBackend.js";
import {
	ExecCodexBackend,
	normalizeExecEvent,
} from "./backend/ExecCodexBackend.js";
import type {
	CodexBackend,
	CodexUserInput,
	ResolvedCodexConfig,
} from "./backend/types.js";
import { CodexEventMapper, type MapperContext } from "./CodexEventMapper.js";
import { CodexSkillStager } from "./CodexSkillStager.js";
import { CodexConfigBuilder } from "./config/CodexConfigBuilder.js";
import { buildCodexMcpServersConfig } from "./config/mcpConfigTranslator.js";
import { CodexMessageFormatter } from "./formatter.js";
import type {
	CodexJsonEvent,
	CodexRunnerConfig,
	CodexRunnerEvents,
	CodexSessionInfo,
} from "./types.js";

export declare interface CodexRunner {
	on<K extends keyof CodexRunnerEvents>(
		event: K,
		listener: CodexRunnerEvents[K],
	): this;
	emit<K extends keyof CodexRunnerEvents>(
		event: K,
		...args: Parameters<CodexRunnerEvents[K]>
	): boolean;
}

/**
 * Adapts Codex to Cyrus's {@link IAgentRunner} contract.
 *
 * The runner is a thin orchestrator: it owns session lifecycle and delegates
 * configuration assembly ({@link CodexConfigBuilder}), skill staging
 * ({@link CodexSkillStager}), event→message mapping ({@link CodexEventMapper}),
 * and transport ({@link CodexBackend}) to dedicated collaborators.
 */
export class CodexRunner extends EventEmitter implements IAgentRunner {
	readonly supportsStreamingInput: boolean;

	private config: CodexRunnerConfig;
	private formatter: IMessageFormatter;
	private sessionInfo: CodexSessionInfo | null = null;
	private wasStopped = false;

	private readonly skillStager: CodexSkillStager;
	private readonly mapper: CodexEventMapper;
	private resolvedConfig: ResolvedCodexConfig | null = null;
	private backend: CodexBackend | null = null;

	constructor(config: CodexRunnerConfig) {
		super();
		this.config = config;
		this.formatter = new CodexMessageFormatter();
		this.skillStager = new CodexSkillStager({
			workingDirectory: config.workingDirectory,
			additionalDirectories: config.additionalDirectories,
			skills: config.skills,
			plugins: config.plugins,
		});
		this.mapper = new CodexEventMapper(this.buildMapperContext());
		this.supportsStreamingInput = this.shouldUseAppServer();

		if (config.onMessage) this.on("message", config.onMessage);
		if (config.onError) this.on("error", config.onError);
		if (config.onComplete) this.on("complete", config.onComplete);
	}

	async start(prompt: string): Promise<CodexSessionInfo> {
		return this.startWithPrompt(prompt);
	}

	async startStreaming(initialPrompt?: string): Promise<CodexSessionInfo> {
		return this.startWithPrompt(null, initialPrompt);
	}

	/**
	 * Inject a mid-turn message. With the app-server backend this steers the
	 * active turn (`turn/steer`) so in-flight work is preserved. With the exec
	 * backend there is no input channel, so this throws (callers guard on
	 * {@link supportsStreamingInput}).
	 */
	addStreamMessage(content: string): void {
		const backend = this.backend;
		if (!backend?.supportsSteer || !backend.steer) {
			throw new Error("CodexRunner does not support streaming input messages");
		}
		if (!backend.isTurnActive()) {
			// EdgeWorker only calls this while the runner is running (a turn is in
			// flight); a between-turns comment is delivered as a fresh turn via the
			// resume path instead.
			throw new Error("Cannot stream message: no active Codex turn");
		}
		void backend.steer([{ type: "text", text: content }]).catch((error) => {
			this.emit(
				"error",
				error instanceof Error ? error : new Error(String(error)),
			);
		});
	}

	completeStream(): void {
		// No-op: each turn's input is delivered up front (or via steer); there is
		// no open input stream to close.
	}

	isStreaming(): boolean {
		return (
			this.supportsStreamingInput && (this.backend?.isTurnActive() ?? false)
		);
	}

	private async startWithPrompt(
		stringPrompt?: string | null,
		streamingInitialPrompt?: string,
	): Promise<CodexSessionInfo> {
		if (this.isRunning()) {
			throw new Error("Codex session already running");
		}

		const sessionId = this.config.resumeSessionId || crypto.randomUUID();
		this.sessionInfo = {
			sessionId,
			startedAt: new Date(),
			isRunning: true,
		};
		this.wasStopped = false;
		this.mapper.reset();

		const builder = new CodexConfigBuilder(this.config);
		this.resolvedConfig = await builder.build();
		this.skillStager.stage();

		const prompt = (stringPrompt ?? streamingInitialPrompt ?? "").trim();
		this.backend = this.createBackend();
		this.backend.on("event", (event) => this.mapper.handle(event));

		let caughtError: unknown;
		try {
			await this.backend.open(this.resolvedConfig);
			await this.backend.runTurn(this.toUserInput(prompt));
		} catch (error) {
			caughtError = error;
		} finally {
			this.finalizeSession(caughtError);
		}

		return this.sessionInfo;
	}

	private toUserInput(prompt: string): CodexUserInput[] {
		return prompt ? [{ type: "text", text: prompt }] : [];
	}

	private createBackend(): CodexBackend {
		return this.shouldUseAppServer()
			? new AppServerCodexBackend()
			: new ExecCodexBackend();
	}

	/** Whether this runner should drive Codex via the app-server backend. */
	private shouldUseAppServer(): boolean {
		return this.config.useAppServer ?? process.env.CODEX_USE_APP_SERVER === "1";
	}

	private buildMapperContext(): MapperContext {
		const self = this;
		return {
			get workingDirectory(): string | undefined {
				return self.config.workingDirectory;
			},
			get model(): string | undefined {
				return self.config.model;
			},
			getSessionId: () => self.sessionInfo?.sessionId || "pending",
			getStagedSkillNames: () => self.skillStager.getStagedSkillNames(),
			emitMessage: (message) => self.emit("message", message),
			onThreadStarted: (threadId) => {
				if (self.sessionInfo) {
					self.sessionInfo.sessionId = threadId;
				}
			},
		};
	}

	private finalizeSession(caughtError?: unknown): void {
		if (!this.sessionInfo) {
			this.cleanupRuntimeState();
			return;
		}

		this.sessionInfo.isRunning = false;
		const messages = this.mapper.finalize({
			caughtError,
			wasStopped: this.wasStopped,
		});
		this.emit("complete", messages);
		this.cleanupRuntimeState();
	}

	private cleanupRuntimeState(): void {
		const backend = this.backend;
		this.backend = null;
		if (backend) {
			void backend.close();
		}
		this.skillStager.cleanup();
	}

	stop(): void {
		if (this.sessionInfo?.isRunning) {
			this.wasStopped = true;
		}
		this.cleanupRuntimeState();
	}

	isRunning(): boolean {
		return this.sessionInfo?.isRunning ?? false;
	}

	getMessages(): SDKMessage[] {
		return this.mapper.getMessages();
	}

	getFormatter(): IMessageFormatter {
		return this.formatter;
	}

	// ---- Backward-compatible test shims -------------------------------------
	// These delegate to the extracted collaborators so existing unit tests that
	// reach into private methods keep exercising real behavior.

	/** @internal — staging entry point used by skills tests. */
	protected prepareManagedSkillsForCodex(): void {
		this.skillStager.stage();
	}

	/** @internal — MCP translation entry point used by mcp-config tests. */
	protected buildCodexMcpServersConfig() {
		return buildCodexMcpServersConfig({
			workingDirectory: this.config.workingDirectory,
			mcpConfigPath: this.config.mcpConfigPath,
			mcpConfig: this.config.mcpConfig,
			allowedTools: this.config.allowedTools,
		});
	}

	/** @internal — event mapping entry point used by tool-event tests. */
	protected handleEvent(event: CodexJsonEvent): void {
		this.emit("streamEvent", event);
		const normalized = normalizeExecEvent(event);
		if (normalized) {
			this.mapper.handle(normalized);
		}
	}
}
