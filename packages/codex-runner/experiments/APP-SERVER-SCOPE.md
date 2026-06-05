# Codex `app-server` Streaming Input — Requirements & Design Scope

Status: **scoped + protocol validated** (Phase 0 complete). Branch: `codex/app-server-streaming-input`.

## 1. Problem & goal

`CodexRunner` today drives Codex through the high-level `@openai/codex-sdk`, which
shells out to `codex exec --experimental-json` **once per turn**: it writes the full
prompt to stdin, closes stdin, and streams output events until the process exits
(`node_modules/.pnpm/@openai+codex-sdk@.../dist/index.js`). There is no mid-turn
input channel, so `CodexRunner.supportsStreamingInput = false` and
`addStreamMessage()` throws.

Consequence in Cyrus: when a Linear comment arrives mid-turn,
`EdgeWorker.resumeAgentSession()` calls `existingRunner.stop()` (aborts the in-flight
turn — partial work lost) and starts a fresh turn via `thread.resumeThread()`.

**Goal:** give Codex real streaming input parity with Claude by driving it through the
`codex app-server` JSON-RPC protocol, whose `turn/steer` method injects input into the
**active** turn. This lets `CodexRunner` set `supportsStreamingInput = true` and route
`addStreamMessage()` → `turn/steer`, so the existing EdgeWorker streaming path "just
works" for Codex.

## 2. Protocol facts — VALIDATED against `codex-cli 0.125.0`

Verified end-to-end with `experiments/app-server-smoke.mjs` (transcript captured at
`/tmp/codex-appserver-capture/transcript.jsonl`). These are observed, not just schema-derived.

- **Transport:** newline-delimited JSON-RPC 2.0 over stdio. Spawn
  `codex app-server --listen stdio://`. No LSP `Content-Length` framing — one JSON
  object per line, `\n`-terminated, both directions. (Also supports `unix://`, `ws://`.)
- **Handshake (required first):** `initialize` with
  `{ clientInfo: {name, version, title?}, capabilities: {experimentalApi?, optOutNotificationMethods?} }`.
  Returns server info `{ userAgent, codexHome, platformFamily, platformOs }`. No separate
  `initialized` notification needed.
- **`thread/start`** params: `{ cwd, approvalPolicy, sandbox, model, developerInstructions,
  baseInstructions, config, permissionProfile, modelProvider, serviceTier, ephemeral, ... }`.
  Returns `{ thread: { id, status, path, modelProvider, ... } }` (threadId = `result.thread.id`).
  Also emits a `thread/started` notification. `thread/resume` resumes by id (sessions persist
  under `~/.codex/sessions/`).
- **`turn/start`** params: `{ threadId, input: UserInput[], model?, sandboxPolicy?,
  approvalPolicy?, cwd?, effort?, outputSchema?, summary?, ... }`. Returns
  `{ turn: { id, items, status: "inProgress", ... } }` (turnId = `result.turn.id`). Emits
  `turn/started` notification with `params.turn.id`.
- **`turn/steer`** params: `{ threadId, expectedTurnId, input: UserInput[] }`. Returns
  `{ turnId }`. **Behavior (observed):** the steered input is queued into the *active* turn;
  the model finishes its in-flight response, then processes the steered message as a new
  `userMessage → reasoning → agentMessage` cycle, all under the **same turnId** with a
  single terminal `turn/completed`. No work is lost, and the instruction was obeyed
  ("BANANA" appended to the final answer). `expectedTurnId` is an optimistic-concurrency
  precondition: steer fails if it isn't the currently-active turn.
- **`turn/interrupt`** params: `{ threadId, turnId }` — cancels the active turn.
- **`UserInput`** union: `{type:"text", text}` | `{type:"image", url}` |
  `{type:"localImage", path}` | `{type:"skill", name, path}` | `{type:"mention", name, path}`.
