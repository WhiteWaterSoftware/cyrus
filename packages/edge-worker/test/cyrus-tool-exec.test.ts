import { describe, expect, it } from "vitest";
import {
	extractProgramName,
	OOM_MARKER,
	parseOomMarker,
	singleQuote,
	wrapCommand,
} from "../src/hooks/cyrus-tool-exec.js";

describe("singleQuote", () => {
	it("wraps a simple string", () => {
		expect(singleQuote("echo hi")).toBe("'echo hi'");
	});

	it("escapes embedded single quotes", () => {
		expect(singleQuote("it's")).toBe("'it'\\''s'");
	});

	it("leaves double quotes, backticks and $() untouched inside quotes", () => {
		expect(singleQuote('echo "$(date)" `id`')).toBe("'echo \"$(date)\" `id`'");
	});
});

describe("wrapCommand", () => {
	it("prefixes the inline cap and single-quotes the original", () => {
		expect(wrapCommand("pnpm test", "1300")).toBe(
			"CYRUS_TOOL_MEMORY_MAX_MB=1300 cyrus-tool-exec 'pnpm test'",
		);
	});

	it("safely quotes embedded single quotes", () => {
		expect(wrapCommand("echo 'hi'", "3000")).toBe(
			"CYRUS_TOOL_MEMORY_MAX_MB=3000 cyrus-tool-exec 'echo '\\''hi'\\'''",
		);
	});

	it("preserves double quotes, backticks and command substitution", () => {
		const cmd = 'echo "$(whoami)" `hostname`';
		expect(wrapCommand(cmd, "1300")).toBe(
			`CYRUS_TOOL_MEMORY_MAX_MB=1300 cyrus-tool-exec ${singleQuote(cmd)}`,
		);
	});

	it("preserves heredocs (newlines)", () => {
		const cmd = "cat <<'EOF'\nline1\nline2\nEOF";
		expect(wrapCommand(cmd, "1300")).toBe(
			`CYRUS_TOOL_MEMORY_MAX_MB=1300 cyrus-tool-exec ${singleQuote(cmd)}`,
		);
	});
});

describe("extractProgramName", () => {
	it("returns the program name from a plain command", () => {
		expect(extractProgramName("pnpm test --filter x")).toBe("pnpm");
	});

	it("peels the wrapper prefix and returns the inner program", () => {
		expect(extractProgramName(wrapCommand("pnpm test", "1300"))).toBe("pnpm");
	});

	it("drops leading VAR=value env assignments (where secrets live)", () => {
		expect(extractProgramName("AWS_SECRET_ACCESS_KEY=shh node build.js")).toBe(
			"node",
		);
	});

	it("drops arguments entirely (no secret-bearing flags)", () => {
		expect(
			extractProgramName("curl -H 'Authorization: Bearer sk-123' url"),
		).toBe("curl");
	});

	it("returns the basename of a path-qualified program", () => {
		expect(extractProgramName("SECRET=x ./bin/run -k yyy")).toBe("run");
		expect(extractProgramName("/usr/bin/python3 main.py")).toBe("python3");
	});

	it("handles a wrapped command whose inner command carries secrets", () => {
		const inner = "TOKEN=supersecret ./deploy.sh --key abc";
		expect(extractProgramName(wrapCommand(inner, "1300"))).toBe("deploy.sh");
	});

	it("uses the first line for heredocs", () => {
		expect(extractProgramName("cat <<'EOF'\nsecret-data\nEOF")).toBe("cat");
	});

	it("returns empty string when there is no program token", () => {
		expect(extractProgramName("")).toBe("");
		expect(extractProgramName("FOO=bar")).toBe("");
	});
});

describe("parseOomMarker", () => {
	it("parses cap and peak from the marker line", () => {
		const line = `${OOM_MARKER} exceeded 1300M memory budget (peak 1500000000 bytes).`;
		expect(parseOomMarker(line)).toEqual({
			budgetMb: 1300,
			peakBytes: 1500000000,
		});
	});

	it("returns an empty object when nothing matches", () => {
		expect(parseOomMarker("no marker here")).toEqual({});
	});
});
