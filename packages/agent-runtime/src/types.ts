export type HarnessKind =
	| "claude"
	| "codex"
	| "cursor"
	| "gemini"
	| "pi"
	| "opencode";

export type PermissionMode = "default" | "plan" | "ask" | "auto" | "bypass";

export type NetworkEgressMode =
	| "default"
	| "disabled"
	| "proxied"
	| "unrestricted";

export interface RuntimeSecret {
	value: string;
	redact?: boolean;
}

export interface McpServerRuntimeConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	httpUrl?: string;
	headers?: Record<string, string>;
}

/**
 * Hook event names — a deliberate universal subset that maps cleanly to
 * Claude (`PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`,
 * `UserPromptSubmit`) and Cursor (`preToolUse`, etc.). Events that exist
 * on one harness but not the others are silently dropped by the
 * materializer for harnesses that can't translate them.
 *
 * Codex hooks are deferred for v1 — its hook schema is version-pinned
 * and unstable.
 */
export type PluginHookEvent =
	| "PreToolUse"
	| "PostToolUse"
	| "SessionStart"
	| "Stop"
	| "UserPromptSubmit";

export interface PluginHook {
	event: PluginHookEvent;
	/** Shell command to run when the event fires. */
	command: string;
	/** Optional regex matcher over the tool name (PreToolUse/PostToolUse). */
	matcher?: string;
	/** Optional per-hook timeout in seconds. Honored by Claude. */
	timeout?: number;
	/** Fail-closed semantics for Cursor (true => deny on hook crash). Ignored by Claude. */
	failClosed?: boolean;
}

export interface PluginSkill {
	/** Skill name, used as the directory name and slash-command suffix. */
	name: string;
	/** SKILL.md frontmatter `description` — drives auto-invocation. Required. */
	description: string;
	/** SKILL.md markdown body (without frontmatter). */
	content: string;
	/** If true, the skill is slash-command-only (no model auto-invoke). */
	disableModelInvocation?: boolean;
	/**
	 * Sibling files placed under the skill's directory at
	 * `<skill-root>/<path>`. Used for `scripts/`, `references/`, etc.
	 */
	assets?: Array<{ path: string; content: string }>;
}

/**
 * Provider-agnostic plugin shape — bundles MCP servers, hooks, and
 * skills. The runtime translates this into harness-native filesystem
 * state or CLI flags per the target harness.
 *
 * Callers can either supply a fully-resolved `RuntimePlugin` inline, or
 * point at a directory via `{ rootPath }` (resolver reads
 * `<rootPath>/cyrus-plugin.json` and slurps referenced files). v1
 * implements inline only; rootPath is a follow-up.
 */
export interface RuntimePlugin {
	name: string;
	version?: string;
	description?: string;
	mcpServers?: Record<string, McpServerRuntimeConfig>;
	hooks?: PluginHook[];
	skills?: PluginSkill[];
}

export type PluginInput = RuntimePlugin | { rootPath: string };

export interface RuntimeMemoryConfig {
	enabled?: boolean;
	directory?: string;
	namespace?: string;
}

export interface RuntimePackageConfig {
	system?: string[];
	npm?: string[];
	commands?: string[];
}

export interface RuntimeFileConfig {
	path: string;
	content: string;
	sensitive?: boolean;
}

/**
 * Access mode for folders and repositories materialized into the sandbox.
 * - `"read"`: the runtime makes the contents available; changes inside the
 *   sandbox are not propagated back to the source.
 * - `"readwrite"`: the runtime makes the contents available and syncs
 *   changes inside the sandbox back to the source after the harness
 *   command completes (folders) or leaves them ready for an explicit push
 *   (repositories).
 */
export type RuntimeAccessMode = "read" | "readwrite";

/**
 * Materialize a host filesystem folder into the sandbox. For local
 * sandboxes this is a directory copy; for remote sandboxes (e.g. Daytona)
 * the runtime walks the host tree and uploads each file via
 * {@link SandboxFilesystem.writeFile}. With `access: "readwrite"` the
 * runtime syncs changes from the sandbox back to the host after the
 * harness command completes — useful for dev loops where the user wants
 * to see the agent's edits on their disk.
 *
 * Conceptually distinct from {@link RuntimeVolumeConfig} (provider-attached
 * persistent storage) and {@link RuntimeRepositoryConfig} (git-driven
 * trees with branch awareness).
 */
export interface RuntimeFolderConfig {
	/** Absolute or runtime-relative host path to expose. */
	source: string;
	/** Where in the sandbox to materialize the folder contents. */
	mountPath: string;
	/** Default: `"read"`. */
	access?: RuntimeAccessMode;
	/** Glob patterns (relative to source) to skip during copy/sync. */
	exclude?: string[];
}

