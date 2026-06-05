/**
 * SessionQueueManager — concurrency gate + persistent FIFO-with-priority queue
 *
 * The runner is configured with `maxConcurrentSessions` (default 1) because the
 * Docker-backed dev stack is a host-port singleton on a single instance — N
 * concurrent worktree sessions collide on Postgres/Mailpit/LocalStack. When an
 * assignment arrives and we're already at the cap, EdgeWorker hands the job
 * here instead of spawning a runner; on session completion the registry's
 * `sessionCompleted` event drains the next one back out.
 *
 * Persistence model:
 *   - File lives at `${cyrusHome}/queue.json` (operator-visible, distinct from
 *     the auto-managed `state/edge-worker-state.json`).
 *   - Write is synchronous after every mutation so an unclean shutdown can't
 *     lose a queued job. Reads are async-on-boot only.
 *   - Items hold the full set of `initializeAgentRunner` arguments
 *     (`InitArgsSnapshot`) — when we pop, the receiver replays the call as if
 *     the webhook had just arrived. `baseBranchOverrides` is serialized to a
 *     plain object because `Map` doesn't round-trip through JSON.
 *
 * Priority:
 *   - Two tiers — `land` jumps ahead of `feature`. Within a tier, FIFO by
 *     `enqueuedAt`. Detection of `land` is intentionally a callback on
 *     EdgeWorker; the webhook payload doesn't carry labels, so HALO-301 wires
 *     up the actual label/dependency lookup. Until then, everything is
 *     `feature` — the ordering machinery is in place but the discriminator
 *     hasn't been turned on.
 *
 * Reconcile-on-boot:
 *   - On `EdgeWorker.start()` we load the queue, drop any entry whose
 *     agentSession is already terminal in the GlobalSessionRegistry (it
 *     already finished — webhook arrived but registry state outlived it), and
 *     `maybeDrainQueue()` once to kick off the next job if we're below the
 *     cap. The Linear-side "is this still assigned?" check is left to the
 *     unassignment webhook + HALO-299's reliable-reset work — fetching the
 *     full assignment list every boot is more failure surface than it's worth
 *     for the size of queue we expect (<10).
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger, type ILogger } from "cyrus-core";

/** Two-tier priority. `land` preempts `feature` at enqueue time only — */
/** an in-flight feature run is never killed mid-session. */
export type QueuedJobPriority = "land" | "feature";

/**
 * Snapshot of every argument `EdgeWorker.initializeAgentRunner` needs. We
 * persist this verbatim so the pop path can replay the call without having to
 * re-derive routing from a stale webhook.
 *
 * `baseBranchOverrides` becomes a plain record on disk; the consumer
 * rehydrates to `Map<string, string>` when popping. `agentSession`,
 * `guidance`, `commentBody`, `routingMethod` are JSON-safe as-is.
 */
export interface QueuedJobInitArgsSnapshot {
	/** Linear AgentSessionEventWebhookPayload.agentSession — JSON-safe verbatim */
	agentSession: unknown;
	/** Resolved repository IDs (looked up from EdgeWorker.repositories at pop time) */
	repositoryIds: string[];
	linearWorkspaceId: string;
	guidance?: unknown;
	commentBody?: string | null;
	baseBranchOverrides?: Record<string, string>;
	routingMethod?: string;
}

export interface QueuedJob {
	/** Linear agentSession.id — the durable handle. Also the dedupe key. */
	agentSessionId: string;
	/** Linear issue.id for unassignment-driven cleanup */
	issueId: string;
	/** Human display only (e.g. "HALO-300") */
	issueIdentifier: string;
	priority: QueuedJobPriority;
	enqueuedAt: number;
	initArgs: QueuedJobInitArgsSnapshot;
}

interface QueueFileV1 {
	version: "1.0";
	jobs: QueuedJob[];
}

