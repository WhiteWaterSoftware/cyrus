import type {
	HarnessAdapter,
	HarnessRunOptions,
	NormalizedAgentSessionConfig,
} from "../types.js";
import { createCommand, parseJsonLine, resolveModel } from "./common.js";

export const cursorHarness: HarnessAdapter = {
	kind: "cursor",
	// Cursor CLI is rules-only — no per-session state dir to preserve for
	// resume yet. When cursor-agent grows a session-resume model, add it here.
	stateDirectories: [],
	buildCommand(
		config: NormalizedAgentSessionConfig,
		options: HarnessRunOptions,
	) {
		const args = ["--print", "--output-format", "stream-json", "--trust"];
		const model = resolveModel(config);

		if (model) {
			args.push("--model", model);
		}

		if (
			config.permissions?.mode === "plan" ||
			config.permissions?.mode === "ask"
		) {
			args.push("--mode", config.permissions.mode);
		}

		if (
			config.permissions?.mode === "bypass" ||
			config.permissions?.mode === "auto"
		) {
			args.push("--force");
		}

		args.push(options.userPrompt);

		return createCommand(config, "cursor-agent", args);
	},
	parseStdoutLine(line, context) {
		return parseJsonLine("cursor", line, context);
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
