import { afterEach, describe, expect, it, vi } from "vitest";
import { retryWithBackoff } from "../src/utils/retry.js";

describe("retryWithBackoff", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns the result without retrying when the first attempt succeeds", async () => {
		const fn = vi.fn().mockResolvedValue("ok");

		await expect(retryWithBackoff(fn)).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("retries transient failures and resolves once an attempt succeeds", async () => {
		vi.useFakeTimers();
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error("transient 1"))
			.mockRejectedValueOnce(new Error("transient 2"))
			.mockResolvedValue("recovered");

		const promise = retryWithBackoff(fn, { baseDelayMs: 10 });
		await vi.runAllTimersAsync();

		await expect(promise).resolves.toBe("recovered");
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("rethrows the last error after exhausting all attempts", async () => {
		vi.useFakeTimers();
		const fn = vi.fn().mockRejectedValue(new Error("always fails"));

		const promise = retryWithBackoff(fn, { retries: 2, baseDelayMs: 10 });
		// Attach a rejection handler before advancing timers to avoid an
		// unhandled rejection warning, then assert on it.
		const settled = promise.catch((e) => e);
		await vi.runAllTimersAsync();

		const error = await settled;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("always fails");
		// initial attempt + 2 retries
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("honors a custom retries count", async () => {
		vi.useFakeTimers();
		const fn = vi.fn().mockRejectedValue(new Error("nope"));

		const settled = retryWithBackoff(fn, { retries: 4, baseDelayMs: 1 }).catch(
			(e) => e,
		);
		await vi.runAllTimersAsync();

		await settled;
		expect(fn).toHaveBeenCalledTimes(5);
	});

	it("invokes onRetry before each retry with the attempt number", async () => {
		vi.useFakeTimers();
		const onRetry = vi.fn();
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error("first"))
			.mockResolvedValue("ok");

		const promise = retryWithBackoff(fn, { baseDelayMs: 5, onRetry });
		await vi.runAllTimersAsync();
		await promise;

		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1);
	});
});