/**
 * Materialize a git repository into the sandbox. The runtime runs
 * `git clone <source> <mountPath>` inside the sandbox (so credentials,
 * proxies, and CA bundles are inherited from the sandbox env) and, if
 * `branch` is set, checks out that ref. With `access: "readwrite"` the
 * working tree is left configured for push; with `"read"` the clone is
 * shallow by default and push is not expected.
 */
export interface RuntimeRepositoryConfig {
	/**
	 * Git URL (HTTPS or SSH) or local path. Local paths are cloned via
	 * `file://` to preserve git semantics rather than naive copy.
	 */
	source: string;
	/** Where in the sandbox to clone the working tree. */
	mountPath: string;
	/**
	 * Optional ref to check out after clone. Branch, tag, or commit SHA.
	 * Defaults to remote HEAD.
	 */
	branch?: string;
	/** Default: `"readwrite"`. */
	access?: RuntimeAccessMode;
	/**
	 * Optional shallow-clone depth. Defaults to `1` for `access: "read"`
	 * and unset (full clone) for `access: "readwrite"`.
	 */
	depth?: number;
}

export interface RuntimeVolumeConfig {
	name: string;
	mountPath: string;
	source?: string;
	kind?: "bind" | "fuse" | "provider";
	readOnly?: boolean;
}

export interface RuntimeNetworkEgressConfig {
	mode: NetworkEgressMode;
	proxyUrl?: string;
	allowedHosts?: string[];
	deniedHosts?: string[];
}

export interface RuntimeSandboxConfig {
	provider: "local" | string;
	id?: string;
	name?: string;
	namespace?: string;
	workingDirectory?: string;
	templateId?: string;
	timeoutMs?: number;
	metadata?: Record<string, unknown>;
	volumes?: RuntimeVolumeConfig[];
	networkEgress?: RuntimeNetworkEgressConfig;
	/**
	 * When `true`, the runtime "pauses" the underlying sandbox while no
	 * `session.run()` is in flight and resumes it on the next `run()`.
	 *
	 * For Daytona this maps to `sandbox.stop()` / `sandbox.start()` —
	 * stopped sandboxes preserve all on-disk state (so Claude's
	 * `~/.claude/` survives) and free up compute. Restart is a few
	 * seconds, far cheaper than a from-scratch sandbox create + setup
	 * commands.
	 *
	 * For the local sandbox the flag is a no-op (local sessions are
	 * always free).
	 *
	 * Trade-off: compute cost vs. resume latency. You stop paying for
	 * an idle warm sandbox between turns at the cost of a few-second
	 * resume on the next run.
	 */
	destroyWhileInactive?: boolean;
}

export interface RuntimeHarnessConfig {
	kind: HarnessKind;
	model?: string;
	command?: string;
	args?: string[];
}

export interface RuntimePermissionConfig {
	mode?: PermissionMode;
	allowedTools?: string[];
	disallowedTools?: string[];
}

export interface CreateAgentSessionConfig {
	sessionId?: string;
	harness: HarnessKind | RuntimeHarnessConfig;
	model?: string;
	systemPrompt?: string;
	env?: Record<string, string>;
	secrets?: Record<string, RuntimeSecret | string>;
	packages?: RuntimePackageConfig;
	files?: RuntimeFileConfig[];
	folders?: RuntimeFolderConfig[];
	repositories?: RuntimeRepositoryConfig[];
	/**
	 * Bundles of MCP servers + hooks + skills materialized into the
	 * sandbox in a harness-native form. The unified plugin shape is the
	 * only way to deliver MCP servers to a session — there is no
	 * standalone `mcps` field. A plugin with `mcpServers` populated and
	 * `hooks`/`skills` omitted is the standard "MCP-only" carrier.
	 */
	plugins?: PluginInput[];
	permissions?: RuntimePermissionConfig;
	memory?: RuntimeMemoryConfig;
	sandbox?: RuntimeSandboxConfig;
	networkEgress?: RuntimeNetworkEgressConfig;
	metadata?: Record<string, unknown>;
	/**
	 * Root host directory under which each session's state backing lives.
	 * Defaults to `~/.cyrus-agent-sessions/`. Each session gets a
	 * subdirectory `<root>/<sessionId>/`. For the local sandbox the
	 * subdirectory becomes the harness process's `HOME`, so per-session
	 * `.claude` / `.codex` / `.gemini` state is naturally isolated and
	 * resumable across `session.run()` calls.
	 */
	agentSessionsRoot?: string;
	/**
	 * When `true`, opens an interactive stdin pipe to the harness process so
	 * `addMessage()` chunks reach the running CLI live. Default `false` —
	 * most one-shot harness CLIs (e.g. `codex exec`) hang if stdin is piped
	 * without being closed, so this is opt-in. Set to `true` for harnesses
	 * that consume `--input-format stream-json` or similar.
	 */
	interactiveInput?: boolean;
}

