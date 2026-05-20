import { describe, expect, it } from "vitest";
import {
	buildHarnessInvocation,
	getHarnessAdapter,
	harnessAdapters,
} from "../src/harnesses/index.js";
import type { NormalizedAgentSessionConfig } from "../src/types.js";

const baseConfig: NormalizedAgentSessionConfig = {
	sessionId: "session-1",
	harness: { kind: "claude" },
	env: {},
	secrets: {},
	sandbox: {
		provider: "local",
		workingDirectory: "/tmp/worktree",
	},
};

describe("harness adapters", () => {
	it("registers every supported harness kind", () => {
		expect(Object.keys(harnessAdapters).sort()).toEqual([
			"claude",
			"codex",
			"cursor",
			"gemini",
			"opencode",
		]);
	});

	it("builds a Claude stream-json command", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				model: "claude-sonnet-4-5",
				systemPrompt: "Be concise",
				permissions: {
					mode: "ask",
					allowedTools: ["Read(**)", "Edit(**)"],
					disallowedTools: ["Bash"],
				},
			},
			{ userPrompt: "Fix the failing test" },
		);

		expect(command.command).toBe("claude");
		expect(command.args).toEqual([
			"-p",
			"Fix the failing test",
			"--output-format",
			"stream-json",
			"--verbose",
			"--model",
			"claude-sonnet-4-5",
			"--append-system-prompt",
			"Be concise",
			// "ask" maps to Claude's "default" — Claude's CLI does not
			// accept "ask" verbatim.
			"--permission-mode",
			"default",
			"--allowedTools",
			"Read(**),Edit(**)",
			"--disallowedTools",
			"Bash",
		]);
	});

	it("maps Cyrus's PermissionMode 'bypass' to Claude's 'bypassPermissions'", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				permissions: { mode: "bypass" },
			},
			{ userPrompt: "do it" },
		);
		expect(command.args).toContain("--permission-mode");
		const idx = command.args.indexOf("--permission-mode");
		expect(command.args[idx + 1]).toBe("bypassPermissions");
	});

	it("builds a Codex JSON command", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				harness: { kind: "codex" },
				model: "gpt-5.3-codex",
				systemPrompt: "Use the repo style",
				permissions: { mode: "auto" },
			},
			{ userPrompt: "Implement the feature" },
		);

		expect(command.command).toBe("codex");
		expect(command.args).toEqual([
			"exec",
			"--json",
			"--skip-git-repo-check",
			"--model",
			"gpt-5.3-codex",
			"-c",
			'developer_instructions="Use the repo style"',
			"-c",
			'approval_policy="auto"',
			"Implement the feature",
		]);
	});

	it("builds a Cursor command that spawns the vendored SDK driver", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				harness: { kind: "cursor" },
				model: "composer-2",
				permissions: { mode: "ask" },
			},
			{ userPrompt: "Patch the bug" },
		);

		// We now spawn `node <@cyrus/cursor-runner>` instead of `cursor-agent`
		// so the stdout stream is `@cursor/sdk`'s `SDKMessage` directly.
		// The runner path is resolved at module-load time via
		// `createRequire(import.meta.url).resolve("@cyrus/cursor-runner")`;
		// pnpm/npm resolves through workspace symlinks to a real on-disk
		// path that doesn't necessarily contain the package name literal,
		// so we assert the entry filename instead.
		expect(command.command).toBe("node");
		const runnerPath = command.args[0]!;
		expect(runnerPath).toMatch(/cursor-(sdk-)?runner[/\\]dist[/\\]index\.js$/);
		expect(command.args.slice(1)).toEqual([
			"--prompt",
			"Patch the bug",
			"--model",
			"composer-2",
			"--cwd",
			"/tmp/worktree",
		]);
	});

	it("builds a Gemini command with env-backed system prompt", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				harness: { kind: "gemini" },
				systemPrompt: "System text",
				permissions: { mode: "bypass" },
			},
			{ userPrompt: "Analyze this" },
		);

		expect(command.command).toBe("gemini");
		expect(command.args).toEqual([
			"--output-format",
			"stream-json",
			"--model",
			"gemini-2.5-pro",
			"--yolo",
			"--approval-mode",
			"bypass",
			"-p",
			"Analyze this",
		]);
		expect(command.env?.GEMINI_SYSTEM_MD).toBe("System text");
	});

	it("supports harness command and arg overrides", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				harness: {
					kind: "codex",
					command: "/opt/bin/codex-dev",
					args: ["--config", "profile=dev"],
				},
			},
			{ userPrompt: "Run it" },
		);

		expect(command.command).toBe("/opt/bin/codex-dev");
		expect(command.args.slice(0, 2)).toEqual(["--config", "profile=dev"]);
		expect(command.args.slice(2)).toEqual([
			"exec",
			"--json",
			"--skip-git-repo-check",
			"Run it",
		]);
	});

	it("parses JSON stdout transcript lines", () => {
		const adapter = getHarnessAdapter("gemini");
		const event = adapter.parseStdoutLine(
			JSON.stringify({
				type: "tool_use",
				tool_name: "read_file",
				parameters: { path: "src/index.ts" },
			}),
			{
				sessionId: "session-1",
				harness: "gemini",
				now: () => new Date("2026-05-14T12:00:00.000Z"),
			},
		);

		expect(event).toMatchObject({
			sessionId: "session-1",
			harness: "gemini",
			timestamp: "2026-05-14T12:00:00.000Z",
			kind: "tool_use",
			normalized: {
				type: "tool_use",
				toolName: "read_file",
			},
		});
	});

	it("parses non-JSON stdout as text events and ignores blank lines", () => {
		const adapter = getHarnessAdapter("claude");

		expect(
			adapter.parseStdoutLine("   ", {
				sessionId: "session-1",
				harness: "claude",
			}),
		).toBeUndefined();
		expect(
			adapter.parseStdoutLine("plain output", {
				sessionId: "session-1",
				harness: "claude",
			}),
		).toMatchObject({
			sessionId: "session-1",
			harness: "claude",
			kind: "text",
			raw: "plain output",
		});
	});
});
