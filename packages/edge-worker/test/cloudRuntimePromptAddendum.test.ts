import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendCloudRuntimeAddendum,
	CLOUD_RUNTIME_PROMPT_ADDENDUM,
} from "../src/prompts/cloudRuntimePromptAddendum.js";

describe("cloud-runtime prompt addendum", () => {
	const original = process.env.CYRUS_CLOUD_RUNTIME;

	beforeEach(() => {
		delete process.env.CYRUS_CLOUD_RUNTIME;
	});

	afterEach(() => {
		if (original === undefined) delete process.env.CYRUS_CLOUD_RUNTIME;
		else process.env.CYRUS_CLOUD_RUNTIME = original;
	});

	it("includes the packages settings link and apt/npm guidance", () => {
		expect(CLOUD_RUNTIME_PROMPT_ADDENDUM).toContain(
			"https://app.atcyrus.com/settings/packages",
		);
		expect(CLOUD_RUNTIME_PROMPT_ADDENDUM).toMatch(/apt/);
		expect(CLOUD_RUNTIME_PROMPT_ADDENDUM).toMatch(/npm/);
	});

	it("returns the existing prompt unchanged when the env var is unset", () => {
		expect(appendCloudRuntimeAddendum("You are Cyrus.")).toBe("You are Cyrus.");
		expect(appendCloudRuntimeAddendum(undefined)).toBe("");
		expect(appendCloudRuntimeAddendum(null)).toBe("");
	});

	it("returns the existing prompt unchanged when the env var is falsy", () => {
		process.env.CYRUS_CLOUD_RUNTIME = "false";
		expect(appendCloudRuntimeAddendum("You are Cyrus.")).toBe("You are Cyrus.");
		process.env.CYRUS_CLOUD_RUNTIME = "0";
		expect(appendCloudRuntimeAddendum("You are Cyrus.")).toBe("You are Cyrus.");
	});

	it("appends the addendum with a blank-line separator when enabled", () => {
		process.env.CYRUS_CLOUD_RUNTIME = "true";
		const result = appendCloudRuntimeAddendum("You are Cyrus.");
		expect(result.startsWith("You are Cyrus.\n\n")).toBe(true);
		expect(result.endsWith(CLOUD_RUNTIME_PROMPT_ADDENDUM)).toBe(true);
	});

	it("returns the addendum verbatim when enabled with no base prompt", () => {
		process.env.CYRUS_CLOUD_RUNTIME = "1";
		expect(appendCloudRuntimeAddendum(undefined)).toBe(
			CLOUD_RUNTIME_PROMPT_ADDENDUM,
		);
		expect(appendCloudRuntimeAddendum("")).toBe(CLOUD_RUNTIME_PROMPT_ADDENDUM);
	});

	it("accepts common truthy spellings", () => {
		for (const value of ["true", "1", "yes", "TRUE", " Yes "]) {
			process.env.CYRUS_CLOUD_RUNTIME = value;
			expect(appendCloudRuntimeAddendum("base")).toContain(
				CLOUD_RUNTIME_PROMPT_ADDENDUM,
			);
		}
	});
});
