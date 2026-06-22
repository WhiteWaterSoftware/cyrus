import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

vi.mock("fs/promises");
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-mcp-tools");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(() => ({
			loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
			saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
		})),
	};
});

/**
 * A prompted webhook whose downstream handling throws (e.g. the Linear
 * "fetch full issue details" call fails) must NOT silently drop the user's
 * message. The EdgeWorker should surface a terminal error activity so the
 * Linear session stops spinning and the user knows to retry.
 */
describe("EdgeWorker - Prompted activity error recovery", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let mockAgentSessionManager: any;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		allowedTools: ["Read", "Edit"],
		labelPrompts: {},
		teamKeys: ["TEST"],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		vi.mocked(createCyrusToolsServer).mockImplementation(() => {
			return { server: {} } as any;
		});

		vi.mocked(ClaudeRunner).mockImplementation(
			() =>
				({
					supportsStreamingInput: true,
					stop: vi.fn(),
					isStreaming: vi.fn().mockReturnValue(false),
					isRunning: vi.fn().mockReturnValue(false),
				}) as any,
		);

		mockAgentSessionManager = {
			getSession: vi.fn().mockReturnValue(null),
			getSessionsByIssueId: vi.fn().mockReturnValue([]),
			createResponseActivity: vi.fn().mockResolvedValue(undefined),
			createErrorActivity: vi.fn().mockResolvedValue(undefined),
			requestSessionStop: vi.fn(),
			setActivitySink: vi.fn(),
			on: vi.fn(),
		};

		vi.mocked(AgentSessionManager).mockImplementation(
			() => mockAgentSessionManager,
		);

		vi.mocked(SharedApplicationServer).mockImplementation(
			() =>
				({
					start: vi.fn().mockResolvedValue(undefined),
					stop: vi.fn().mockResolvedValue(undefined),
					getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
					getWebhookUrl: vi
						.fn()
						.mockReturnValue("http://localhost:3456/webhook"),
					registerOAuthCallbackHandler: vi.fn(),
				}) as any,
		);

		vi.mocked(LinearClient).mockImplementation(
			() =>
				({
					users: {
						me: vi
							.fn()
							.mockResolvedValue({ id: "user-123", name: "Test User" }),
					},
				}) as any,
		);

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/TEST-123",
					isGitWorktree: false,
				}),
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);
		(edgeWorker as any).repositories.set("test-repo", mockRepository);
		(edgeWorker as any).agentSessionManager = mockAgentSessionManager;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createPromptedWebhook(overrides: any = {}) {
		return {
			type: "AgentSessionEvent",
			action: "prompted",
			createdAt: new Date().toISOString(),
			organizationId: "test-workspace",
			agentSession: {
				id: "agent-session-123",
				issue: {
					id: "issue-123",
					identifier: "TEST-123",
					title: "Test Issue",
				},
				creator: { name: "Test User" },
				...overrides.agentSession,
			},
			agentActivity: {
				content: { body: "Take a look at the error" },
				sourceCommentId: "comment-123",
				...overrides.agentActivity,
			},
			...overrides,
		};
	}

	it("posts a terminal error activity when downstream handling throws", async () => {
		// Reach handleNormalPromptedActivity with a resolved repository + access...
		vi.spyOn(edgeWorker as any, "getCachedRepositories").mockReturnValue([
			mockRepository,
		]);
		vi.spyOn(edgeWorker as any, "checkUserAccess").mockReturnValue({
			allowed: true,
		});
		// ...then make the normal-prompt path throw (simulating the Linear
		// "Failed to fetch full issue details" failure that previously went dark).
		vi.spyOn(
			edgeWorker as any,
			"handleNormalPromptedActivity",
		).mockRejectedValue(
			new Error("Failed to fetch full issue details for issue-123"),
		);

		const webhook = createPromptedWebhook();

		// Should not reject — the error is caught and surfaced.
		await expect(
			(edgeWorker as any).handleUserPromptedAgentActivity(webhook),
		).resolves.toBeUndefined();

		expect(mockAgentSessionManager.createErrorActivity).toHaveBeenCalledTimes(
			1,
		);
		expect(mockAgentSessionManager.createErrorActivity).toHaveBeenCalledWith(
			"agent-session-123",
			expect.stringContaining("error"),
		);
	});

	it("does not post an error activity when handling succeeds", async () => {
		vi.spyOn(edgeWorker as any, "getCachedRepositories").mockReturnValue([
			mockRepository,
		]);
		vi.spyOn(edgeWorker as any, "checkUserAccess").mockReturnValue({
			allowed: true,
		});
		vi.spyOn(
			edgeWorker as any,
			"handleNormalPromptedActivity",
		).mockResolvedValue(undefined);

		await (edgeWorker as any).handleUserPromptedAgentActivity(
			createPromptedWebhook(),
		);

		expect(mockAgentSessionManager.createErrorActivity).not.toHaveBeenCalled();
	});
});
