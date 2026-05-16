import type {
	AgentSession,
	AgentSessionResult,
	TranscriptEvent,
} from "cyrus-agent-runtime";
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
}

/**
 * Slim chat-session handler built on top of `cyrus-agent-runtime`'s
 * `createAgentSession`. Replaces the old `ChatSessionHandler` +
 * `IAgentRunner` + `AgentSessionManager` stack with a single call into the
 * unified agent runtime.
 *
 * **Hardwired to Daytona + Claude.** Each Slack mention spawns a fresh
 * Daytona sandbox, installs `@anthropic-ai/claude-code` inside it, then
 * runs `claude --output-format stream-json` to answer. When the run
 * completes (or fails) the sandbox is destroyed via `result.destroy()`,
 * which maps to ComputeSDK's `ProviderSandbox.destroy()`.
 *
 * Requires the following environment variables (the handler refuses to
 * construct without `DAYTONA_API_KEY`; runs will fail without a Claude
 * token):
 *
 * - `DAYTONA_API_KEY` — sandbox provider auth.
 * - `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_AUTH_TOKEN`) — Claude auth
 *   inside the sandbox.
 *
 * Brutal cuts compared to `ChatSessionHandler` (deliberate, spike-only):
 *
 * - **No multi-turn `--continue` resume.** Each platform event spawns a
 *   fresh `AgentSession`. Conversation continuity comes from the
 *   adapter's `fetchThreadContext()` injecting the prior thread as text
 *   into the user prompt.
 * - **No mid-flight stream injection.** If a thread already has an
 *   in-flight session, the new message gets `notifyBusy()`. (Future
 *   work: route through `AgentSession.addMessage()` with
 *   `interactiveInput: true` for harnesses that consume stream-json
 *   stdin.)
 * - **No MCP servers.** `cyrus-agent-runtime` accepts an `mcps` field
 *   but doesn't yet wire them through to the harness CLI. In-process
 *   SDK servers (cyrus-tools) wouldn't translate across the subprocess
 *   boundary anyway. Slack chat sessions run with the Claude CLI's
 *   default toolset only.
 * - **Claude harness only.** The runner-selection layer is gone here —
 *   if the user wants Codex/Gemini for Slack chat, that's a follow-up.
 * - **Daytona only.** No local sandbox fallback — keeps the spike
 *   focused on the remote-streaming path we just validated.
 * - **No persisted session state.** No AgentSessionManager, no
 *   thread-to-claudeSessionId map. Each session is born and dies in
 *   one webhook turn.
 */
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

export class AgentChatSessionHandler<TEvent> {
	private readonly adapter: ChatPlatformAdapter<TEvent>;
	private readonly deps: AgentChatSessionHandlerDeps;
	private readonly logger: ILogger;
	private readonly threadSessions = new Map<string, AgentSession>();
	private readonly daytonaApiKey: string;

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
	}

	/** Returns true if any thread on this handler has an in-flight session. */
	isAnyRunnerBusy(): boolean {
		return this.threadSessions.size > 0;
	}

	/** Test/inspection: enumerate active threads. */
	listThreads(): Array<{ threadKey: string; sessionId: string }> {
		return Array.from(this.threadSessions.entries()).map(
			([threadKey, session]) => ({ threadKey, sessionId: session.sessionId }),
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

			// Fire-and-forget acknowledgement (e.g. emoji reaction)
			this.adapter.acknowledgeReceipt(event).catch((err: unknown) => {
				this.logger.warn(
					`Failed to acknowledge ${this.adapter.platformName} event: ${err instanceof Error ? err.message : err}`,
				);
			});

			// In-flight thread → notify and bail out. (Brutal cut: no mid-flight
			// stream injection — see header for why.)
			if (this.threadSessions.has(threadKey)) {
				this.logger.info(
					`Thread ${threadKey} has an active session; notifying user.`,
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
			const threadContext = await this.adapter.fetchThreadContext(event);
			const userPrompt = threadContext
				? `${threadContext}\n\n${taskInstructions}`
				: taskInstructions;
			const systemPrompt = this.adapter.buildSystemPrompt(event);

			const sessionId = `${this.adapter.platformName}-${eventId}`;
			this.logger.info(
				`Starting Daytona AgentSession ${sessionId} for thread ${threadKey}`,
			);

			const session = await createAgentSession(
				{
					sessionId,
					harness: {
						kind: "claude",
						command: CLAUDE_CLI_PATH,
					},
					systemPrompt,
					userPrompt,
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
							this.logger.debug(`[${sessionId}] transcript event: ${te.kind}`);
						},
					},
				},
			);
			this.threadSessions.set(threadKey, session);

			let result: AgentSessionResult;
			try {
				result = await session.start();
			} finally {
				this.threadSessions.delete(threadKey);
			}

			if (!result.success) {
				this.logger.error(
					`Session ${sessionId} did not succeed (exitCode=${result.exitCode})`,
					result.error,
				);
				if (result.error) this.deps.onError(result.error);
				// Best-effort: post a brief failure note instead of leaving the user hanging.
				try {
					await this.adapter.postReply(
						event,
						result.error
							? `I hit an error: ${result.error.message}`
							: `I couldn't complete the request (exit code ${result.exitCode}).`,
					);
				} catch (postErr) {
					this.logger.error(
						`Failed to post failure notice for session ${sessionId}`,
						postErr instanceof Error ? postErr : new Error(String(postErr)),
					);
				}
				await result.destroy();
				return;
			}

			// Prefer the harness-extracted result string; fall back to scanning
			// transcript events for the last assistant text.
			const finalText =
				result.result ?? this.extractAssistantFallback(result.events);
			if (!finalText) {
				this.logger.warn(
					`Session ${sessionId} completed but produced no result text`,
				);
				await result.destroy();
				return;
			}

			try {
				await this.adapter.postReply(event, finalText);
				this.logger.info(`Posted reply for session ${sessionId}`);
			} catch (postErr) {
				this.logger.error(
					`Failed to post reply for session ${sessionId}`,
					postErr instanceof Error ? postErr : new Error(String(postErr)),
				);
			}

			await result.destroy();
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
	 * Stop all in-flight sessions and release their sandboxes. Used at
	 * EdgeWorker shutdown.
	 */
	async shutdown(): Promise<void> {
		const sessions = Array.from(this.threadSessions.values());
		this.threadSessions.clear();
		await Promise.all(
			sessions.map(async (session) => {
				try {
					await session.destroy();
				} catch (err) {
					this.logger.warn(
						`Failed to destroy session ${session.sessionId} during shutdown: ${err instanceof Error ? err.message : err}`,
					);
				}
			}),
		);
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
