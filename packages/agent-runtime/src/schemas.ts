import { z } from "zod";

export const HarnessKindSchema = z.enum([
	"claude",
	"codex",
	"cursor",
	"gemini",
	"pi",
	"opencode",
]);

export const PermissionModeSchema = z.enum([
	"default",
	"plan",
	"ask",
	"auto",
	"bypass",
]);

export const NetworkEgressModeSchema = z.enum([
	"default",
	"disabled",
	"proxied",
	"unrestricted",
]);

export const RuntimeNetworkEgressConfigSchema = z.object({
	mode: NetworkEgressModeSchema,
	proxyUrl: z.string().optional(),
	allowedHosts: z.array(z.string()).optional(),
	deniedHosts: z.array(z.string()).optional(),
});

export const RuntimeSandboxConfigSchema = z.object({
	provider: z.string().min(1),
	id: z.string().optional(),
	name: z.string().optional(),
	namespace: z.string().optional(),
	workingDirectory: z.string().optional(),
	templateId: z.string().optional(),
	timeoutMs: z.number().int().positive().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	volumes: z
		.array(
			z.object({
				name: z.string(),
				mountPath: z.string(),
				source: z.string().optional(),
				kind: z.enum(["bind", "fuse", "provider"]).optional(),
				readOnly: z.boolean().optional(),
			}),
		)
		.optional(),
	networkEgress: RuntimeNetworkEgressConfigSchema.optional(),
});

export const RuntimeHarnessConfigSchema = z.object({
	kind: HarnessKindSchema,
	model: z.string().optional(),
	command: z.string().optional(),
	args: z.array(z.string()).optional(),
});

export const CreateAgentSessionConfigSchema = z.object({
	sessionId: z.string().optional(),
	harness: z.union([HarnessKindSchema, RuntimeHarnessConfigSchema]),
	model: z.string().optional(),
	systemPrompt: z.string().optional(),
	agentSessionsRoot: z.string().optional(),
	env: z.record(z.string(), z.string()).optional(),
	secrets: z
		.record(
			z.string(),
			z.union([
				z.string(),
				z.object({
					value: z.string(),
					redact: z.boolean().optional(),
				}),
			]),
		)
		.optional(),
	packages: z
		.object({
			system: z.array(z.string()).optional(),
			npm: z.array(z.string()).optional(),
			commands: z.array(z.string()).optional(),
		})
		.optional(),
	files: z
		.array(
			z.object({
				path: z.string().min(1),
				content: z.string(),
				sensitive: z.boolean().optional(),
			}),
		)
		.optional(),
	folders: z
		.array(
			z.object({
				source: z.string().min(1),
				mountPath: z.string().min(1),
				access: z.enum(["read", "readwrite"]).optional(),
				exclude: z.array(z.string()).optional(),
			}),
		)
		.optional(),
	repositories: z
		.array(
			z.object({
				source: z.string().min(1),
				mountPath: z.string().min(1),
				branch: z.string().min(1).optional(),
				access: z.enum(["read", "readwrite"]).optional(),
				depth: z.number().int().positive().optional(),
			}),
		)
		.optional(),
	mcps: z.record(z.string(), z.unknown()).optional(),
	permissions: z
		.object({
			mode: PermissionModeSchema.optional(),
			allowedTools: z.array(z.string()).optional(),
			disallowedTools: z.array(z.string()).optional(),
		})
		.optional(),
	memory: z
		.object({
			enabled: z.boolean().optional(),
			directory: z.string().optional(),
			namespace: z.string().optional(),
		})
		.optional(),
	sandbox: RuntimeSandboxConfigSchema.optional(),
	networkEgress: RuntimeNetworkEgressConfigSchema.optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	interactiveInput: z.boolean().optional(),
});