export interface SessionQueueManagerEvents {
	/** Fired after enqueue with the final position (1-indexed) and the new depth. */
	jobEnqueued: (job: QueuedJob, position: number, depth: number) => void;
	/** Fired after a job leaves the queue head — the caller replays initializeAgentRunner with the snapshot. */
	jobPopped: (job: QueuedJob, remainingDepth: number) => void;
	/** Fired when a queued job is dropped (unassignment, stale-on-boot, manual). */
	jobDropped: (job: QueuedJob, reason: string) => void;
}

export interface SessionQueueManagerOptions {
	/** Concurrency cap; queue gates new sessions once active >= this. Min 1. */
	maxConcurrentSessions: number;
	/** Directory the queue file lives under (typically `cyrusHome`). */
	queueDir: string;
	logger?: ILogger;
}

export declare interface SessionQueueManager {
	on<U extends keyof SessionQueueManagerEvents>(
		event: U,
		listener: SessionQueueManagerEvents[U],
	): this;
	emit<U extends keyof SessionQueueManagerEvents>(
		event: U,
		...args: Parameters<SessionQueueManagerEvents[U]>
	): boolean;
}

export class SessionQueueManager extends EventEmitter {
	private jobs: QueuedJob[] = [];
	private readonly maxConcurrentSessions: number;
	private readonly queueFilePath: string;
	private readonly logger: ILogger;

	constructor(opts: SessionQueueManagerOptions) {
		super();
		// Floor at 1: a 0/negative cap would deadlock every assignment in the queue.
		this.maxConcurrentSessions = Math.max(
			1,
			Math.floor(opts.maxConcurrentSessions),
		);
		this.queueFilePath = join(opts.queueDir, "queue.json");
		this.logger =
			opts.logger ?? createLogger({ component: "SessionQueueManager" });
	}

	getMaxConcurrentSessions(): number {
		return this.maxConcurrentSessions;
	}

	getQueueFilePath(): string {
		return this.queueFilePath;
	}

