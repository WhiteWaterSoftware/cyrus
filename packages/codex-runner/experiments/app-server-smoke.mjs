#!/usr/bin/env node
// Experiment: validate the `codex app-server` JSON-RPC v2 protocol end-to-end.
//
// Goal: prove out the sequence we'd build the AppServerCodexBackend on:
//   initialize -> thread/start -> turn/start -> (observe streaming items)
//   -> turn/steer (mid-turn input injection) -> turn/completed
//
// It captures every framed message (both directions) to a JSONL file so we can
// build replay tests from a real transcript, and prints a readable trace.
//
// Run: node packages/codex-runner/experiments/app-server-smoke.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import readline from "node:readline";

const CODEX_BIN = execFileSync("bash", [
  "-c",
  "find /Users/agentops/code/cyrus/node_modules/.pnpm -path '*@openai+codex@*-darwin-arm64*/vendor/*/codex/codex' | head -1",
])
  .toString()
  .trim();

if (!CODEX_BIN) {
  console.error("Could not locate codex binary");
  process.exit(1);
}

// A throwaway git repo as the turn cwd (sandbox read-only so the model can't
// mutate anything; we only want a quick agent_message back).
const workdir = mkdtempSync(join(tmpdir(), "codex-appserver-smoke-"));
execFileSync("git", ["init", "-q"], { cwd: workdir });
writeFileSync(join(workdir, "README.md"), "# smoke test repo\n");

const captureDir = "/tmp/codex-appserver-capture";
mkdirSync(captureDir, { recursive: true });
const captureFile = join(captureDir, "transcript.jsonl");
writeFileSync(captureFile, "");

function capture(direction, obj) {
  appendFileSync(
    captureFile,
    `${JSON.stringify({ direction, t: Date.now(), msg: obj })}\n`,
  );
}

console.log(`[smoke] codex: ${CODEX_BIN}`);
console.log(`[smoke] workdir: ${workdir}`);
console.log(`[smoke] capture: ${captureFile}`);

const child = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://"], {
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
const pending = new Map(); // id -> {method, resolve, reject}

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  capture("client", msg);
  console.log(`\n[smoke] -> #${id} ${method}`);
  child.stdin.write(`${JSON.stringify(msg)}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { method, resolve, reject });
  });
}

function respond(id, result) {
  const msg = { jsonrpc: "2.0", id, result };
  capture("client", msg);
  console.log(`[smoke] -> (response to server req #${id})`);
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

// Track state discovered from the stream.
let threadId = null;
let activeTurnId = null;
let steered = false;
let sawAgentMessage = false;

const notifications = new Set();
const serverRequests = new Set();

const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    console.log(`[smoke] <- (non-json) ${trimmed}`);
    return;
  }
  capture("server", parsed);
  void handleServerMessage(parsed);
});

child.stderr.on("data", (d) => {
  const s = d.toString().trim();
  if (s) console.log(`[smoke][stderr] ${s}`);
});

child.on("exit", (code, signal) => {
  console.log(`\n[smoke] codex app-server exited code=${code} signal=${signal}`);
  printSummary();
  process.exit(0);
});

async function handleServerMessage(parsed) {
  // Response to one of our requests
  if (parsed.id !== undefined && (parsed.result !== undefined || parsed.error !== undefined)) {
    const entry = pending.get(parsed.id);
    pending.delete(parsed.id);
    if (parsed.error) {
      console.log(`[smoke] <- #${parsed.id} ERROR ${JSON.stringify(parsed.error)}`);
      entry?.reject?.(parsed.error);
      return;
    }
    console.log(
      `[smoke] <- #${parsed.id} result (${entry?.method}) ${JSON.stringify(parsed.result).slice(0, 300)}`,
    );
    entry?.resolve?.(parsed.result);
    return;
  }

  // Server -> client REQUEST (needs a response)
  if (parsed.id !== undefined && parsed.method) {
    serverRequests.add(parsed.method);
    console.log(`[smoke] <-- SERVER REQUEST #${parsed.id} ${parsed.method} ${JSON.stringify(parsed.params).slice(0, 200)}`);
    // Auto-handle the ones we expect even with approvalPolicy=never, just in case.
    autoRespondServerRequest(parsed);
    return;
  }

  // Notification
  if (parsed.method) {
    notifications.add(parsed.method);
    const p = parsed.params ?? {};
    console.log(`[smoke] <- notif ${parsed.method} ${JSON.stringify(p).slice(0, 220)}`);
    await onNotification(parsed.method, p);
  }
}

