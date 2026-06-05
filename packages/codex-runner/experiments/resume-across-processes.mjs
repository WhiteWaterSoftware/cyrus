// Blocker #1: validate thread/resume across SEPARATE app-server processes.
// Turn 1 establishes context, backend closes (process killed), a fresh backend
// resumes the thread and must recall that context.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AppServerCodexBackend } from "../dist/backend/AppServerCodexBackend.js";

const wd = mkdtempSync(join(tmpdir(), "codex-resume-it-"));
execFileSync("git", ["init", "-q"], { cwd: wd });
writeFileSync(join(wd, "README.md"), "# x\n");
const config = {
  sandbox: "read-only",
  approvalPolicy: "never",
  skipGitRepoCheck: true,
  workingDirectory: wd,
  additionalDirectories: [],
  codexHome: join(process.env.HOME, ".codex"),
};

function collectText(backend) {
  const texts = [];
  backend.on("event", (e) => {
    if (e.kind === "item-completed" && e.item.type === "agent_message")
      texts.push(e.item.text);
  });
  return texts;
}

// ---- Turn 1: establish a secret in thread context ----
const b1 = new AppServerCodexBackend();
const t1 = collectText(b1);
const { threadId } = await b1.open(config);
console.log(`[resume-it] turn1 threadId=${threadId}`);
await b1.runTurn([
  { type: "text", text: "Remember this for later: the secret passphrase is INDIGO-77. Just acknowledge briefly." },
]);
await b1.close(); // kills the app-server process
console.log(`[resume-it] turn1 done, process closed. reply: ${JSON.stringify((t1.at(-1) || "").slice(0, 80))}`);

// ---- Turn 2: a brand-new backend/process resumes the same thread ----
const b2 = new AppServerCodexBackend();
const t2 = collectText(b2);
const { threadId: resumedId } = await b2.open({ ...config, resumeSessionId: threadId });
console.log(`[resume-it] turn2 resumed threadId=${resumedId}`);
await b2.runTurn([
  { type: "text", text: "What was the secret passphrase I told you earlier? Reply with just the passphrase." },
]);
await b2.close();

const answer = (t2.at(-1) || "");
const recalled = /INDIGO-77/.test(answer);
console.log(`[resume-it] turn2 reply: ${JSON.stringify(answer.slice(0, 120))}`);
console.log("\n===== RESUME-ACROSS-PROCESSES SUMMARY =====");
console.log("turn1 threadId:", threadId);
console.log("turn2 resumed same thread:", resumedId === threadId);
console.log("context recalled across processes (INDIGO-77):", recalled);
console.log("===========================================");
process.exit(recalled && resumedId === threadId ? 0 : 1);
