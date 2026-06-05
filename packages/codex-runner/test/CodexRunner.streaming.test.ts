import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CodexBackend, CodexUserInput } from "../src/backend/types.js";
import { CodexRunner } from "../src/CodexRunner.js";

/** Minimal fake backend for exercising runner-level streaming wiring. */
class FakeBackend extends EventEmitter implements CodexBackend {
	supportsSteer: boolean;
	steerCalls: CodexUserInput[][] = [];
	private active: boolean;
	constructor(opts: { supportsSteer: boolean; active: boolean }) {
		super();
		this.supportsSteer = opts.supportsSteer;
		this.active = opts.active;
	}
	async open() {
		return { threadId: "t" };
	}
	async runTurn() {}
	steer = vi.fn(async (input: CodexUserInput[]) => {
		this.steerCalls.push(input);
	});
	isTurnActive() {
		return this.active;
	}
	async interrupt() {}
	async close() {}
}

describe("CodexRunner streaming input selection", () => {
	it("does not support streaming input with the default (exec) backend", () => {
		const runner = new CodexRunner({
			workingDirectory: "/tmp",
			cyrusHome: "/tmp",
		});
		expect(runner.supportsStreamingInput).toBe(false);
		expect(() => runner.addStreamMessage("hi")).toThrow(
			/does not support streaming input/i,
		);
	});

	it("supports streaming input when useAppServer is set", () => {
		const runner = new CodexRunner({
			workingDirectory: "/tmp",
			cyrusHome: "/tmp",
			useAppServer: true,
		});
		expect(runner.supportsStreamingInput).toBe(true);
	});

	it("honors the CODEX_USE_APP_SERVER env flag", () => {
		const prev = process.env.CODEX_USE_APP_SERVER;
		process.env.CODEX_USE_APP_SERVER = "1";
		try {
			const runner = new CodexRunner({
				workingDirectory: "/tmp",
				cyrusHome: "/tmp",
			});
			expect(runner.supportsStreamingInput).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.CODEX_USE_APP_SERVER;
			else process.env.CODEX_USE_APP_SERVER = prev;
		}
	});

	it("steers the active turn when a stream message arrives mid-turn", () => {
		const runner = new CodexRunner({
			workingDirectory: "/tmp",
			cyrusHome: "/tmp",
			useAppServer: true,
		});
		const backend = new FakeBackend({ supportsSteer: true, active: true });
		(runner as unknown as { backend: CodexBackend }).backend = backend;

		runner.addStreamMessage("fix the auth bug too");

		expect(backend.steer).toHaveBeenCalledTimes(1);
		expect(backend.steerCalls[0]).toEqual([
			{ type: "text", text: "fix the auth bug too" },
		]);
		expect(runner.isStreaming()).toBe(true);
	});

	it("throws when streaming a message with no active turn", () => {
		const runner = new CodexRunner({
			workingDirectory: "/tmp",
			cyrusHome: "/tmp",
			useAppServer: true,
		});
		const backend = new FakeBackend({ supportsSteer: true, active: false });
		(runner as unknown as { backend: CodexBackend }).backend = backend;

		expect(() => runner.addStreamMessage("late comment")).toThrow(
			/no active codex turn/i,
		);
		expect(runner.isStreaming()).toBe(false);
	});
});
