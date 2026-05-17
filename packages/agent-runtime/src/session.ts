import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	materializeFolderIntoSandbox,
	materializeRepositoryIntoSandbox,
	syncFolderBackToHost,
} from "./materializers/index.js";
import type {
	AgentSession,
	AgentSessionResult,
	HarnessAdapter,
	NormalizedAgentSessionConfig,
	RunnerSandbox,
	RuntimeCallbacks,
	RuntimeFolderConfig,
	TranscriptEvent,
} from "./types.js";

class AsyncEventBuffer<T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiters: Array<(value: IteratorResult<T>) => void> = [];
	private closed = false;

	push(value: T): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ value, done: false });
			return;
		}
		this.queue.push(value);
	}

	close(): void {
		this.closed = true;
		while (this.waiters.length > 0) {
			this.waiters.shift()?.({ value: undefined, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				const value = this.queue.shift();
				if (value !== undefined) {
					return Promise.resolve({ value, done: false });
				}
				if (this.closed) {
					return Promise.resolve({ value: undefined, done: true });
				}
				return new Promise<IteratorResult<T>>((resolve) => {
					this.waiters.push(resolve);
				});
			},
		};
	}
}

/**
 * Splits incoming chunks into newline-terminated lines for harness adapters
 * to parse. Carries a partial-line buffer between chunks so an event that
 * arrives split across multiple TCP packets is still parsed as one line.
 */
class LineSplitter {
	private buffer = "";

	push(chunk: string, onLine: (line: string) => void): void {
		this.buffer += chunk;
		let nl = this.buffer.indexOf("\n");
		while (nl !== -1) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			const stripped = line.endsWith("\r") ? line.slice(0, -1) : line;
			if (stripped.trim()) onLine(stripped);
			nl = this.buffer.indexOf("\n");
		}
	}

	flush(onLine: (line: string) => void): void {
		const remaining = this.buffer;
		this.buffer = "";
		if (remaining.trim()) onLine(remaining);
	}
}

const DEFAULT_AGENT_SESSIONS_ROOT = join(homedir(), ".cyrus-agent-sessions");

function resolveAgentSessionsRoot(configuredRoot: string | undefined): string {
	const root = configuredRoot ?? DEFAULT_AGENT_SESSIONS_ROOT;
	return isAbsolute(root) ? root : resolve(process.cwd(), root);
}

export class RuntimeAgentSession extends EventEmitter implements AgentSession {
	readonly sessionId: string;
	readonly harness: NormalizedAgentSessionConfig["harness"]["kind"];
	readonly events: AsyncIterable<TranscriptEvent>;

	private readonly eventBuffer = new AsyncEventBuffer<TranscriptEvent>();
	private readonly observedEvents: TranscriptEvent[] = [];
	private readonly queuedMessages: string[] = [];
	private readonly sessionStateDir: string;
	/**
	 * Per-readwrite-folder ledger of files we materialized in, so sync-back
	 * (at session.destroy()) can re-read them even if the agent didn't
	 * touch them.
	 */
	private readonly folderLedger = new Map<
		RuntimeFolderConfig,
		readonly string[]
	>();

	private materializationDone = false;
	private turnCount = 0;
	private sandboxDestroyed = false;
	private sandboxDestroyPromise?: Promise<void>;

	// Per-run state — created fresh in run(), cleared in finally.
	private currentRunAbort?: AbortController;
	private currentInputBuffer?: AsyncEventBuffer<string>;
	private currentRunStreaming = false;

	constructor(
		private readonly config: NormalizedAgentSessionConfig,
		private readonly adapter: HarnessAdapter,
		private readonly sandbox: RunnerSandbox,
		private readonly callbacks: RuntimeCallbacks = {},
	) {
		super();
		this.sessionId = config.sessionId;
		this.harness = adapter.kind;
		this.events = this.eventBuffer;
		this.sessionStateDir = join(
			resolveAgentSessionsRoot(config.agentSessionsRoot),
			this.sessionId,
		);
	}

