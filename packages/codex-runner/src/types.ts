import type {
	ApprovalMode,
	ModelReasoningEffort,
	SandboxMode,
	ThreadEvent,
	WebSearchMode,
} from "@openai/codex-sdk";
import type {
	AgentRunnerConfig,
	AgentSessionInfo,
	SDKMessage,
} from "cyrus-core";

export type CodexConfigValue =
	| string
	| number
	| boolean
	| CodexConfigValue[]
	| { [key: string]: CodexConfigValue };

export type CodexConfigOverrides = { [key: string]: CodexConfigValue };

/**
 * Typed event shape emitted by Codex SDK thread streams.
 */
export type CodexJsonEvent = ThreadEvent;

/**
 * Configuration for CodexRunner.
 */
export interface CodexRunnerConfig extends AgentRunnerConfig {
	/** Path to codex CLI binary (defaults to `codex` in PATH) */
	codexPath?: string;
	/**
	 * Override Codex home directory.
	 * Defaults to process `CODEX_HOME`, then `~/.codex`.
	 */
	codexHome?: string;
	/**
	 * Override Codex reasoning effort.
	 * If omitted, CodexRunner applies a safe default for known model constraints.
	 */
	modelReasoningEffort?: ModelReasoningEffort;
	/** Sandbox mode for Codex shell/tool execution */
	sandbox?: SandboxMode;
	/** Approval policy for Codex tool/shell execution */
	askForApproval?: ApprovalMode;
	/** Enable Codex web search tool */
	includeWebSearch?: boolean;
	/** Explicit Codex web search mode (takes precedence over includeWebSearch) */
	webSearchMode?: WebSearchMode;
	/** Allow execution outside git repo (defaults to true) */
	skipGitRepoCheck?: boolean;
	/** Additional global Codex config overrides passed through SDK `config` */
	configOverrides?: CodexConfigOverrides;
	/** JSON Schema for structured output (passed to thread.runStreamed as outputSchema) */
	outputSchema?: unknown;
	/**
	 * Drive Codex via the persistent `codex app-server` JSON-RPC protocol instead
	 * of `codex exec`. The app-server backend supports streaming input: comments
	 * that arrive mid-turn are injected into the active turn via `turn/steer`
	 * rather than aborting and restarting it.
	 *
	 * Defaults to `false` (exec backend). May also be enabled for local testing
	 * via the `CODEX_USE_APP_SERVER=1` environment variable.
	 */
	useAppServer?: boolean;
}

/**
 * Session metadata for CodexRunner.
 */
export interface CodexSessionInfo extends AgentSessionInfo {
	sessionId: string | null;
}

/**
 * Event emitter interface for CodexRunner.
 */
export interface CodexRunnerEvents {
	message: (message: SDKMessage) => void;
	error: (error: Error) => void;
	complete: (messages: SDKMessage[]) => void;
	streamEvent: (event: CodexJsonEvent) => void;
}
