import type { AgentSession, TranscriptEvent } from "cyrus-agent-runtime";
import { createAgentSession } from "cyrus-agent-runtime";
import type { ILogger } from "cyrus-core";
import { createLogger } from "cyrus-core";

/**
 * Generic chat platform adapter for the agent-runtime-backed handler.
 *
 * NOTE: `postReply` here takes a plain string (the final assistant text
 * extracted by the harness adapter), not an `IAgentRunner`. This decouples
 * platform adapters from the runner machinery — they only need to know how
 * to convert agent output back into a platform message.
 */
export type ChatPlatformName = "slack" | "linear" | "github";

export interface ChatPlatformAdapter<TEvent> {
	readonly platformName: ChatPlatformName;
	extractTaskInstructions(event: TEvent): string;
	getThreadKey(event: TEvent): string;
	getEventId(event: TEvent): string;
	buildSystemPrompt(event: TEvent): string;
	fetchThreadContext(event: TEvent): Promise<string>;
	postReply(event: TEvent, finalText: string): Promise<void>;
	acknowledgeReceipt(event: TEvent): Promise<void>;
	notifyBusy(event: TEvent, threadKey: string): Promise<void>;
}

export interface AgentChatSessionHandlerDeps {
	onWebhookStart: () => void;
	onWebhookEnd: () => void;
	onError: (error: Error) => void;
	/**
	 * How long a thread's warm session can sit idle before the handler
	 * destroys it (sandbox torn down, slot freed). Default 15 minutes.
	 * Next mention after eviction starts a fresh sandbox + fresh Claude
	 * session.
	 */
	idleTtlMs?: number;
}

const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Default Daytona working directory — matches the directory used in the
// streaming spike that validated this end-to-end. Daytona's container puts
// the user at /home/daytona.
const DAYTONA_WORKING_DIR = "/home/daytona";

// Where claude lands after `npm install -g` with our custom npm prefix.
const CLAUDE_CLI_PATH = `${DAYTONA_WORKING_DIR}/.npm-global/bin/claude`;

// Setup commands that run inside the fresh Daytona sandbox before the
// harness invocation. Each runs via the sandbox's default shell PATH.
const DAYTONA_CLAUDE_SETUP_COMMANDS = [
	`npm config set prefix ${DAYTONA_WORKING_DIR}/.npm-global`,
	"npm install -g @anthropic-ai/claude-code@latest >/dev/null 2>&1",
	`${CLAUDE_CLI_PATH} --version`,
];

// Guard against multiple compute.setConfig() calls — ComputeSDK uses a
// module-global config so we only need to set it once per process.
let computeConfigured = false;

async function configureDaytonaCompute(apiKey: string): Promise<void> {
	if (computeConfigured) return;
	const { daytona } = await import("@computesdk/daytona");
	const { compute } = await import("computesdk");
	compute.setConfig({
		provider: daytona({ apiKey, timeout: 300_000 }),
	});
	computeConfigured = true;
}

interface ThreadState<TEvent> {
	session: AgentSession;
	lastActivityAt: number;
	/**
	 * In-flight run promise, if any. Used so a second webhook for the
	 * same thread can detect "busy" without racing on session.run().
	 */
	inFlight?: Promise<unknown>;
	/** Last event the handler answered for; used as the busy-notify target. */
	lastEvent: TEvent;
}

/**
 * Chat-session handler built on top of `cyrus-agent-runtime`'s
 * `createAgentSession` + multi-turn `session.run()`. Replaces the old
 * `ChatSessionHandler` + `IAgentRunner` + `AgentSessionManager` stack.
 *
 * **Hardwired to Daytona + Claude.** First message in a thread spawns a
 * fresh Daytona sandbox and installs `@anthropic-ai/claude-code` inside it.
 * The sandbox is kept warm; follow-up messages reuse it via Claude's
 * `--continue` flag (the runtime sets the session's HOME to a persistent
 * per-session directory so `.claude/` survives between turns). After an
 * idle TTL the handler destroys the sandbox and frees the slot.
 *
 * Requires the following environment variables:
 *
 * - `DAYTONA_API_KEY` — sandbox provider auth (refuses to construct without).
 * - `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_AUTH_TOKEN`) — Claude auth
 *   inside the sandbox.
 *
 * Brutal cuts compared to the legacy `ChatSessionHandler` (deliberate,
 * spike-only):
 *
 * - **No mid-flight stream injection.** A second message while the thread's
 *   session is still answering the first triggers `notifyBusy()` rather
 *   than injecting into stdin. Future work: route through
 *   `AgentSession.addMessage()` with `interactiveInput: true`.
 * - **No MCP servers.** `cyrus-agent-runtime` doesn't yet wire them through
 *   to the harness CLI; the cyrus-tools in-process SDK server wouldn't
 *   translate across the subprocess boundary anyway. Slack chat runs with
 *   the Claude CLI default toolset only.
 * - **Claude harness only.** No runner-selection layer.
 * - **Daytona compute only.** No local-sandbox fallback for chat.
 * - **No cross-process recovery.** EdgeWorker restart drops the warm-thread
 *   map; next mention is a cold start. Daytona's own autoStopInterval
 *   eventually reclaims any orphaned sandboxes.
 */