	/**
	 * Run one turn of the harness. First call materializes files/folders/
	 * repos and runs setup commands; subsequent calls skip all of that and
	 * invoke the harness with its resume flag so it continues the prior
	 * conversation from the session's persistent state backing.
	 */
	async run(userPrompt: string): Promise<AgentSessionResult> {
		const turnIndex = this.turnCount;
		const continueSession = turnIndex > 0;

		const abortCtrl = new AbortController();
		const inputBuffer = new AsyncEventBuffer<string>();
		this.currentRunAbort = abortCtrl;
		this.currentInputBuffer = inputBuffer;

		const eventStartIndex = this.observedEvents.length;
		const startedAt = Date.now();
		let runStopped = false;

		try {
			if (!this.materializationDone) {
				await this.ensureSessionStateDir();
				await this.materializeFiles();
				await this.materializeFolders();
				await this.materializeRepositories();
				await this.runSetupCommands();
				this.materializationDone = true;
			}

			const command = this.adapter.buildCommand(this.config, {
				userPrompt,
				continueSession,
			});
			const fullCommand = [
				command.command,
				...command.args.map(shellQuote),
			].join(" ");
			const env = {
				HOME: this.sessionStateDir,
				...this.config.env,
				...command.env,
				...this.materializeSecrets(),
			};
			const cwd = this.config.sandbox.workingDirectory;

			const canStream =
				typeof this.sandbox.streamCommand === "function" &&
				this.sandbox.capabilities.streamingProcess === true;

			let exitCode: number;
			if (canStream) {
				this.currentRunStreaming = true;
				const stdoutSplitter = new LineSplitter();
				const stderrSplitter = new LineSplitter();
				const inputIterable = this.config.interactiveInput
					? inputBuffer
					: undefined;
				const result = await this.sandbox.streamCommand!(fullCommand, {
					cwd,
					env,
					signal: abortCtrl.signal,
					input: inputIterable,
					onStdout: (chunk) => {
						stdoutSplitter.push(chunk, (line) => {
							const event = this.adapter.parseStdoutLine(line, {
								sessionId: this.sessionId,
								harness: this.harness,
							});
							if (event) void this.emitEvent(event);
						});
					},
					onStderr: (chunk) => {
						stderrSplitter.push(chunk, (line) => {
							const event = this.adapter.parseStderrLine?.(line, {
								sessionId: this.sessionId,
								harness: this.harness,
							});
							if (event) void this.emitEvent(event);
						});
					},
				});
				stdoutSplitter.flush((line) => {
					const event = this.adapter.parseStdoutLine(line, {
						sessionId: this.sessionId,
						harness: this.harness,
					});
					if (event) void this.emitEvent(event);
				});
				stderrSplitter.flush((line) => {
					const event = this.adapter.parseStderrLine?.(line, {
						sessionId: this.sessionId,
						harness: this.harness,
					});
					if (event) void this.emitEvent(event);
				});
				exitCode = result.exitCode;
			} else {
				const result = await this.sandbox.runCommand(fullCommand, { cwd, env });
				await this.parseBufferedOutput(result.stdout, "stdout");
				await this.parseBufferedOutput(result.stderr, "stderr");
				exitCode = result.exitCode;
			}

			runStopped = abortCtrl.signal.aborted;
			this.turnCount += 1;

			const turnEvents = this.observedEvents.slice(eventStartIndex);
			return {
				sessionId: this.sessionId,
				harness: this.harness,
				success: exitCode === 0 && !runStopped,
				exitCode,
				result: this.adapter.extractResult?.(turnEvents),
				events: turnEvents,
				destroy: () => this.destroy(),
			};
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			const failedEvent = this.createEvent("error", {
				message: err.message,
				durationMs: Date.now() - startedAt,
			});
			await this.emitEvent(failedEvent);
			const turnEvents = this.observedEvents.slice(eventStartIndex);
			return {
				sessionId: this.sessionId,
				harness: this.harness,
				success: false,
				error: err,
				events: turnEvents,
				destroy: () => this.destroy(),
			};
		} finally {
			this.currentRunStreaming = false;
			inputBuffer.close();
			this.currentInputBuffer = undefined;
			this.currentRunAbort = undefined;
		}
	}

	async addMessage(message: string): Promise<void> {
		this.queuedMessages.push(message);
		await this.emitEvent(this.createEvent("message.queued", { message }));
		// Route into the current run's stdin only when interactive input is on
		// AND a run is actively streaming. Outside a run, messages stay in
		// the queue (observable via getQueuedMessages()) — callers can drain
		// them or feed them to the next run() themselves.
		if (
			this.currentRunStreaming &&
			this.config.interactiveInput &&
			this.currentInputBuffer
		) {
			const wire = message.endsWith("\n") ? message : `${message}\n`;
			this.currentInputBuffer.push(wire);
		}
	}

