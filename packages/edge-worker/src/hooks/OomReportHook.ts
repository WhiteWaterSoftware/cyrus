import type {
	HookCallbackMatcher,
	HookEvent,
	HookJSONOutput,
	PostToolUseFailureHookInput,
} from "cyrus-claude-runner";
import { getCyrusAppUrl } from "cyrus-cloudflare-tunnel-client";
import type { ILogger } from "cyrus-core";
import {
	extractProgramName,
	OOM_MARKER,
	parseOomMarker,
} from "./cyrus-tool-exec.js";

/** A per-command OOM event, ready to report to the control plane. */
export interface OomEvent {
	budgetMb?: number;
	peakBytes?: number;
	/**
	 * Privacy-safe identifier of the program that OOM'd — the executable name
	 * only, never arguments or env assignments (see {@link extractProgramName}).
	 * Carried in the control-plane wire field `commandExcerpt`.
	 */
	commandExcerpt: string;
}

/**
 * Transport seam for delivering {@link OomEvent}s. Abstracting it (rather than
 * calling `fetch` inline) keeps the hook responsible only for *detecting and
 * parsing* OOMs, and lets the transport be swapped or stubbed independently —
 * mirroring the `PrMarkerProvider` / `IntentToAddGitClient` seams used by the
 * sibling hooks.
 */
export interface OomEventReporter {
	/** Deliver one event. Implementations must never throw — telemetry fails open. */
	report(event: OomEvent): Promise<void>;
}

/** Options for {@link HttpOomEventReporter}. */
export interface HttpOomEventReporterOptions {
	/** Reads an environment variable. Defaults to `process.env`. */
	getEnv?: (name: string) => string | undefined;
	/** Resolves the cyrus-hosted control-plane base URL. Defaults to `getCyrusAppUrl`. */
	getBaseUrl?: () => string;
	/** Fetch implementation. Defaults to `globalThis.fetch`. */
	fetchImpl?: typeof fetch;
	/** Network timeout in ms. Defaults to 5s — OOM is rare, so a short await is fine. */
	timeoutMs?: number;
}

/**
 * Default {@link OomEventReporter}: `POST`s to `<cyrus-app-url>/api/oom-event`
 * authenticated with the droplet's `CYRUS_API_KEY` bearer — the same
 * control-plane callback path failure-mode reporting already uses. A missing
 * key is a silent no-op (community/self-host with no control plane). Every
 * failure mode is swallowed so a report can never block or fail a tool result.
 */
export class HttpOomEventReporter implements OomEventReporter {
	private readonly getEnv: (name: string) => string | undefined;
	private readonly getBaseUrl: () => string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;

	constructor(
		private readonly log: ILogger,
		options: HttpOomEventReporterOptions = {},
	) {
		this.getEnv = options.getEnv ?? ((name: string) => process.env[name]);
		this.getBaseUrl = options.getBaseUrl ?? getCyrusAppUrl;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? 5_000;
	}

	async report(event: OomEvent): Promise<void> {
		const apiKey = this.getEnv("CYRUS_API_KEY")?.trim();
		if (!apiKey) {
			return;
		}

		const url = `${this.getBaseUrl().replace(/\/+$/, "")}/api/oom-event`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await this.fetchImpl(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					budgetMb: event.budgetMb,
					peakBytes: event.peakBytes,
					commandExcerpt: event.commandExcerpt,
				}),
				signal: controller.signal,
			});
			if (!res.ok) {
				this.log.debug(`[OomReportHook] /api/oom-event returned ${res.status}`);
			} else {
				this.log.info(
					`[OomReportHook] reported OOM (budget=${event.budgetMb}M peak=${event.peakBytes}B)`,
				);
			}
		} catch (err) {
			this.log.debug(`[OomReportHook] failing open: ${(err as Error).message}`);
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * Collapse a failed Bash result into a single searchable string. Handles the
 * `error: string` carried by `PostToolUseFailureHookInput`, a raw string, or a
 * `{ stdout, stderr, ... }`-shaped object, falling back to JSON for unexpected
 * shapes so the marker substring check still works.
 */
export function extractResultText(toolResponse: unknown): string {
	if (typeof toolResponse === "string") {
		return toolResponse;
	}
	if (toolResponse && typeof toolResponse === "object") {
		const parts: string[] = [];
		for (const value of Object.values(
			toolResponse as Record<string, unknown>,
		)) {
			if (typeof value === "string") {
				parts.push(value);
			}
		}
		if (parts.length > 0) {
			return parts.join("\n");
		}
		try {
			return JSON.stringify(toolResponse);
		} catch {
			return "";
		}
	}
	return "";
}

/**
 * Build the hook that reports per-command OOM kills to the cyrus-hosted control
 * plane. It registers on **`PostToolUseFailure`**, not `PostToolUse`: an
 * OOM-killed command exits non-zero, so the SDK routes its result to the
 * failure event — the {@link OOM_MARKER} can therefore never appear in a
 * (successful) `PostToolUse` result. The hook's sole responsibility is to
 * detect the marker, parse it, and hand a structured {@link OomEvent} to the
 * injected {@link OomEventReporter} — delivery details (auth, URL, timeout,
 * fail-open) live in the reporter.
 *
 * On `PostToolUseFailure` the failure detail lives in `error` (a string). We
 * also fold in any `tool_response` if a future SDK surfaces one, so the marker
 * is found regardless of which field carries it.
 */
export function buildOomReportHook(
	log: ILogger,
	reporter: OomEventReporter = new HttpOomEventReporter(log),
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	return {
		PostToolUseFailure: [
			{
				matcher: "Bash",
				hooks: [
					async (input): Promise<HookJSONOutput> => {
						try {
							const post = input as PostToolUseFailureHookInput & {
								tool_response?: unknown;
							};
							const text = `${extractResultText(post.error)}\n${extractResultText(
								post.tool_response,
							)}`;
							if (!text.includes(OOM_MARKER)) {
								return {};
							}

							const { budgetMb, peakBytes } = parseOomMarker(text);
							const command =
								(post.tool_input as { command?: unknown } | undefined)
									?.command ?? "";
							await reporter.report({
								budgetMb,
								peakBytes,
								commandExcerpt: extractProgramName(
									typeof command === "string" ? command : "",
								),
							});
						} catch (err) {
							log.debug(
								`[OomReportHook] failing open: ${(err as Error).message}`,
							);
						}
						return {};
					},
				],
			},
		],
	};
}
