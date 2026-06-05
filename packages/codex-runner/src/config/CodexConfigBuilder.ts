import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedCodexConfig } from "../backend/types.js";
import type {
	CodexConfigOverrides,
	CodexConfigValue,
	CodexRunnerConfig,
} from "../types.js";
import { buildCodexMcpServersConfig } from "./mcpConfigTranslator.js";

function getDefaultReasoningEffortForModel(
	model?: string,
): CodexRunnerConfig["modelReasoningEffort"] | undefined {
	// All gpt-5 variants (including plain "gpt-5") reject xhigh; pin to "high".
	return /^gpt-5/i.test(model || "") ? "high" : undefined;
}

/**
 * Assembles a transport-neutral {@link ResolvedCodexConfig} from a
 * {@link CodexRunnerConfig}. Single responsibility: configuration resolution
 * (model fallback, sandbox, reasoning effort, MCP translation, env, home dir).
 * Produces no side effects beyond ensuring the Codex home directory exists.
 */
export class CodexConfigBuilder {
	constructor(private readonly config: CodexRunnerConfig) {}

	/** The (possibly fallback-substituted) model resolved by {@link build}. */
	get resolvedModel(): string | undefined {
		return this.config.model;
	}

	async build(): Promise<ResolvedCodexConfig> {
		await this.resolveModelWithFallback();

		const codexHome = this.resolveCodexHome();
		const reasoningEffort =
			this.config.modelReasoningEffort ??
			getDefaultReasoningEffortForModel(this.config.model);
		const webSearchMode =
			this.config.webSearchMode ??
			(this.config.includeWebSearch ? "live" : undefined);

		return {
			model: this.config.model,
			sandbox: this.config.sandbox || "workspace-write",
			workingDirectory: this.config.workingDirectory,
			approvalPolicy: this.config.askForApproval || "never",
			skipGitRepoCheck: this.config.skipGitRepoCheck ?? true,
			modelReasoningEffort: reasoningEffort,
			webSearchMode,
			additionalDirectories: this.getAdditionalDirectories(),
			developerInstructions:
				(this.config.appendSystemPrompt ?? "").trim() || undefined,
			configOverrides: this.buildConfigOverrides(),
			env: this.buildEnvOverride(codexHome),
			codexHome,
			codexPath: this.config.codexPath,
			outputSchema: this.config.outputSchema,
			resumeSessionId: this.config.resumeSessionId,
		};
	}

	private getAdditionalDirectories(): string[] {
		const workingDirectory = this.config.workingDirectory;
		const uniqueDirectories = new Set<string>();
		for (const directory of this.config.allowedDirectories || []) {
			if (!directory || directory === workingDirectory) {
				continue;
			}
			uniqueDirectories.add(directory);
		}
		return [...uniqueDirectories];
	}

	private resolveCodexHome(): string {
		const codexHome =
			this.config.codexHome ||
			process.env.CODEX_HOME ||
			join(homedir(), ".codex");
		mkdirSync(codexHome, { recursive: true });
		return codexHome;
	}

	private buildEnvOverride(
		codexHome: string,
	): Record<string, string> | undefined {
		if (!this.config.codexHome) {
			return undefined;
		}
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (typeof value === "string") {
				env[key] = value;
			}
		}
		env.CODEX_HOME = codexHome;
		return env;
	}

	/**
	 * Global Codex config overrides: MCP servers + a workspace-write sandbox that
	 * keeps outbound network enabled (so git/gh work without danger-full-access).
	 * Note: `developer_instructions` is surfaced separately on
	 * {@link ResolvedCodexConfig.developerInstructions} so each backend can place
	 * it on its native field.
	 */
	private buildConfigOverrides(): CodexConfigOverrides | undefined {
		const configOverrides = this.config.configOverrides
			? { ...this.config.configOverrides }
			: {};

		const mcpServers = buildCodexMcpServersConfig({
			workingDirectory: this.config.workingDirectory,
			mcpConfigPath: this.config.mcpConfigPath,
			mcpConfig: this.config.mcpConfig,
			allowedTools: this.config.allowedTools,
		});
		if (mcpServers) {
			const existingMcpServers = configOverrides.mcp_servers;
			if (
				existingMcpServers &&
				typeof existingMcpServers === "object" &&
				!Array.isArray(existingMcpServers)
			) {
				configOverrides.mcp_servers = {
					...(existingMcpServers as Record<string, CodexConfigValue>),
					...mcpServers,
				};
			} else {
				configOverrides.mcp_servers = mcpServers;
			}
		}

		const sandboxWorkspaceWrite = configOverrides.sandbox_workspace_write;
		if (
			sandboxWorkspaceWrite &&
			typeof sandboxWorkspaceWrite === "object" &&
			!Array.isArray(sandboxWorkspaceWrite)
		) {
			configOverrides.sandbox_workspace_write = {
				...sandboxWorkspaceWrite,
				network_access:
					(sandboxWorkspaceWrite as { network_access?: boolean })
						.network_access ?? true,
			};
		} else if (!sandboxWorkspaceWrite) {
			configOverrides.sandbox_workspace_write = { network_access: true };
		}

		return Object.keys(configOverrides).length > 0
			? configOverrides
			: undefined;
	}

	/**
	 * If the configured model is unreachable via the OpenAI API, swap to the
	 * fallback model before starting. Skipped when there is no API key (Codex
	 * native auth handles access) or when the user has a ChatGPT subscription.
	 */
	private async resolveModelWithFallback(): Promise<void> {
		const model = this.config.model;
		const fallback = this.config.fallbackModel;
		if (!model || !fallback || fallback === model) return;

		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) return;

		if (await this.hasCodexSubscription()) return;

		const baseUrl = (
			process.env.OPENAI_BASE_URL ||
			process.env.OPENAI_API_BASE ||
			"https://api.openai.com/v1"
		).replace(/\/+$/, "");

		try {
			const response = await fetch(
				`${baseUrl}/models/${encodeURIComponent(model)}`,
				{
					method: "GET",
					headers: { Authorization: `Bearer ${apiKey}` },
					signal: AbortSignal.timeout(10_000),
				},
			);
			if (response.status === 404) {
				console.log(
					`[CodexRunner] Model "${model}" not found (404), falling back to "${fallback}"`,
				);
				this.config.model = fallback;
			}
		} catch {
			// Network error or timeout — proceed with the original model and let
			// the backend surface any downstream failure.
		}
	}

	private async hasCodexSubscription(): Promise<boolean> {
		const codexBin = this.config.codexPath || "codex";
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execFileAsync = promisify(execFile);
			const { stdout, stderr } = await execFileAsync(
				codexBin,
				["login", "status"],
				{ timeout: 5_000 },
			);
			const result = /logged in using chatgpt/i.test(stdout + stderr);
			console.log(
				`[CodexRunner] hasCodexSubscription: ${result} (stdout: "${stdout.trim()}"${stderr.trim() ? `, stderr: "${stderr.trim()}"` : ""})`,
			);
			return result;
		} catch (error) {
			console.warn(
				`[CodexRunner] hasCodexSubscription error (returning false): ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}
}