	async interrupt(reason?: string): Promise<void> {
		await this.emitEvent(this.createEvent("interrupt.requested", { reason }));
	}

	async stop(reason?: string): Promise<void> {
		// Per-run cancel only. Does NOT destroy the sandbox or close the
		// session-wide event stream — those live until destroy().
		if (!this.currentRunAbort) return;
		await this.emitEvent(this.createEvent("stop.requested", { reason }));
		this.currentRunAbort.abort();
		this.currentInputBuffer?.close();
	}

	async destroy(): Promise<void> {
		// If a run is still in flight, cancel it first so the harness exits.
		if (this.currentRunAbort) {
			await this.stop("destroy");
		}
		// Sync any read-write folders back to the host before the sandbox
		// disappears — last chance to capture the agent's edits.
		await this.syncFoldersBack();
		await this.destroySandboxOnce();
		this.eventBuffer.close();
	}

	/**
	 * Idempotent sandbox teardown. Backs both `AgentSession.destroy()` and
	 * `AgentSessionResult.destroy()`, so callers can call either or both
	 * without double-destroying the underlying sandbox.
	 */
	private async destroySandboxOnce(): Promise<void> {
		if (this.sandboxDestroyed) return;
		if (this.sandboxDestroyPromise) {
			await this.sandboxDestroyPromise;
			return;
		}
		this.sandboxDestroyPromise = (async () => {
			try {
				await this.sandbox.destroy();
			} finally {
				this.sandboxDestroyed = true;
			}
		})();
		await this.sandboxDestroyPromise;
	}

	getQueuedMessages(): readonly string[] {
		return this.queuedMessages;
	}

	private async parseBufferedOutput(
		output: string,
		stream: "stdout" | "stderr",
	): Promise<void> {
		for (const line of output.split(/\r?\n/)) {
			if (!line.trim()) {
				continue;
			}
			const event =
				stream === "stdout"
					? this.adapter.parseStdoutLine(line, {
							sessionId: this.sessionId,
							harness: this.harness,
						})
					: this.adapter.parseStderrLine?.(line, {
							sessionId: this.sessionId,
							harness: this.harness,
						});
			if (event) {
				await this.emitEvent(event);
			}
		}
	}

	private createEvent(kind: string, raw: unknown): TranscriptEvent {
		return {
			sessionId: this.sessionId,
			harness: this.harness,
			timestamp: new Date().toISOString(),
			kind,
			raw,
		};
	}

	private async emitEvent(event: TranscriptEvent): Promise<void> {
		this.observedEvents.push(event);
		this.eventBuffer.push(event);
		this.emit("transcript", event);
		await this.callbacks.onTranscriptEvent?.(event);
	}

	/**
	 * Ensure the per-session state-backing directory exists on the host.
	 * The harness process's HOME is set to this directory so that, for
	 * Claude / Codex / Gemini, the per-session `.claude` / `.codex` /
	 * `.gemini` subdir is isolated and resumable.
	 */
	private async ensureSessionStateDir(): Promise<void> {
		await mkdir(this.sessionStateDir, { recursive: true });
		// For each state directory the harness declares, pre-create it so
		// the harness CLI doesn't fail on first write to a missing parent.
		for (const rel of this.adapter.stateDirectories) {
			await mkdir(join(this.sessionStateDir, rel), { recursive: true });
		}
	}

	private async materializeFiles(): Promise<void> {
		for (const file of this.config.files ?? []) {
			await this.emitEvent(
				this.createEvent("file.write.started", {
					path: file.path,
					sensitive: file.sensitive ?? false,
				}),
			);
			await this.sandbox.filesystem.mkdir(dirname(file.path));
			await this.sandbox.filesystem.writeFile(file.path, file.content);
			await this.emitEvent(
				this.createEvent("file.write.completed", {
					path: file.path,
					bytes: file.content.length,
					content: file.sensitive ? "[redacted]" : file.content,
				}),
			);
		}
	}

