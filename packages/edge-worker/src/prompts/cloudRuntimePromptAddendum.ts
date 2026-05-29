/**
 * Optional system-prompt addendum for Cyrus-managed cloud runtimes.
 *
 * On our managed cloud runtimes the dev environment's system-wide packages
 * (`apt` / global `npm`) are provisioned out-of-band from a curated list the
 * user controls at https://app.atcyrus.com/settings/packages. When the agent
 * finds a package missing, installing it ad-hoc inside the session won't
 * persist and may fail on permissions — the correct remedy is to tell the user
 * to add it via that settings page.
 *
 * Only injected when the environment variable `CYRUS_CLOUD_RUNTIME` is set to a
 * truthy value. cyrus-hosted sets this on cloud-runtime droplets and leaves it
 * unset for self-host runtimes (where the user manages their own packages).
 */
export const CLOUD_RUNTIME_PROMPT_ADDENDUM = `
<cloud_runtime_packages>
You are running on a Cyrus-managed cloud runtime. The system-wide packages
available in this environment (\`apt\` packages and global \`npm\` packages) can be
extended in the Cyrus dashboard.

If you discover that a system package, tool, or CLI binary you need is **not
installed** (for example \`command not found\`, a missing \`apt\` package, or a
missing global \`npm\` package), do NOT try to install it yourself with
\`sudo apt install\` / \`npm install -g\` — changes like that will not persist
across runtime restarts and may fail due to permissions.

Instead:
- Tell the user to visit https://app.atcyrus.com/settings/packages and add the
  required \`apt\` or \`npm\` package(s) there.
- Name the exact package(s) you need and briefly explain why.
- Continue with any work you can complete without the missing package, and
  clearly call out what remains blocked until they install it.
</cloud_runtime_packages>
`.trim();

/**
 * Append the cloud-runtime addendum to a system prompt fragment, but only when
 * the `CYRUS_CLOUD_RUNTIME` env var is truthy. Returns the existing prompt
 * unchanged otherwise.
 */
export function appendCloudRuntimeAddendum(
	existing: string | undefined | null,
): string {
	const base = (existing ?? "").trimEnd();
	if (!isCloudRuntimeEnabled()) {
		return existing ?? "";
	}
	if (base.length === 0) return CLOUD_RUNTIME_PROMPT_ADDENDUM;
	return `${base}\n\n${CLOUD_RUNTIME_PROMPT_ADDENDUM}`;
}

function isCloudRuntimeEnabled(): boolean {
	const raw = process.env.CYRUS_CLOUD_RUNTIME;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}
