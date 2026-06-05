import { createRequire } from "node:module";
import path from "node:path";

const CODEX_NPM_NAME = "@openai/codex";
const CODEX_SDK_NPM_NAME = "@openai/codex-sdk";

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
	"x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
	"aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
	"x86_64-apple-darwin": "@openai/codex-darwin-x64",
	"aarch64-apple-darwin": "@openai/codex-darwin-arm64",
	"x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
	"aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

function targetTripleFor(
	platform: NodeJS.Platform,
	arch: string,
): string | null {
	switch (platform) {
		case "linux":
		case "android":
			if (arch === "x64") return "x86_64-unknown-linux-musl";
			if (arch === "arm64") return "aarch64-unknown-linux-musl";
			return null;
		case "darwin":
			if (arch === "x64") return "x86_64-apple-darwin";
			if (arch === "arm64") return "aarch64-apple-darwin";
			return null;
		case "win32":
			if (arch === "x64") return "x86_64-pc-windows-msvc";
			if (arch === "arm64") return "aarch64-pc-windows-msvc";
			return null;
		default:
			return null;
	}
}

/**
 * Resolve the path to the Codex CLI binary, mirroring the resolution the
 * `@openai/codex-sdk` performs internally. This ensures the app-server backend
 * spawns the SAME vendored binary the exec backend uses.
 *
 * @param override Explicit binary path (from config); returned as-is when set.
 */
export function resolveCodexBinary(override?: string): string {
	if (override) {
		return override;
	}

	const { platform, arch } = process;
	const targetTriple = targetTripleFor(platform, arch);
	if (!targetTriple) {
		throw new Error(`Unsupported platform: ${platform} (${arch})`);
	}
	const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
	if (!platformPackage) {
		throw new Error(`Unsupported target triple: ${targetTriple}`);
	}

	let vendorRoot: string;
	try {
		// `@openai/codex` is a dependency of `@openai/codex-sdk`, not of this
		// package, so resolve it via the SDK (which this package does depend on),
		// mirroring how the SDK locates the binary internally. The SDK exposes
		// only an ESM `import` export, so use `import.meta.resolve` for its entry
		// (CJS `require.resolve` would reject the export map), then chain with
		// `createRequire` from there.
		const sdkEntry = import.meta.resolve(CODEX_SDK_NPM_NAME);
		const sdkRequire = createRequire(sdkEntry);
		const codexPackageJsonPath = sdkRequire.resolve(
			`${CODEX_NPM_NAME}/package.json`,
		);
		const codexRequire = createRequire(codexPackageJsonPath);
		const platformPackageJsonPath = codexRequire.resolve(
			`${platformPackage}/package.json`,
		);
		vendorRoot = path.join(path.dirname(platformPackageJsonPath), "vendor");
	} catch {
		throw new Error(
			`Unable to locate Codex CLI binaries. Ensure ${CODEX_NPM_NAME} is installed with optional dependencies.`,
		);
	}

	const archRoot = path.join(vendorRoot, targetTriple);
	const codexBinaryName = platform === "win32" ? "codex.exe" : "codex";
	return path.join(archRoot, "codex", codexBinaryName);
}