	/**
	 * Load from disk. Tolerates a missing file (cold boot) and an unreadable
	 * file (logs + starts empty rather than crashing the runner on a corrupted
	 * queue.json — losing the queue is recoverable, refusing to boot isn't).
	 */
	load(): void {
		if (!existsSync(this.queueFilePath)) {
			this.jobs = [];
			return;
		}
		try {
			const raw = readFileSync(this.queueFilePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<QueueFileV1>;
			if (parsed?.version !== "1.0" || !Array.isArray(parsed.jobs)) {
				this.logger.warn(
					`Queue file ${this.queueFilePath} has unexpected shape — ignoring`,
				);
				this.jobs = [];
				return;
			}
			this.jobs = parsed.jobs;
			this.logger.info(
				`Loaded ${this.jobs.length} queued job(s) from ${this.queueFilePath}`,
			);
		} catch (err) {
			this.logger.error(
				`Failed to load queue file ${this.queueFilePath}, starting empty`,
				err,
			);
			this.jobs = [];
		}
	}

	private persist(): void {
		try {
			mkdirSync(dirname(this.queueFilePath), { recursive: true });
			const payload: QueueFileV1 = { version: "1.0", jobs: this.jobs };
			writeFileSync(
				this.queueFilePath,
				JSON.stringify(payload, null, 2),
				"utf8",
			);
		} catch (err) {
			// Persisting failure is logged but non-fatal: the in-memory queue
			// still drives drain. A box restart could lose the queue — better
			// than failing the assignment outright.
			this.logger.error(
				`Failed to persist queue file ${this.queueFilePath}`,
				err,
			);
		}
	}

	/**
	 * Decide whether a new assignment should be gated. Returns the queue
	 * position (1-indexed) it would land at if enqueued, so the caller can
	 * ack to Linear with a position number.
	 */
	shouldEnqueue(activeSessionCount: number): boolean {
		return activeSessionCount >= this.maxConcurrentSessions;
	}

	/**
	 * Enqueue a job. Same-priority dedupe by `agentSessionId` (Linear's
	 * at-least-once webhook delivery can replay the same created event;
	 * silently swallow the duplicate rather than spawn two queue entries).
	 *
	 * Ordering: insert at the END of the matching priority tier. `land` jobs
	 * land after the last `land` but before the first `feature`; `feature`
	 * jobs go at the tail. This is FIFO within tier, priority across tiers.
	 *
	 * Returns the 1-indexed position the job took.
	 */
	enqueue(job: QueuedJob): number {
		const existing = this.jobs.findIndex(
			(j) => j.agentSessionId === job.agentSessionId,
		);
		if (existing >= 0) {
			this.logger.info(
				`Job for agentSession ${job.agentSessionId} already queued at position ${existing + 1}, ignoring duplicate enqueue`,
			);
			return existing + 1;
		}

		if (job.priority === "land") {
			// Tail of land tier = first feature index, or end if no features.
			const firstFeatureIdx = this.jobs.findIndex(
				(j) => j.priority === "feature",
			);
			const insertAt =
				firstFeatureIdx === -1 ? this.jobs.length : firstFeatureIdx;
			this.jobs.splice(insertAt, 0, job);
		} else {
			this.jobs.push(job);
		}

		this.persist();
		const position =
			this.jobs.findIndex((j) => j.agentSessionId === job.agentSessionId) + 1;
		this.logger.info(
			`Enqueued ${job.issueIdentifier} (priority=${job.priority}) at position ${position} of ${this.jobs.length}`,
		);
		this.emit("jobEnqueued", job, position, this.jobs.length);
		return position;
	}

	/**
	 * Pop the head job. Called from EdgeWorker's `sessionCompleted` listener
	 * when active < max. Returns undefined if the queue is empty.
	 */
	popNext(): QueuedJob | undefined {
		const job = this.jobs.shift();
		if (!job) return undefined;
		this.persist();
		this.logger.info(
			`Popped ${job.issueIdentifier} from queue; ${this.jobs.length} job(s) remaining`,
		);
		this.emit("jobPopped", job, this.jobs.length);
		return job;
	}

	/**
	 * Remove a queued job by Linear issue ID. Wired to the unassignment
	 * webhook so dropping a delegation also drops its queued slot — without
	 * this, an unassigned-then-reassigned issue would stack a second entry.
	 * Multiple matches are dropped (defensive — there should never be more
	 * than one per issue, but a corrupt queue file could carry duplicates).
	 */
	dropByIssueId(issueId: string, reason: string): QueuedJob[] {
		const dropped: QueuedJob[] = [];
		this.jobs = this.jobs.filter((j) => {
			if (j.issueId === issueId) {
				dropped.push(j);
				return false;
			}
			return true;
		});
		if (dropped.length > 0) {
			this.persist();
			for (const j of dropped) {
				this.logger.info(
					`Dropped queued ${j.issueIdentifier} (reason: ${reason})`,
				);
				this.emit("jobDropped", j, reason);
			}
		}
		return dropped;
	}

	/**
	 * Same as `dropByIssueId` but keyed on agentSessionId. Useful for
	 * boot-time reconcile when we discover the registry already has a
	 * terminal entry for that session.
	 */
	dropByAgentSessionId(
		agentSessionId: string,
		reason: string,
	): QueuedJob | undefined {
		const idx = this.jobs.findIndex((j) => j.agentSessionId === agentSessionId);
		if (idx < 0) return undefined;
		const [dropped] = this.jobs.splice(idx, 1);
		if (!dropped) return undefined;
		this.persist();
		this.logger.info(
			`Dropped queued ${dropped.issueIdentifier} (reason: ${reason})`,
		);
		this.emit("jobDropped", dropped, reason);
		return dropped;
	}

	getDepth(): number {
		return this.jobs.length;
	}

	/** Snapshot for `/status` payloads — does NOT expose initArgs. */
	getSummary(): Array<{
		agentSessionId: string;
		issueIdentifier: string;
		priority: QueuedJobPriority;
		enqueuedAt: number;
	}> {
		return this.jobs.map((j) => ({
			agentSessionId: j.agentSessionId,
			issueIdentifier: j.issueIdentifier,
			priority: j.priority,
			enqueuedAt: j.enqueuedAt,
		}));
	}

	/** Test/recovery helper — never called in normal operation. */
	getAll(): QueuedJob[] {
		return [...this.jobs];
	}
}
