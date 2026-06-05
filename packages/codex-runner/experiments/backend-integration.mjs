#!/usr/bin/env node
// Integration check for the real AppServerCodexBackend class (built dist).
// Exercises open -> runTurn, collects NormalizedCodexEvents, and fires a steer
// mid-turn. Validates the backend's event mapping against the live binary.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AppServerCodexBackend } from "../dist/backend/AppServerCodexBackend.js";

const workdir = mkdtempSync(join(tmpdir(), "codex-backend-it-"));
execFileSync("git", ["init", "-q"], { cwd: workdir });
writeFileSync(join(workdir, "README.md"), "# it\n");

const backend = new AppServerCodexBackend();
const events = [];
backend.on("event", (e) => {
  events.push(e);
  const label =
    e.kind === "item-completed" || e.kind === "item-started"
      ? `${e.kind}:${e.item.type}`
      : e.kind;
  console.log(`[event] ${label}`);
  if (e.kind === "item-completed" && e.item.type === "agent_message") {
    console.log(`        text: ${JSON.stringify(e.item.text.slice(0, 80))}`);
  }
});

let steered = false;
backend.on("event", async (e) => {
  // Steer as soon as the first item streams (turn is active by then).
  if (!steered && e.kind === "item-started" && backend.isTurnActive()) {
    steered = true;
    try {
      await backend.steer([
        { type: "text", text: "ALSO append the word KIWI to your final reply." },
      ]);
      console.log("[it] steer accepted");
    } catch (err) {
      console.log(`[it] steer rejected: ${err?.message}`);
    }
  }
});

const config = {
  sandbox: "read-only",
  approvalPolicy: "never",
  skipGitRepoCheck: true,
  workingDirectory: workdir,
  additionalDirectories: [],
  codexHome: join(process.env.HOME, ".codex"),
};

try {
  const { threadId } = await backend.open(config);
  console.log(`[it] opened thread ${threadId}`);
  await backend.runTurn([
    {
      type: "text",
      text: "Explain in ~120 words how DNS resolution works, step by step.",
    },
  ]);
  console.log("[it] runTurn resolved");
} catch (err) {
  console.error("[it] FAILED:", err);
} finally {
  await backend.close();
}

const kinds = events.map((e) => e.kind);
const sawThread = kinds.includes("thread-started");
const sawCompleted = kinds.includes("turn-completed");
const agentTexts = events
  .filter((e) => e.kind === "item-completed" && e.item.type === "agent_message")
  .map((e) => e.item.text);
const kiwi = agentTexts.some((t) => /KIWI/.test(t));

console.log("\n===== BACKEND INTEGRATION SUMMARY =====");
console.log("thread-started:", sawThread);
console.log("turn-completed:", sawCompleted);
console.log("steer fired:", steered);
console.log("agent messages:", agentTexts.length);
console.log("steer obeyed (KIWI present):", kiwi);
console.log("event kinds:", [...new Set(kinds)].sort().join(", "));
console.log("=======================================");
process.exit(sawThread && sawCompleted ? 0 : 1);
