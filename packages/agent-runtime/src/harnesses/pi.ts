import type {
	HarnessAdapter,
	HarnessRunOptions,
	NormalizedAgentSessionConfig,
} from "../types.js";
import { createCommand, parseJsonLine, resolveModel } from "./common.js";

export const piHarness: HarnessAdapter = {
	kind: "pi",
	stateDirectories: [],
	buildCommand(
		config: NormalizedAgentSessionConfig,
		options: HarnessRunOptions,
	) {
		const args = ["run", "--json"];
		const model = resolveModel(config);

		if (model) {
			args.push("--model", model);
		}

		if (config.systemPrompt && !options.continueSession) {
			args.push("--system", config.systemPrompt);
		}

		args.push("--prompt", options.userPrompt);

		return createCommand(config, "pi", args);
	},
	parseStdoutLine(line, context) {
		return parseJsonLine("pi", line, context);
	},
};
