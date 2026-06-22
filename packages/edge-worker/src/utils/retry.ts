/**
 * Retry an async operation with exponential backoff.
 *
 * Intended for transient failures of external calls (e.g. a flaky Linear API
 * fetch) where a single attempt would otherwise propagate an error. The
 * operation is attempted up to `retries + 1` times; the last error is rethrown
 * if every attempt fails.
 */
export interface RetryOptions {
	/** Number of retries after the initial attempt (default 2 → 3 attempts total). */
	retries?: number;
	/** Base delay before the first retry, in milliseconds (default 500). */
	baseDelayMs?: number;
	/** Multiplier applied to the delay after each retry (default 2). */
	factor?: number;
	/** Called before each retry with the error and the upcoming attempt number (1-indexed). */
	onRetry?: (error: unknown, attempt: number) => void;
}

export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const { retries = 2, baseDelayMs = 500, factor = 2, onRetry } = options;

	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (attempt === retries) {
				break;
			}
			onRetry?.(error, attempt + 1);
			const delay = baseDelayMs * factor ** attempt;
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	throw lastError;
}
