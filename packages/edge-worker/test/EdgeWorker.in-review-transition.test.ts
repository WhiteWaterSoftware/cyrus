import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
}));

vi.mock("cyrus-claude-runner");
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
vi.mock("file-type");

const WORKSPACE_ID = "test-workspace";

const mockRepository: RepositoryConfig = {
	id: "test-repo",
	name: "Test Repo",
	repositoryPath: "/test/repo",
	workspaceBaseDir: "/test/workspaces",
	baseBranch: "main",
	linearWorkspaceId: WORKSPACE_ID,
	isActive: true,
	allowedTools: ["Read", "Edit"],
};

/**
 * Build a fake Linear issue for the workflow-state methods. The methods
 * only read `id`, `identifier`, `state`, and `team`.
 */
function makeIssue(opts: {
	currentStateId?: string;
	currentStateName?: string;
}) {
	return {
		id: "issue-123",
		identifier: "TEST-123",
		state: Promise.resolve(
			opts.currentStateId
				? {
						id: opts.currentStateId,
						name: opts.currentStateName ?? opts.currentStateId,
						type: "started",
					}
				: undefined,
		),
		team: Promise.resolve({ id: "team-123" }),
	} as any;
}

describe("EdgeWorker - In Review transition", () => {
	let edgeWorker: EdgeWorker;
	let mockIssueTracker: {
		fetchWorkflowStates: ReturnType<typeof vi.fn>;
		updateIssue: ReturnType<typeof vi.fn>;
	};

	function setWorkflowStates(
		nodes: Array<{
			id: string;
			name: string;
			type: string;
			position: number;
		}>,
	) {
		mockIssueTracker.fetchWorkflowStates.mockResolvedValue({ nodes });
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		vi.mocked(LinearClient).mockImplementation(() => ({}) as any);
		vi.mocked(ClaudeRunner).mockImplementation(() => ({}) as any);
		vi.mocked(AgentSessionManager).mockImplementation(
			() =>
				({
					on: vi.fn(),
					getSession: vi.fn(),
				}) as any,
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
		vi.mocked(LinearEventTransport).mockImplementation(
			() =>
				({
					register: vi.fn(),
					on: vi.fn(),
					removeAllListeners: vi.fn(),
				}) as any,
		);

		const mockConfig: EdgeWorkerConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				[WORKSPACE_ID]: { linearToken: "test-token" },
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);

		mockIssueTracker = {
			fetchWorkflowStates: vi.fn(),
			updateIssue: vi.fn().mockResolvedValue({ success: true }),
		};
		(edgeWorker as any).issueTrackers.set(WORKSPACE_ID, mockIssueTracker);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('prefers a started state named "In Review"', async () => {
		setWorkflowStates([
			{ id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
			{ id: "s-prog", name: "In Progress", type: "started", position: 1 },
			{ id: "s-review", name: "In Review", type: "started", position: 2 },
			{ id: "s-done", name: "Done", type: "completed", position: 3 },
		]);

		await (edgeWorker as any).moveIssueToReviewState(
			makeIssue({ currentStateId: "s-prog", currentStateName: "In Progress" }),
			WORKSPACE_ID,
		);

		expect(mockIssueTracker.updateIssue).toHaveBeenCalledWith("issue-123", {
			stateId: "s-review",
		});
	});

	it("matches the In Review name case-insensitively even at a lower position", async () => {
		setWorkflowStates([
			{ id: "s-prog", name: "In Progress", type: "started", position: 5 },
			{ id: "s-review", name: "in review", type: "started", position: 1 },
		]);

		await (edgeWorker as any).moveIssueToReviewState(
			makeIssue({ currentStateId: "s-prog" }),
			WORKSPACE_ID,
		);

		expect(mockIssueTracker.updateIssue).toHaveBeenCalledWith("issue-123", {
			stateId: "s-review",
		});
	});

	it("falls back to the highest-position started state when no name matches", async () => {
		setWorkflowStates([
			{ id: "s-prog", name: "Working", type: "started", position: 1 },
			{ id: "s-qa", name: "QA", type: "started", position: 4 },
		]);

		await (edgeWorker as any).moveIssueToReviewState(
			makeIssue({ currentStateId: "s-prog" }),
			WORKSPACE_ID,
		);

		expect(mockIssueTracker.updateIssue).toHaveBeenCalledWith("issue-123", {
			stateId: "s-qa",
		});
	});

	it("no-ops when only one started state exists (no distinct review state)", async () => {
		setWorkflowStates([
			{ id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
			{ id: "s-prog", name: "In Progress", type: "started", position: 1 },
			{ id: "s-done", name: "Done", type: "completed", position: 2 },
		]);

		await (edgeWorker as any).moveIssueToReviewState(
			makeIssue({ currentStateId: "s-prog" }),
			WORKSPACE_ID,
		);

		expect(mockIssueTracker.updateIssue).not.toHaveBeenCalled();
	});

	it("no-ops when the issue is already in the review state", async () => {
		setWorkflowStates([
			{ id: "s-prog", name: "In Progress", type: "started", position: 1 },
			{ id: "s-review", name: "In Review", type: "started", position: 2 },
		]);

		await (edgeWorker as any).moveIssueToReviewState(
			makeIssue({ currentStateId: "s-review", currentStateName: "In Review" }),
			WORKSPACE_ID,
		);

		expect(mockIssueTracker.updateIssue).not.toHaveBeenCalled();
	});

	it("never throws when the update fails (state update must not fail the turn)", async () => {
		setWorkflowStates([
			{ id: "s-prog", name: "In Progress", type: "started", position: 1 },
			{ id: "s-review", name: "In Review", type: "started", position: 2 },
		]);
		mockIssueTracker.updateIssue.mockRejectedValue(new Error("boom"));

		await expect(
			(edgeWorker as any).moveIssueToReviewState(
				makeIssue({ currentStateId: "s-prog" }),
				WORKSPACE_ID,
			),
		).resolves.toBeUndefined();
	});
});