export interface TranscriptEvent {
	sessionId: string;
	harness: HarnessKind;
	timestamp: string;
	kind: string;
	raw: unknown;
	normalized?: unknown;
	metadata?: Record<string, unknown>;
}

export interface HarnessCommand {
	command: string;
	args: string[];
	env?: Record<string, string>;
	stdin?: string;
}

/**
 * Options passed by `RuntimeAgentSession` to the harness adapter on each
 * `run()`. The adapter uses these to construct the per-turn invocation —
 * for instance, Claude maps `continueSession: true` to `--continue`.
 */
export interface HarnessRunOptions {
	userPrompt: string;
	/**
	 * `true` on every `run()` after the first, signalling the harness
	 * should resume the prior conversation in the session's backing
	 * (e.g. Claude `--continue`). `false` on the first run.
	 */
	continueSession: boolean;
	/**
	 * Outputs from per-harness plugin materializers, surfaced so the
	 * adapter's `buildCommand` can wire them into the CLI invocation.
	 * The session populates this on first turn after running the right
	 * materializer for the harness.
	 */
	pluginOutputs?: {
		/** Claude: directories to pass as `--plugin-dir <dir>` (one per plugin). */
		claudePluginDirs?: string[];
		/** Claude: optional combined mcp config path for `--mcp-config` + `--strict-mcp-config`. */
		claudeMcpConfigPath?: string;
		/** Cursor: true when any plugin declared MCP servers — caller appends `--approve-mcps`. */
		cursorHasMcpServers?: boolean;
		/** Codex: inline `-c` CLI overrides (e.g. `mcp_servers.<n>={...}`). */
		codexConfigOverrides?: string[];
		/** Codex: HOME override required for skills discovery (`$HOME/.agents/skills/`). */
		codexHomeOverride?: string;
	};
}

export interface HarnessAdapter {
	readonly kind: HarnessKind;
	/**
	 * Relative paths (under `HOME` inside the compute) where the harness
	 * keeps its session state. The runtime ensures these survive between
	 * `run()` calls by making the parent (`HOME`) per-session persistent.
	 *
	 * - Claude: `[".claude"]`
	 * - Codex:  `[".codex"]`
	 * - Gemini: `[".gemini"]`
	 *
	 * Adapters without a resumable state model leave this empty.
	 */
	readonly stateDirectories: readonly string[];
	buildCommand(
		config: NormalizedAgentSessionConfig,
		options: HarnessRunOptions,
	): HarnessCommand;
	parseStdoutLine(
		line: string,
		context: TranscriptParseContext,
	): TranscriptEvent | undefined;
	parseStderrLine?(
		line: string,
		context: TranscriptParseContext,
	): TranscriptEvent | undefined;
	extractResult?(events: TranscriptEvent[]): string | undefined;
}

export interface TranscriptParseContext {
	sessionId: string;
	harness: HarnessKind;
	now?: () => Date;
}

export interface CommandExecutionResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
}

export interface SandboxFileEntry {
	name: string;
	type: "file" | "directory";
	size?: number;
	modified?: Date;
}

export interface SandboxFilesystem {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	readdir(path: string): Promise<SandboxFileEntry[]>;
	mkdir(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	remove(path: string): Promise<void>;
}

export interface SandboxRunCommandOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
	background?: boolean;
}

/**
 * Options for {@link RunnerSandbox.streamCommand}. Extends the one-shot
 * {@link SandboxRunCommandOptions} with chunk callbacks that fire as bytes
 * arrive from the running process. The returned {@link CommandExecutionResult}
 * still contains the full buffered output for symmetry with `runCommand`.
 */
export interface SandboxStreamCommandOptions extends SandboxRunCommandOptions {
	/** Invoked with each stdout chunk as it arrives. */
	onStdout?: (chunk: string) => void;
	/** Invoked with each stderr chunk as it arrives. */
	onStderr?: (chunk: string) => void;
	/** Abort the underlying process when this signal aborts. */
	signal?: AbortSignal;
	/**
	 * Optional async iterable of chunks to feed into the process's stdin while
	 * it runs. Each yielded chunk is delivered to the running command live —
	 * local providers write to `child.stdin`; Daytona uses
	 * `sendSessionCommandInput`. The stream is closed (stdin EOF) when the
	 * iterable completes.
	 */
	input?: AsyncIterable<string>;
}