function autoRespondServerRequest(req) {
  const m = req.method;
  if (/auth/i.test(m)) {
    respond(req.id, { chatgptAuthToken: null });
  } else if (/approval/i.test(m)) {
    respond(req.id, { decision: "accept" });
  } else {
    // Best-effort empty result.
    respond(req.id, {});
  }
}

async function onNotification(method, params) {
  // Capture thread id
  if (method === "thread/started" || /thread\/started/i.test(method)) {
    threadId = params.threadId ?? params.thread_id ?? params.thread?.id ?? threadId;
  }
  if (method === "turn/started" || /turn\/started/i.test(method)) {
    activeTurnId = params.turn?.id ?? params.turnId ?? params.turn_id ?? activeTurnId;
    // Steer as soon as the turn is active and we haven't yet.
    void maybeSteer();
  }
  if (/agentMessage\/delta/i.test(method) || method === "item/agentMessage/delta") {
    sawAgentMessage = true;
  }
  if (method === "item/completed" || /item\/completed/i.test(method)) {
    sawAgentMessage = true;
    void maybeSteer();
  }
  if (method === "turn/completed" || /turn\/completed/i.test(method)) {
    console.log(`[smoke] turn completed. status=${JSON.stringify(params.status ?? params)}`);
    // Give the steer's follow-up turn a moment, then shut down.
    setTimeout(() => {
      console.log("[smoke] done — terminating app-server");
      child.kill();
    }, 1500);
  }
}

async function maybeSteer() {
  if (steered || !threadId || !activeTurnId) return;
  steered = true;
  console.log(`\n[smoke] *** attempting turn/steer (thread=${threadId}, expectedTurnId=${activeTurnId}) ***`);
  try {
    const res = await send("turn/steer", {
      threadId,
      expectedTurnId: activeTurnId,
      input: [{ type: "text", text: "ALSO: append the single word BANANA to your reply." }],
    });
    console.log(`[smoke] *** steer accepted: ${JSON.stringify(res)} ***`);
  } catch (e) {
    console.log(`[smoke] *** steer rejected: ${JSON.stringify(e)} ***`);
  }
}

function printSummary() {
  console.log("\n========== SMOKE SUMMARY ==========");
  console.log("threadId:", threadId);
  console.log("activeTurnId:", activeTurnId);
  console.log("steered:", steered);
  console.log("sawAgentMessage:", sawAgentMessage);
  console.log("notification methods seen:", [...notifications].sort());
  console.log("server-request methods seen:", [...serverRequests].sort());
  console.log("transcript:", captureFile);
  console.log("===================================");
}

// ---- Drive the sequence ----
(async () => {
  try {
    const initRes = await send("initialize", {
      clientInfo: { name: "cyrus-smoke", version: "0.0.0", title: "Cyrus Smoke" },
      capabilities: { experimentalApi: true },
    });
    console.log(`[smoke] initialize ok: ${JSON.stringify(initRes).slice(0, 300)}`);

    const startRes = await send("thread/start", {
      cwd: workdir,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    threadId =
      startRes?.threadId ?? startRes?.thread?.id ?? startRes?.thread_id ?? threadId;
    console.log(`[smoke] thread/start -> threadId=${threadId}`);

    const turnRes = await send("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: "Think step by step and write a ~150 word explanation of how the TCP three-way handshake works. Take your time.",
        },
      ],
    });
    activeTurnId =
      turnRes?.turn?.id ?? turnRes?.turnId ?? turnRes?.turn_id ?? activeTurnId;
    console.log(`[smoke] turn/start -> turnId=${activeTurnId}`);
    void maybeSteer();
  } catch (e) {
    console.error("[smoke] sequence failed:", e);
    child.kill();
  }
})();

// Hard safety timeout.
setTimeout(() => {
  console.log("\n[smoke] global timeout (45s) — killing");
  child.kill();
}, 45000);
