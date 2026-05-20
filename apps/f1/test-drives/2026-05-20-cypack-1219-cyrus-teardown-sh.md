# Test Drive: CYPACK-1219 — per-repo `cyrus-teardown.sh` auto-detection

**Date**: 2026-05-20
**Goal**: Validate the per-repo `cyrus-teardown.sh` feature end-to-end through F1.
**Test Repo**: `/tmp/f1-cypack-1219-1779301432`

## TL;DR

- ✅ Setup-hook regression check passed — the refactored `runHookScript` helper still runs `cyrus-setup.sh` with the correct `cwd` and `LINEAR_ISSUE_IDENTIFIER` env.
- ✅ Stop-session does **not** fire teardown (intended — unassign is preserved-worktree behavior).
- ✅ **End-to-end teardown firing verified.** Initial run was blocked because F1 had no terminal-state transition; that gap is closed in this same change with a new `f1 terminate-issue --issue-id <id> --action completed|canceled|deleted` command (see "Update" section below). Final run confirmed `cyrus-teardown.sh` fires with correct `cwd` and `LINEAR_ISSUE_IDENTIFIER`, and the worktree is removed after.

## Setup

```bash
cd apps/f1
./f1 init-test-repo --path /tmp/f1-cypack-1219-1779301432
```

Added two sentinel-writing scripts to the test repo root and committed:

```bash
# /tmp/f1-cypack-1219-1779301432/cyrus-setup.sh
SENTINEL_DIR="/tmp/cyrus-hooks"
mkdir -p "$SENTINEL_DIR"
printf 'identifier=%s\ncwd=%s\nhook=setup\n' "$LINEAR_ISSUE_IDENTIFIER" "$PWD" \
  > "$SENTINEL_DIR/setup-$LINEAR_ISSUE_IDENTIFIER.txt"
```

```bash
# /tmp/f1-cypack-1219-1779301432/cyrus-teardown.sh
SENTINEL_DIR="/tmp/cyrus-hooks"
mkdir -p "$SENTINEL_DIR"
printf 'identifier=%s\ncwd=%s\nhook=teardown\n' "$LINEAR_ISSUE_IDENTIFIER" "$PWD" \
  > "$SENTINEL_DIR/teardown-$LINEAR_ISSUE_IDENTIFIER.txt"
```

Both `chmod +x`'d.

## Drive

```bash
CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/f1-cypack-1219-1779301432 bun run apps/f1/server.ts &
CYRUS_PORT=3600 ./f1 ping                                  # → healthy
CYRUS_PORT=3600 ./f1 create-issue --title ...              # → issue-1 / DEF-1
CYRUS_PORT=3600 ./f1 start-session --issue-id issue-1      # → session-1
# RepositoryRouter requested a selection; replied with the repo name:
CYRUS_PORT=3600 ./f1 prompt-session --session-id session-1 \
  --message "F1 Test Repository"
```

After the worktree was created at `/tmp/cyrus-f1-1779301451848/worktrees/DEF-1`:

```
$ cat /tmp/cyrus-hooks/setup-DEF-1.txt
identifier=DEF-1
cwd=/private/tmp/cyrus-f1-1779301451848/worktrees/DEF-1
hook=setup
```

→ **`cyrus-setup.sh` fired correctly** with the expected env and cwd. Confirms the shared `runHookScript` helper preserved setup-script behavior after the refactor.

## Teardown — blocked

To exercise teardown end-to-end, the Linear issue would need to be moved to a terminal state (`completed` / `canceled` / `deleted`), which causes `LinearMessageTranslator` (or, in CLI mode, the equivalent path) to publish an `IssueStateChangeMessage` on the message bus. `EdgeWorker.handleIssueStateChangeMessage` then calls `gitService.deleteWorktree(identifier, { repositories })`, and that's where the new teardown wiring runs.

What's missing in F1:

1. **No CLI surface for terminal-state transitions.** Inspected `apps/f1/f1 --help` and `CLIRPCServer.handleCommand` (`packages/core/src/issue-tracker/adapters/CLIRPCServer.ts:365–423`). The exposed RPC commands are: `ping`, `status`, `version`, `createIssue`, `assignIssue`, `createComment`, `startSession`, `viewSession`, `promptSession`, `stopSession`, `listAgentSessions`. There is no `updateIssue`, no `moveIssue`, no terminal-state command.
2. **`CLIIssueTrackerService.updateIssue` exists but does not publish a state-change message.** It accepts `stateId` updates and emits a local `issue:updated` EventEmitter event, but never produces an `IssueStateChangeMessage` for the EdgeWorker's `handleMessage` to route. Real Linear webhooks reach `handleIssueStateChangeMessage` via `LinearMessageTranslator`; CLI mode has no equivalent translator wired in.
3. **No public injection point on `EdgeWorker`.** `handleMessage(message)` is private; there is no exported helper to publish an internal message from outside the EdgeWorker.