export class AgentChatSessionHandler<TEvent> {
	private readonly adapter: ChatPlatformAdapter<TEvent>;
	private readonly deps: AgentChatSessionHandlerDeps;
	private readonly logger: ILogger;
	private readonly threadSessions = new Map<string, ThreadState<TEvent>>();
	private readonly daytonaApiKey: string;
	private readonly idleTtlMs: number;
	private idleSweepTimer?: NodeJS.Timeout;
	private shuttingDown = false;

	constructor(
		adapter: ChatPlatformAdapter<TEvent>,
		deps: AgentChatSessionHandlerDeps,
		logger?: ILogger,
	) {
		this.adapter = adapter;
		this.deps = deps;
		this.logger =
			logger ?? createLogger({ component: "AgentChatSessionHandler" });

		const apiKey = process.env.DAYTONA_API_KEY?.trim();
		if (!apiKey) {
			throw new Error(
				"AgentChatSessionHandler requires DAYTONA_API_KEY in the environment. " +
					"Set it before starting Cyrus or disable the Slack integration.",
			);
		}
		this.daytonaApiKey = apiKey;
		this.idleTtlMs = deps.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;

		// Sweep every minute; sweep work is cheap (just a map iteration + maybe
		// a destroy() per expired entry).
		this.idleSweepTimer = setInterval(() => {
			void this.sweepIdle();
		}, 60_000);
		this.idleSweepTimer.unref?.();
	}

	/** Returns true if any thread on this handler has an in-flight session. */
	isAnyRunnerBusy(): boolean {
		for (const state of this.threadSessions.values()) {
			if (state.inFlight) return true;
		}
		return false;
	}

	/** Test/inspection: enumerate active threads. */
	listThreads(): Array<{ threadKey: string; sessionId: string }> {
		return Array.from(this.threadSessions.entries()).map(
			([threadKey, state]) => ({
				threadKey,
				sessionId: state.session.sessionId,
			}),
		);
	}

