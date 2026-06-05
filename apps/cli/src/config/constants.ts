/**
 * Application constants
 */

/**
 * Default server port for OAuth callbacks and webhooks
 */
export const DEFAULT_SERVER_PORT = 3456;

/**
 * Parse a port number from string with validation
 */
export function parsePort(
	value: string | undefined,
	defaultPort: number,
): number {
	if (!value) return defaultPort;
	const parsed = parseInt(value, 10);
	return Number.isNaN(parsed) || parsed < 1 || parsed > 65535
		? defaultPort
		: parsed;
}

/**
 * Resolve maxConcurrentSessions from env (string) and config (number),
 * floored at 1. Invalid env values silently fall back to the config value
 * so a typo in halo.env can't deadlock the runner.
 */
export function parseMaxConcurrent(
	envValue: string | undefined,
	configValue: number | undefined,
): number | undefined {
	if (envValue !== undefined && envValue.trim() !== "") {
		const parsed = parseInt(envValue, 10);
		if (!Number.isNaN(parsed) && parsed >= 1) return parsed;
	}
	return configValue;
}