- **`approvalPolicy: "never"` ⇒ ZERO ServerRequest round-trips.** The smoke run saw
  `server-request methods seen: []`. This matches today's exec config (`approval_policy="never"`),
  so we do **not** need to implement approval handlers to reach behavioral parity. (We will
  still respond defensively to any ServerRequest so a stray one can't wedge the turn.)
- **Turn failure** is surfaced as `turn/completed` with `turn.status: "failed"` and
  `turn.error` — NOT as a JSON-RPC error and NOT a separate `turn/failed` notification.

### Streaming notifications observed during a turn
`thread/started`, `thread/status/changed`, `turn/started`, `item/started`, `item/completed`,
`item/agentMessage/delta`, `thread/tokenUsage/updated`, `account/rateLimits/updated`,
`mcpServer/startupStatus/updated`, `warning`, `turn/completed`.

### Item shapes (v2) — note the divergence from exec
App-server `item/*` notifications wrap `{ item: { type, id, ... } }` with **camelCase**
type tags: `userMessage`, `reasoning`, `agentMessage` (observed), and per schema also
`commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`, plan/todo. The SDK exec
`--experimental-json` path the current runner consumes uses **snake_case**
(`agent_message`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`,
`todo_list`) and dot-event names (`thread.started`, `item.started`, `turn.completed`,
`turn.failed`). **This mapping divergence is the core implementation work.**

## 3. Proposed architecture (SOLID)

The current `CodexRunner` is a ~1580-line god class mixing six responsibilities. The clean
design splits transport from everything else and normalizes both transports onto one event
shape so the message-mapping logic never has to know which backend produced an event.

### 3.1 `CodexBackend` strategy interface (transport)
```ts
type NormalizedCodexEvent =
  | { kind: "thread-started"; threadId: string }
  | { kind: "item-started"; item: NormalizedCodexItem }
  | { kind: "item-completed"; item: NormalizedCodexItem }
  | { kind: "turn-completed"; usage: NormalizedUsage }
  | { kind: "turn-failed"; message: string }
  | { kind: "error"; message: string };

interface CodexBackend {
  readonly supportsSteer: boolean;
  open(opts: BackendOpenOptions): Promise<{ threadId: string }>;
  runTurn(input: CodexUserInput[]): Promise<void>; // resolves on turn-completed/failed
  steer?(input: CodexUserInput[]): Promise<void>;   // only if supportsSteer
  interrupt(): Promise<void>;
  close(): Promise<void>;
  on(event: "event", cb: (e: NormalizedCodexEvent) => void): this;
}
```
- `ExecCodexBackend` — wraps the existing `@openai/codex-sdk` `Codex`/`Thread`.
  `supportsSteer = false`. `runTurn` is today's `runTurn` (calls `thread.runStreamed`) with a
  thin map from SDK ThreadEvent → `NormalizedCodexEvent`.
- `AppServerCodexBackend` — spawns `codex app-server`, holds a persistent JSON-RPC client
  across turns, `supportsSteer = true`, maps app-server notifications → `NormalizedCodexEvent`,
  `steer` → `turn/steer`, `interrupt` → `turn/interrupt`.

`NormalizedCodexItem` is the discriminated union the **existing** `projectItemToTool`
already understands (command/file/mcp/web/todo/agent-message). Keeping that shape means the
tool-projection and SDKMessage-emission code is reused verbatim by both backends
(Open/Closed: new transport, zero edits to mapping).

### 3.2 Extract collaborators out of `CodexRunner` (SRP)
| New unit | Absorbs from CodexRunner | Responsibility |
|---|---|---|
| `CodexConfigBuilder` | `buildThreadOptions`, `buildConfigOverrides`, `buildEnvOverride`, `resolveCodexHome`, `resolveModelWithFallback`, `hasCodexSubscription` | Assemble the provider-neutral run config both backends consume |
| `CodexMcpConfigTranslator` | all `*Mcp*` fns + `loadMcpConfigFromPaths` (~250 lines) | Cyrus allowedTools/MCP → Codex `mcp_servers` config |
| `CodexSkillStager` | `prepareManagedSkillsForCodex`, `discoverCodexSkillSources`, `stageSkillDirectory`, `cleanupStagedSkills`, `ensureManagedSkillsIgnored`, … (~150 lines) | Stage/cleanup repo-local skill symlinks around a run |
| `CodexEventMapper` | `handleEvent`, `projectItemToTool`, `emit*`, `createSuccess/ErrorResultMessage` | `NormalizedCodexEvent` → Cyrus `SDKMessage[]` |
| `CodexBackend` (×2) | `createCodexClient`, `runTurn` | Transport |
| `CodexRunner` | orchestration only | Implements `IAgentRunner`; wires the above |

Result: each class has one reason to change; adding the app-server backend touches only
`CodexBackend` + a new mapper branch, not config/skills/MCP/result-shaping.

### 3.3 `CodexRunner` (orchestrator) changes
- `supportsStreamingInput` becomes **instance-level**, set from `backend.supportsSteer`
  (the interface field is `readonly` but may be assigned per instance).
- `addStreamMessage(content)`: if a turn is active and `backend.supportsSteer` →
  `backend.steer([{type:"text", text:content}])`; if **no turn is active** (between turns) →
  start a new `runTurn` on the same thread; if backend can't steer → throw (today's behavior).
- Implement `isStreaming()` (currently missing) so the EdgeWorker guard works.
- Optional parity: `interrupt()` → `turn/interrupt`, `isWarm()` → true for app-server.

## 4. EdgeWorker integration

`handlePromptWithStreamingCheck()` already branches on
`existingRunner.supportsStreamingInput && existingRunner.addStreamMessage`. Once an
app-server-backed `CodexRunner` reports `supportsStreamingInput = true` and implements
`addStreamMessage`, **mid-turn comments stream into the active turn with no EdgeWorker
change**. Items to confirm/extend:
- `isStreaming()` guard must be implemented on CodexRunner (interface optional; EdgeWorker uses it).
- The "no active turn" branch (comment lands between turns) — handled in the runner's
  `addStreamMessage` state machine (steer requires an active turn per `expectedTurnId`).
- Session-id persistence (`session.codexSessionId`) continues to map to the app-server
  threadId for resume across process restarts.

## 5. Risks / open questions (resolve during impl)

Validated already: handshake, thread/turn lifecycle, steer semantics, no-approval path,
JSONL framing, agent-message streaming, token usage.

Still to lock down (require a captured **coding-task** transcript — command exec + file edit):
1. **v2 item field names** for `commandExecution` / `fileChange` / `mcpToolCall` / `webSearch`
   vs what `projectItemToTool` reads (`aggregated_output`, `exit_code`, `changes[].kind/path`,
   `server`/`tool`, `query`). Likely camelCase in v2 → normalization layer required.
2. **`additionalDirectories`** (`--add-dir` in exec) has no obvious `thread/start` param —
   confirm whether it goes through `config` overrides or is unsupported by app-server.
3. **MCP servers** — exec passes `-c mcp_servers...`; confirm thread/start `config` map
   accepts the same `mcp_servers` table (reuse `CodexMcpConfigTranslator` output).
4. **`developerInstructions`** mapping from `appendSystemPrompt` (vs `baseInstructions`).
5. **`outputSchema`** — exec writes a temp file + `--output-schema`; app-server takes it
   inline on `turn/start`.
6. **Auth** — ambient ChatGPT login worked; verify `CODEX_API_KEY` / `CODEX_HOME` env path
   and that `resolveModelWithFallback` still applies (or is unnecessary under app-server).
7. **Sandbox** — map `workspace-write` + `sandbox_workspace_write.network_access` to the
   app-server `sandbox` / `config` shape.
8. **Process lifecycle** — one app-server process per session (matches current isolation);
   handle crash mid-turn (surface error, allow `thread/resume`); ensure stdout line framing
   tolerates very large diff lines.
9. **Turn serialization** — exactly one active turn per thread; steer only during active turn.

## 6. Testing strategy
- **Replay tests** from captured transcripts (smoke + coding-task) for both the
  notification→normalized mapping (AppServerCodexBackend) and normalized→SDKMessage mapping
  (CodexEventMapper). (CLAUDE.md: "Add replay tests from real transcripts.")
- **Shared backend contract suite** both backends must pass (Liskov).
- **Unit tests** for each extracted collaborator (config builder, MCP translator, skill stager).
- **F1 end-to-end** (CLAUDE.md mandate): label/selector runner+model selection, visible
  tool/file-edit activities in the timeline, final-response posting, **plus the new mid-turn
  steering scenario** (comment during an active Codex turn → handled in-turn, no restart).

## 7. Phasing (each phase independently shippable)
- **Phase 0 — DONE:** protocol smoke test; semantics validated.
- **Phase 1 — Refactor, no behavior change:** extract the four collaborators + introduce
  `CodexBackend` with `ExecCodexBackend` wrapping today's SDK path. Existing tests + F1 stay green.
- **Phase 2 — AppServerCodexBackend:** JSON-RPC client + notification→normalized mapping;
  capture coding-task transcripts to resolve §5.1–5.5. Behind a config flag, default OFF.
- **Phase 3 — Streaming input:** dynamic `supportsStreamingInput`, `addStreamMessage`→steer,
  `isStreaming`, no-active-turn→new-turn; validate EdgeWorker path; optional interrupt/isWarm.
- **Phase 4 — Default + docs:** flip default (or auto-detect by codex version), update
  CHANGELOG, self-describing prompts, and the new-harness checklist items (§2, §5, §6, §10).
```
```