	private async materializeFolders(): Promise<void> {
		for (const folder of this.config.folders ?? []) {
			const access = folder.access ?? "read";
			await this.emitEvent(
				this.createEvent("folder.materialize.started", {
					source: folder.source,
					mountPath: folder.mountPath,
					access,
					exclude: folder.exclude,
				}),
			);
			try {
				const result = await materializeFolderIntoSandbox(folder, this.sandbox);
				if (access === "readwrite") {
					this.folderLedger.set(folder, result.filesWritten);
				}
				await this.emitEvent(
					this.createEvent("folder.materialize.completed", {
						source: folder.source,
						mountPath: folder.mountPath,
						access,
						filesWritten: result.filesWritten.length,
						bytes: result.bytes,
					}),
				);
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				await this.emitEvent(
					this.createEvent("folder.materialize.failed", {
						source: folder.source,
						mountPath: folder.mountPath,
						access,
						error: err.message,
					}),
				);
				throw err;
			}
		}
	}

	private async materializeRepositories(): Promise<void> {
		const env = {
			...this.config.env,
			...this.materializeSecrets(),
		};
		for (const repo of this.config.repositories ?? []) {
			const access = repo.access ?? "readwrite";
			await this.emitEvent(
				this.createEvent("repository.materialize.started", {
					source: repo.source,
					mountPath: repo.mountPath,
					branch: repo.branch,
					access,
					depth: repo.depth,
				}),
			);
			try {
				const result = await materializeRepositoryIntoSandbox(
					repo,
					this.sandbox,
					env,
				);
				await this.emitEvent(
					this.createEvent("repository.materialize.completed", {
						source: repo.source,
						mountPath: repo.mountPath,
						branch: repo.branch,
						access,
						depth: result.depth,
						resolvedSource: result.resolvedSource,
					}),
				);
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				await this.emitEvent(
					this.createEvent("repository.materialize.failed", {
						source: repo.source,
						mountPath: repo.mountPath,
						branch: repo.branch,
						access,
						error: err.message,
					}),
				);
				throw err;
			}
		}
	}

	private async syncFoldersBack(): Promise<void> {
		for (const [folder, originalFiles] of this.folderLedger.entries()) {
			await this.emitEvent(
				this.createEvent("folder.syncback.started", {
					source: folder.source,
					mountPath: folder.mountPath,
				}),
			);
			try {
				const result = await syncFolderBackToHost(
					folder,
					this.sandbox,
					originalFiles,
				);
				await this.emitEvent(
					this.createEvent("folder.syncback.completed", {
						source: folder.source,
						mountPath: folder.mountPath,
						filesWritten: result.filesWritten.length,
						bytes: result.bytes,
					}),
				);
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				await this.emitEvent(
					this.createEvent("folder.syncback.failed", {
						source: folder.source,
						mountPath: folder.mountPath,
						error: err.message,
					}),
				);
				// Sync-back failures are non-fatal — the agent's work in-sandbox
				// already completed; we surface the error in the transcript and
				// keep going.
			}
		}
		this.folderLedger.clear();
	}

	private async runSetupCommands(): Promise<void> {
		const commands = [
			...(this.config.packages?.system?.map(
				(pkg) => `apt-get update && apt-get install -y ${shellQuote(pkg)}`,
			) ?? []),
			...(this.config.packages?.npm?.map(
				(pkg) => `npm install -g ${shellQuote(pkg)}`,
			) ?? []),
			...(this.config.packages?.commands ?? []),
		];

		for (const setupCommand of commands) {
			await this.emitEvent(
				this.createEvent("setup.started", { command: setupCommand }),
			);
			const result = await this.sandbox.runCommand(setupCommand, {
				cwd: this.config.sandbox.workingDirectory,
				env: {
					...this.config.env,
					...this.materializeSecrets(),
				},
			});
			await this.emitEvent(
				this.createEvent("setup.completed", {
					command: setupCommand,
					exitCode: result.exitCode,
					stdout: result.stdout,
					stderr: result.stderr,
				}),
			);
			if (result.exitCode !== 0) {
				throw new Error(
					`Setup command failed with exit code ${result.exitCode}: ${setupCommand}`,
				);
			}
		}
	}

	private materializeSecrets(): Record<string, string> {
		const entries = Object.entries(this.config.secrets).map(([key, secret]) => [
			key,
			secret.value,
		]);
		return Object.fromEntries(entries);
	}
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
		return value;
	}
	return `'${value.replaceAll("'", "'\\''")}'`;
}