	async handleEvent(event: TEvent): Promise<void> {
		this.deps.onWebhookStart();
		try {
			const eventId = this.adapter.getEventId(event);
			const threadKey = this.adapter.getThreadKey(event);
			this.logger.info(
				`Processing ${this.adapter.platformName} webhook: ${eventId} (thread ${threadKey})`,
			);

			// Fire-and-forget acknowledgement (e.g. emoji reaction).
			this.adapter.acknowledgeReceipt(event).catch((err: unknown) => {
				this.logger.warn(
					`Failed to acknowledge ${this.adapter.platformName} event: ${err instanceof Error ? err.message : err}`,
				);
			});

			// Busy thread → notify and bail. No stdin injection today.
			const existing = this.threadSessions.get(threadKey);
			if (existing?.inFlight) {
				this.logger.info(
					`Thread ${threadKey} has an in-flight session; notifying user.`,
				);
				await this.adapter.notifyBusy(event, threadKey);
				return;
			}

			const claudeToken =
				process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ||
				process.env.ANTHROPIC_AUTH_TOKEN?.trim();
			if (!claudeToken) {
				this.logger.error(
					"Cannot run Slack chat session: no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN in environment",
				);
				await this.adapter.postReply(
					event,
					"I'm not configured with a Claude token, so I can't respond. Ask your admin to set CLAUDE_CODE_OAUTH_TOKEN.",
				);
				return;
			}

			await configureDaytonaCompute(this.daytonaApiKey);

			const taskInstructions = this.adapter.extractTaskInstructions(event);
			const isFirstTurn = !existing;

			// Thread context is injected only on the first turn — subsequent
			// turns are continuations of the same Claude session, which already
			// knows the prior conversation.
			const userPrompt = isFirstTurn
				? await this.buildFirstTurnPrompt(event, taskInstructions)
				: taskInstructions;

			let state: ThreadState<TEvent>;
			if (existing) {
				state = existing;
			} else {
				const systemPrompt = this.adapter.buildSystemPrompt(event);
				const sessionId = `${this.adapter.platformName}-${eventId}`;
				this.logger.info(
					`Creating Daytona AgentSession ${sessionId} for thread ${threadKey}`,
				);
				const session = await createAgentSession(
					{
						sessionId,
						harness: {
							kind: "claude",
							command: CLAUDE_CLI_PATH,
						},
						systemPrompt,
						secrets: {
							CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
							ANTHROPIC_AUTH_TOKEN: claudeToken,
						},
						packages: {
							commands: [...DAYTONA_CLAUDE_SETUP_COMMANDS],
						},
						sandbox: {
							provider: "daytona",
							name: `cyrus-slack-${sessionId}`,
							workingDirectory: DAYTONA_WORKING_DIR,
							timeoutMs: 300_000,
							metadata: {
								purpose: "cyrus-slack-chat",
								threadKey,
							},
						},
					},
					{
						callbacks: {
							onTranscriptEvent: (te) => {
								this.logger.debug(
									`[${sessionId}] transcript event: ${te.kind}`,
								);
							},
						},
					},
				);
				state = {
					session,
					lastActivityAt: Date.now(),
					lastEvent: event,
				};
				this.threadSessions.set(threadKey, state);
			}

			// Mark the run as in-flight so concurrent webhooks see "busy".
			const runPromise = state.session.run(userPrompt);
			state.inFlight = runPromise;
			state.lastEvent = event;

			try {
				const result = await runPromise;
				state.lastActivityAt = Date.now();

				if (!result.success) {
					this.logger.error(
						`Session ${state.session.sessionId} turn did not succeed (exitCode=${result.exitCode})`,
						result.error,
					);
					if (result.error) this.deps.onError(result.error);
					try {
						await this.adapter.postReply(
							event,
							result.error
								? `I hit an error: ${result.error.message}`
								: `I couldn't complete the request (exit code ${result.exitCode}).`,
						);
					} catch (postErr) {
						this.logger.error(
							`Failed to post failure notice for session ${state.session.sessionId}`,
							postErr instanceof Error ? postErr : new Error(String(postErr)),
						);
					}
					// A failed run kills the thread — destroy and free the slot
					// so the next mention starts fresh.
					await this.destroyThread(threadKey);
					return;
				}

				const finalText =
					result.result ?? this.extractAssistantFallback(result.events);
				if (!finalText) {
					this.logger.warn(
						`Session ${state.session.sessionId} completed but produced no result text`,
					);
					return;
				}

				try {
					await this.adapter.postReply(event, finalText);
					this.logger.info(
						`Posted reply for session ${state.session.sessionId}`,
					);
				} catch (postErr) {
					this.logger.error(
						`Failed to post reply for session ${state.session.sessionId}`,
						postErr instanceof Error ? postErr : new Error(String(postErr)),
					);
				}
			} finally {
				state.inFlight = undefined;
			}
		} catch (error) {
			this.logger.error(
				`Failed to process ${this.adapter.platformName} webhook`,
				error instanceof Error ? error : new Error(String(error)),
			);
			this.deps.onError(
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.deps.onWebhookEnd();
		}
	}

	/**
	 * Stop the idle sweeper and destroy every warm thread session.
	 */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.idleSweepTimer) {
			clearInterval(this.idleSweepTimer);
			this.idleSweepTimer = undefined;
		}
		const states = Array.from(this.threadSessions.values());
		this.threadSessions.clear();
		await Promise.all(
			states.map(async (state) => {
				try {
					await state.session.destroy();
				} catch (err) {
					this.logger.warn(
						`Failed to destroy session ${state.session.sessionId} during shutdown: ${err instanceof Error ? err.message : err}`,
					);
				}
			}),
		);
	}

	private async buildFirstTurnPrompt(
		event: TEvent,
		taskInstructions: string,
	): Promise<string> {
		const threadContext = await this.adapter.fetchThreadContext(event);
		return threadContext
			? `${threadContext}\n\n${taskInstructions}`
			: taskInstructions;
	}

	private async destroyThread(threadKey: string): Promise<void> {
		const state = this.threadSessions.get(threadKey);
		if (!state) return;
		this.threadSessions.delete(threadKey);
		try {
			await state.session.destroy();
		} catch (err) {
			this.logger.warn(
				`Failed to destroy thread ${threadKey} session ${state.session.sessionId}: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	private async sweepIdle(): Promise<void> {
		if (this.shuttingDown) return;
		const now = Date.now();
		const expired: string[] = [];
		for (const [threadKey, state] of this.threadSessions) {
			if (state.inFlight) continue;
			if (now - state.lastActivityAt >= this.idleTtlMs) {
				expired.push(threadKey);
			}
		}
		for (const threadKey of expired) {
			this.logger.info(
				`Evicting idle thread ${threadKey} after ${Math.round(this.idleTtlMs / 1000)}s of inactivity`,
			);
			await this.destroyThread(threadKey);
		}
	}

	/**
	 * Walk the transcript backwards looking for the last assistant text
	 * block. Used when the harness adapter's `extractResult()` returns
	 * undefined.
	 */
	private extractAssistantFallback(
		events: readonly TranscriptEvent[],
	): string | undefined {
		for (let i = events.length - 1; i >= 0; i -= 1) {
			const e = events[i];
			if (!e) continue;
			const raw = e.raw as
				| {
						type?: string;
						message?: {
							content?: Array<{ type?: string; text?: string }>;
						};
				  }
				| undefined;
			if (raw?.type === "assistant" && raw.message?.content) {
				const block = raw.message.content.find(
					(b) => b.type === "text" && typeof b.text === "string",
				);
				if (block?.text) return block.text;
			}
		}
		return undefined;
	}
}