export interface RunnerSandboxCapabilities {
	filesystem: boolean;
	runCommand: boolean;
	streamingProcess: boolean;
	snapshots?: boolean;
	ports?: boolean;
	volumes?: boolean;
	networkEgress?: boolean;
}

export interface RunnerSandbox {
	readonly sandboxId: string;
	readonly provider: string;
	readonly workingDirectory?: string;
	readonly capabilities: RunnerSandboxCapabilities;
	readonly filesystem: SandboxFilesystem;
	runCommand(
		command: string,
		options?: SandboxRunCommandOptions,
	): Promise<CommandExecutionResult>;
	/**
	 * Run a command and stream stdout/stderr chunks through callbacks as they
	 * arrive. Only available when {@link RunnerSandboxCapabilities.streamingProcess}
	 * is `true`. Providers that cannot stream do not implement this method; check
	 * the capability flag before calling.
	 */
	streamCommand?(
		command: string,
		options?: SandboxStreamCommandOptions,
	): Promise<CommandExecutionResult>;
	destroy(): Promise<void>;
}

export interface SandboxProvider {
	readonly provider: string;
	create(config: RuntimeSandboxConfig): Promise<RunnerSandbox>;
}

export interface PermissionPromptRequest {
	sessionId: string;
	harness: HarnessKind;
	toolName: string;
	input: unknown;
	reason?: string;
}

export interface PermissionPromptResponse {
	allowed: boolean;
	reason?: string;
}

export interface RuntimeCallbacks {
	onPermissionPrompt?: (
		request: PermissionPromptRequest,
	) => Promise<PermissionPromptResponse> | PermissionPromptResponse;
	onTranscriptEvent?: (event: TranscriptEvent) => Promise<void> | void;
}

export interface AgentSessionResult {
	sessionId: string;
	harness: HarnessKind;
	success: boolean;
	exitCode?: number;
	result?: string;
	error?: Error;
	events: TranscriptEvent[];
	/**
	 * Release the underlying sandbox. Equates to ComputeSDK's
	 * `ProviderSandbox.destroy()` for ComputeSDK-backed providers (deletes
	 * the remote sandbox and releases compute resources); for the local
	 * provider it is a no-op. Idempotent — safe to call multiple times,
	 * and safe to call alongside `AgentSession.stop()` (they share the
	 * same one-shot destroy).
	 */
	destroy(): Promise<void>;
}

export interface NormalizedAgentSessionConfig
	extends Omit<CreateAgentSessionConfig, "harness" | "secrets" | "sandbox"> {
	sessionId: string;
	harness: RuntimeHarnessConfig;
	model?: string;
	env: Record<string, string>;
	secrets: Record<string, RuntimeSecret>;
	sandbox: RuntimeSandboxConfig;
}

export interface AgentSession {
	readonly sessionId: string;
	readonly harness: HarnessKind;
	readonly events: AsyncIterable<TranscriptEvent>;
	/**
	 * Run one turn of the harness against this session.
	 *
	 * On the first call, the runtime materializes files/folders/repos,
	 * runs setup commands, then invokes the harness with the supplied
	 * prompt. On subsequent calls, materialization and setup are
	 * skipped and the harness is invoked with its resume flag (Claude:
	 * `--continue`) so it picks up the prior conversation from the
	 * session's persistent state backing.
	 */
	run(userPrompt: string): Promise<AgentSessionResult>;
	addMessage(message: string): Promise<void>;
	interrupt(reason?: string): Promise<void>;
	/**
	 * Cancel the in-flight run. Aborts the running harness process, closes
	 * the live event stream, and closes the input pipe. Does NOT release
	 * the underlying sandbox — call {@link destroy} for that. Idempotent.
	 */
	stop(reason?: string): Promise<void>;
	/**
	 * Release the underlying sandbox. Equates to ComputeSDK's
	 * `ProviderSandbox.destroy()` for ComputeSDK-backed providers
	 * (deletes the remote sandbox and releases compute resources); for
	 * the local provider it is a no-op. If a run is still in flight,
	 * cancels it first via {@link stop} so the harness process
	 * terminates cleanly before teardown. Idempotent.
	 *
	 * Shares its one-shot teardown with {@link AgentSessionResult.destroy},
	 * so calling either or both in any order is safe.
	 */
	destroy(): Promise<void>;
}
