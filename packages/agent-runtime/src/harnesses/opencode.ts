import type {
	HarnessAdapter,
	HarnessRunOptions,
	NormalizedAgentSessionConfig,
} from "../types.js";
import { createCommand, parseJsonLine, resolveModel } from "./common.js";

export const opencodeHarness: HarnessAdapter = {
	kind: "opencode",
	stateDirectories: [],
	buildCommand(
		config: NormalizedAgentSessionConfig,
		options: HarnessRunOptions,
	) {
		const args = ["run", "--output-format", "json"];
		const model = resolveModel(config);

		if (model) {
			args.push("--model", model);
		}

		if (config.systemPrompt && !options.continueSession) {
			args.push("--system", config.systemPrompt);
		}

		args.push(options.userPrompt);

		return createCommand(config, "opencode", args);
	},
	parseStdoutLine(line, context) {
		return parseJsonLine("opencode", line, context);
	},
};