Stop-session was confirmed **not** to trigger teardown (correct — stop is graceful pause, not terminal):

```
$ ./f1 stop-session --session-id session-1   # session stopped
$ ls /tmp/cyrus-hooks/                       # only setup-DEF-1.txt
setup-DEF-1.txt
$ ls /tmp/cyrus-f1-1779301451848/worktrees/  # worktree preserved
DEF-1
```

This matches the design intent: stop ≠ terminal state.

## Coverage that *does* exist

Unit tests in `packages/edge-worker/test/GitService.test.ts` (`describe("deleteWorktree - teardown wiring")`) cover the teardown wiring with mocked `execSync`/`fs`:

- Happy path — `cyrus-teardown.sh` runs in worktree cwd with `LINEAR_ISSUE_IDENTIFIER`, before `git worktree remove`.
- Script absent → no exec attempt, worktree still deleted.
- Script failure → logged, worktree still deleted.
- Script not executable → warned + skipped.
- Workspace dir missing → teardown not attempted.
- Multi-repo: both repos' teardowns run with the correct per-repo `cwd`.
- Multi-repo with one teardown missing → only the present one runs.
- Multi-repo with one teardown failing → other repo's teardown still runs, `rmSync` still fires.
- Empty `repositories` option → no teardown attempted.
- SIGTERM → error includes `"timed out (exceeded 2 minutes)"`.

633 / 633 edge-worker tests pass.

## Recommendation

To make this F1-testable in the future, the smallest viable addition is:

- New RPC command `f1 update-issue --issue-id <id> --state-id <terminal-state-id>` that calls `CLIIssueTrackerService.updateIssue`.
- In `CLIIssueTrackerService.updateIssue`, when the new `stateId` resolves to a state whose `type === "completed"` or `"canceled"`, also publish an `IssueStateChangeMessage` via the configured event transport, mirroring how `LinearMessageTranslator` handles `issueStatusChanged` webhooks for real Linear.

Until that's in place, teardown coverage stays in the unit-test layer (which is comprehensive).

## Update — gap closed, end-to-end teardown verified

Added the missing terminal-state surface to F1 and re-ran:

- `apps/f1/src/commands/terminateIssue.ts` — new `terminate-issue` CLI command (`--issue-id`, `--action`).
- `CLIRPCServer` — new `terminateIssue` RPC command.
- `CLIIssueTrackerService.terminateIssue(issueId, action)` — updates in-memory state and emits an `IssueStateChangeMessage` on the unified message bus.
- `CLIEventTransport.emitMessage(message)` — peer to `emitEvent` for internal-message emission.
- `EdgeWorker` (CLI setup) — now also subscribes to `cliEventTransport.on("message", handleMessage)` so terminal-state messages reach `handleIssueStateChangeMessage`.

Re-run on a fresh F1 server with both `cyrus-setup.sh` and `cyrus-teardown.sh` in the test repo:

```bash
CYRUS_PORT=3601 ./f1 create-issue --title "Add multiply method" ...        # issue-1 / DEF-1
CYRUS_PORT=3601 ./f1 start-session --issue-id issue-1                       # session-1
CYRUS_PORT=3601 ./f1 prompt-session --session-id session-1 \
  --message "F1 Test Repository"                                            # repo selection
# ... cyrus-setup.sh fires, worktree exists ...
CYRUS_PORT=3601 ./f1 terminate-issue --issue-id issue-1 --action completed
```

Results:

```
$ cat /tmp/cyrus-hooks/teardown-DEF-1.txt
identifier=DEF-1
cwd=/private/tmp/cyrus-f1-1779304068065/worktrees/DEF-1
hook=teardown

$ ls /tmp/cyrus-f1-1779304068065/worktrees/      # worktree removed
(empty)
```

Server log:

```
[EdgeWorker] [MessageBus] Issue reached terminal state: DEF-1
[GitService] ℹ️  Running repository teardown script: cyrus-teardown.sh
[GitService] ✅ Repository teardown script completed successfully
```

End-to-end path validated: `f1 terminate-issue` → `CLIRPCServer.handleTerminateIssue` → `CLIIssueTrackerService.terminateIssue` → `CLIEventTransport.emitMessage(IssueStateChangeMessage)` → `EdgeWorker.handleMessage` → `handleIssueStateChangeMessage` → `gitService.deleteWorktree({ repositories })` → `runRepoTeardownScript` → worktree removal.

## Cleanup

```bash
kill <bun pid>             # stop F1 server
rm -rf /tmp/cyrus-hooks /tmp/f1-cypack-1219-* /tmp/cyrus-f1-1779301451848
```
