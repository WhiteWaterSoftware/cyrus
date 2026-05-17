import type {
	HarnessAdapter,
	HarnessRunOptions,
	NormalizedAgentSessionConfig,
} from "../types.js";
import { createCommand, parseJsonLine, resolveModel } from "./common.js";

export const claudeHarness: HarnessAdapter = {
	kind: "claude",
	stateDirectories: [".claude"],
	buildCommand(
		config: NormalizedAgentSessionConfig,
		options: HarnessRunOptions,
	) {
		const args = [
			"-p",
			options.userPrompt,
			"--output-format",
			"stream-json",
			"--verbose",
		];
		if (options.continueSession) {
			// Resume the most recent session in the current cwd. Claude tracks
			// sessions per cwd, so the runtime's per-session HOME isolation
			// guarantees we pick up the right conversation.
			args.push("--continue");
		}
		const model = resolveModel(config);

		if (model) {
			args.push("--model", model);
		}

		if (config.systemPrompt && !options.continueSession) {
			// On continue, Claude already has the system prompt baked in.
			args.push("--append-system-prompt", config.systemPrompt);
		}

		if (config.permissions?.mode) {
			args.push("--permission-mode", config.permissions.mode);
		}

		if (config.permissions?.allowedTools?.length) {
			args.push("--allowedTools", config.permissions.allowedTools.join(","));
		}

		if (config.permissions?.disallowedTools?.length) {
			args.push(
				"--disallowedTools",
				config.permissions.disallowedTools.join(","),
			);
		}

		return createCommand(config, "claude", args);
	},
	parseStdoutLine(line, context) {
		return parseJsonLine("claude", line, context);
	},
	extractResult(events) {
		const result = [...events].reverse().find((event) => {
			return event.kind === "result" && isRecord(event.raw);
		});
		return result &&
			isRecord(result.raw) &&
			typeof result.raw.result === "string"
			? result.raw.result
			: undefined;
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
