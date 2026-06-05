import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type QueuedJob,
	SessionQueueManager,
} from "../src/SessionQueueManager.js";

function mkJob(
	overrides: Partial<QueuedJob> & Pick<QueuedJob, "agentSessionId">,
): QueuedJob {
	return {
		agentSessionId: overrides.agentSessionId,
		issueId: overrides.issueId ?? `issue-${overrides.agentSessionId}`,
		issueIdentifier:
			overrides.issueIdentifier ?? `HALO-${overrides.agentSessionId}`,
		priority: overrides.priority ?? "feature",
		enqueuedAt: overrides.enqueuedAt ?? Date.now(),
		initArgs: overrides.initArgs ?? {
			agentSession: { id: overrides.agentSessionId },
			repositoryIds: ["halo"],
			linearWorkspaceId: "ws-1",
			commentBody: null,
		},
	};
}

describe("SessionQueueManager", () => {
	let dir: string;
	let mgr: SessionQueueManager;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cyrus-queue-test-"));
		mgr = new SessionQueueManager({ maxConcurrentSessions: 1, queueDir: dir });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("concurrency gate", () => {
		it("does not enqueue when below the cap", () => {
			expect(mgr.shouldEnqueue(0)).toBe(false);
		});

		it("enqueues when at the cap", () => {
			expect(mgr.shouldEnqueue(1)).toBe(true);
		});

		it("floors maxConcurrentSessions at 1 even when configured lower", () => {
			const zeroMgr = new SessionQueueManager({
				maxConcurrentSessions: 0,
				queueDir: dir,
			});
			expect(zeroMgr.getMaxConcurrentSessions()).toBe(1);
			expect(zeroMgr.shouldEnqueue(0)).toBe(false);
			expect(zeroMgr.shouldEnqueue(1)).toBe(true);
		});

		it("honors a higher cap", () => {
			const big = new SessionQueueManager({
				maxConcurrentSessions: 3,
				queueDir: dir,
			});
			expect(big.shouldEnqueue(2)).toBe(false);
			expect(big.shouldEnqueue(3)).toBe(true);
		});
	});

	describe("enqueue / popNext", () => {
		it("returns 1-indexed position", () => {
			expect(mgr.enqueue(mkJob({ agentSessionId: "a" }))).toBe(1);
			expect(mgr.enqueue(mkJob({ agentSessionId: "b" }))).toBe(2);
		});

		it("pops in FIFO order within the same tier", () => {
			mgr.enqueue(mkJob({ agentSessionId: "a", enqueuedAt: 1 }));
			mgr.enqueue(mkJob({ agentSessionId: "b", enqueuedAt: 2 }));
			mgr.enqueue(mkJob({ agentSessionId: "c", enqueuedAt: 3 }));
			expect(mgr.popNext()?.agentSessionId).toBe("a");
			expect(mgr.popNext()?.agentSessionId).toBe("b");
			expect(mgr.popNext()?.agentSessionId).toBe("c");
			expect(mgr.popNext()).toBeUndefined();
		});

		it("dedupes a duplicate enqueue by agentSessionId", () => {
			expect(mgr.enqueue(mkJob({ agentSessionId: "a" }))).toBe(1);
			expect(mgr.enqueue(mkJob({ agentSessionId: "b" }))).toBe(2);
			// Same agentSessionId — should NOT add a new entry; returns existing pos.
			expect(mgr.enqueue(mkJob({ agentSessionId: "a" }))).toBe(1);
			expect(mgr.getDepth()).toBe(2);
		});

		it("priority: land jumps ahead of feature", () => {
			mgr.enqueue(
				mkJob({ agentSessionId: "f1", priority: "feature", enqueuedAt: 1 }),
			);
			mgr.enqueue(
				mkJob({ agentSessionId: "f2", priority: "feature", enqueuedAt: 2 }),
			);
			mgr.enqueue(
				mkJob({ agentSessionId: "L1", priority: "land", enqueuedAt: 3 }),
			);
			// land lands at head of feature tier; features keep FIFO behind it.
			expect(mgr.popNext()?.agentSessionId).toBe("L1");
			expect(mgr.popNext()?.agentSessionId).toBe("f1");
			expect(mgr.popNext()?.agentSessionId).toBe("f2");
		});

		it("priority: multiple land jobs FIFO within the land tier", () => {
			mgr.enqueue(
				mkJob({ agentSessionId: "f", priority: "feature", enqueuedAt: 1 }),
			);
			mgr.enqueue(
				mkJob({ agentSessionId: "L1", priority: "land", enqueuedAt: 2 }),
			);
			mgr.enqueue(
				mkJob({ agentSessionId: "L2", priority: "land", enqueuedAt: 3 }),
			);
			expect(mgr.popNext()?.agentSessionId).toBe("L1");
			expect(mgr.popNext()?.agentSessionId).toBe("L2");
			expect(mgr.popNext()?.agentSessionId).toBe("f");
		});
	});

	describe("drop", () => {
		it("dropByIssueId removes matching jobs", () => {
			mgr.enqueue(mkJob({ agentSessionId: "a", issueId: "issue-1" }));
			mgr.enqueue(mkJob({ agentSessionId: "b", issueId: "issue-2" }));
			const dropped = mgr.dropByIssueId("issue-1", "test");
			expect(dropped).toHaveLength(1);
			expect(dropped[0]?.agentSessionId).toBe("a");
			expect(mgr.getDepth()).toBe(1);
		});

		it("dropByIssueId is a no-op when nothing matches", () => {
			mgr.enqueue(mkJob({ agentSessionId: "a" }));
			expect(mgr.dropByIssueId("missing", "test")).toHaveLength(0);
			expect(mgr.getDepth()).toBe(1);
		});

		it("dropByAgentSessionId removes by session id", () => {
			mgr.enqueue(mkJob({ agentSessionId: "a" }));
			mgr.enqueue(mkJob({ agentSessionId: "b" }));
			expect(mgr.dropByAgentSessionId("b", "test")?.agentSessionId).toBe("b");
			expect(mgr.getDepth()).toBe(1);
		});
	});

	describe("persistence", () => {
		it("writes queue.json under queueDir", () => {
			mgr.enqueue(mkJob({ agentSessionId: "a" }));
			const path = join(dir, "queue.json");
			expect(existsSync(path)).toBe(true);
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			expect(parsed.version).toBe("1.0");
			expect(parsed.jobs).toHaveLength(1);
			expect(parsed.jobs[0].agentSessionId).toBe("a");
		});

		it("reloads queue from disk", () => {
			mgr.enqueue(mkJob({ agentSessionId: "a", enqueuedAt: 1 }));
			mgr.enqueue(mkJob({ agentSessionId: "b", enqueuedAt: 2 }));

			// Fresh manager pointed at the same dir picks up the persisted queue.
			const reloaded = new SessionQueueManager({
				maxConcurrentSessions: 1,
				queueDir: dir,
			});
			reloaded.load();
			expect(reloaded.getDepth()).toBe(2);
			expect(reloaded.popNext()?.agentSessionId).toBe("a");
			expect(reloaded.popNext()?.agentSessionId).toBe("b");
		});

		it("tolerates a missing queue file (cold boot)", () => {
			const fresh = new SessionQueueManager({
				maxConcurrentSessions: 1,
				queueDir: dir,
			});
			expect(() => fresh.load()).not.toThrow();
			expect(fresh.getDepth()).toBe(0);
		});

		it("starts empty on a corrupt queue file rather than crashing", () => {
			// Pre-write garbage so load() encounters a parse error.
			require("node:fs").writeFileSync(
				join(dir, "queue.json"),
				"{not-valid-json",
				"utf8",
			);
			const fresh = new SessionQueueManager({
				maxConcurrentSessions: 1,
				queueDir: dir,
			});
			expect(() => fresh.load()).not.toThrow();
			expect(fresh.getDepth()).toBe(0);
		});

		it("starts empty on an unknown version", () => {
			require("node:fs").writeFileSync(
				join(dir, "queue.json"),
				JSON.stringify({ version: "99.0", jobs: [] }),
				"utf8",
			);
			const fresh = new SessionQueueManager({
				maxConcurrentSessions: 1,
				queueDir: dir,
			});
			fresh.load();
			expect(fresh.getDepth()).toBe(0);
		});
	});

	describe("events", () => {
		it("emits jobEnqueued with position + depth", () => {
			let captured: { position: number; depth: number } | null = null;
			mgr.on("jobEnqueued", (_job, position, depth) => {
				captured = { position, depth };
			});
			mgr.enqueue(mkJob({ agentSessionId: "a" }));
			expect(captured).toEqual({ position: 1, depth: 1 });
		});

		it("emits jobPopped with remaining depth", () => {
			let captured: { remaining: number } | null = null;
			mgr.on("jobPopped", (_job, remaining) => {
				captured = { remaining };
			});
			mgr.enqueue(mkJob({ agentSessionId: "a" }));
			mgr.enqueue(mkJob({ agentSessionId: "b" }));
			mgr.popNext();
			expect(captured).toEqual({ remaining: 1 });
		});

		it("emits jobDropped on dropByIssueId", () => {
			let droppedReason: string | null = null;
			mgr.on("jobDropped", (_job, reason) => {
				droppedReason = reason;
			});
			mgr.enqueue(mkJob({ agentSessionId: "a", issueId: "issue-1" }));
			mgr.dropByIssueId("issue-1", "unassigned");
			expect(droppedReason).toBe("unassigned");
		});
	});

	describe("summary", () => {
		it("returns position-ordered, init-args-free entries", () => {
			mgr.enqueue(mkJob({ agentSessionId: "a", priority: "feature" }));
			mgr.enqueue(mkJob({ agentSessionId: "L", priority: "land" }));
			const summary = mgr.getSummary();
			expect(summary).toHaveLength(2);
			expect(summary[0]?.agentSessionId).toBe("L");
			expect(summary[1]?.agentSessionId).toBe("a");
			// initArgs must not leak through summary
			expect((summary[0] as unknown as { initArgs?: unknown }).initArgs).toBe(
				undefined,
			);
		});
	});
});
