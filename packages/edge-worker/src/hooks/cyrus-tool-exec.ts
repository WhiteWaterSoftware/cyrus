/**
 * Single source of truth for the `cyrus-tool-exec` wrapper CLI contract.
 *
 * `cyrus-tool-exec` is a small wrapper binary baked into the Cyrus managed-cloud
 * droplet image. It runs an inner command inside an ephemeral cgroup v2 with a
 * `memory.max` budget and, on OOM, prints {@link OOM_MARKER} to stderr. Two
 * EdgeWorker hooks depend on this contract from opposite ends:
 *   - {@link buildMemoryLimitHook} (PreToolUse) *wraps* a command via
 *     {@link wrapCommand}.
 *   - the OOM report hook (PostToolUse) *detects* {@link OOM_MARKER}, parses it
 *     via {@link parseOomMarker}, and derives a privacy-safe program label via
 *     {@link extractProgramName}.
 *
 * Keeping the wrapped-command format, env-var name, binary path and marker in
 * one place means the producing and consuming hooks can never drift apart.
 */

/**
 * Absolute path to the wrapper binary. Its *existence* is the
 * deploy-order-independence guard: if the env gate is on but the image predates
 * the wrapper, the PreToolUse hook must stay a no-op (otherwise every Bash call
 * would fail with `127: command not found`).
 */
export const CYRUS_TOOL_EXEC_PATH = "/usr/local/bin/cyrus-tool-exec";

/** Env var carrying the per-command memory budget, in MB. */
export const MEMORY_MAX_MB_ENV = "CYRUS_TOOL_MEMORY_MAX_MB";

/**
 * The exact stderr prefix `cyrus-tool-exec` prints when the inner command is
 * OOM-killed. Must stay byte-for-byte in sync with the wrapper in cyrus-images.
 * Full line: `[cyrus-runtime] command killed: exceeded <cap>M memory budget
 * (peak <bytes> bytes).`
 */
export const OOM_MARKER = "[cyrus-runtime] command killed:";

/** Regex matching the prefix {@link wrapCommand} injects. */
const WRAPPER_PREFIX_RE = new RegExp(
	`^${MEMORY_MAX_MB_ENV}=\\d+\\s+cyrus-tool-exec\\s+`,
);

/**
 * POSIX single-quote a string so it survives intact as one shell word: wrap in
 * `'…'`, and replace every embedded `'` with the four-char sequence `'\''`
 * (close-quote, escaped-quote, reopen-quote). Safe for arbitrary content —
 * backticks, `$(...)`, double quotes, newlines, heredoc bodies — none are
 * interpreted inside single quotes.
 */
export function singleQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the wrapped command that runs `command` under the cgroup wrapper with a
 * `capMb` memory budget. The cap is injected **inline** (env prefix) so the
 * budget reaches the wrapper even if the SDK doesn't propagate env to the tool
 * subprocess; the original is single-quoted so arbitrary shell content survives.
 */
export function wrapCommand(command: string, capMb: string): string {
	return `${MEMORY_MAX_MB_ENV}=${capMb} cyrus-tool-exec ${singleQuote(command)}`;
}

/**
 * Strip the {@link wrapCommand} prefix, returning the inner command the user
 * actually asked to run (input unchanged when it isn't wrapped). Internal — at
 * PostToolUse time the command has already been rewritten to
 * `<env> cyrus-tool-exec '<original>'`, so we must peel the wrapper off to see
 * the real command instead of our own boilerplate.
 */
function unwrapCommand(command: string): string {
	if (!WRAPPER_PREFIX_RE.test(command)) {
		return command;
	}
	const quoted = command.replace(WRAPPER_PREFIX_RE, "");
	if (quoted.length >= 2 && quoted.startsWith("'") && quoted.endsWith("'")) {
		return quoted.slice(1, -1).replace(/'\\''/g, "'");
	}
	return quoted;
}

/** Leading `VAR=value` env-assignment token, e.g. the `FOO=bar` in `FOO=bar cmd`. */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Derive a privacy-safe label for a (possibly wrapped) command: the basename of
 * the program being executed, with **no arguments and no leading `VAR=value`
 * env assignments**. This is deliberately conservative for telemetry leaving the
 * box (SOC-2): command arguments and inline env assignments are exactly where
 * secrets live — API tokens, connection strings, `KEY=...` prefixes — so we
 * never ship them off the droplet. We send only *what* ran, not *how* it ran.
 *
 *   `pnpm test --token=abc`                          -> `pnpm`
 *   `AWS_SECRET_ACCESS_KEY=… node build.js`          -> `node`
 *   `<env> cyrus-tool-exec 'SECRET=x ./bin/run -k y'`-> `run`
 *
 * Returns "" when no program token can be identified.
 */
export function extractProgramName(command: string, max = 64): string {
	const inner = unwrapCommand(command);
	const firstLine = inner.split("\n", 1)[0] ?? "";
	const tokens = firstLine.trim().split(/\s+/).filter(Boolean);
	// Skip leading `VAR=value` env assignments; the first remaining token is the
	// program being run.
	const program = tokens.find((token) => !ENV_ASSIGNMENT_RE.test(token)) ?? "";
	const basename = program.split("/").pop() ?? program;
	return basename.slice(0, max);
}

/** Numbers parsed from an {@link OOM_MARKER} line; every field is best-effort. */
export interface ParsedOomMarker {
	budgetMb?: number;
	peakBytes?: number;
}

/**
 * Extract the memory budget (`exceeded <cap>M`) and peak usage
 * (`peak <bytes> bytes`) from text containing the OOM marker. A field is
 * omitted when its token isn't found.
 */
export function parseOomMarker(text: string): ParsedOomMarker {
	const capMatch = text.match(/exceeded\s+(\d+)M/);
	const peakMatch = text.match(/peak\s+(\d+)\s+bytes/);
	const result: ParsedOomMarker = {};
	if (capMatch) {
		result.budgetMb = Number(capMatch[1]);
	}
	if (peakMatch) {
		result.peakBytes = Number(peakMatch[1]);
	}
	return result;
}
