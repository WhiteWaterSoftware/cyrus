import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CodexRunner } from "../dist/index.js";

const wd = mkdtempSync(join(tmpdir(), "codex-runner-stream-"));
execFileSync("git", ["init", "-q"], { cwd: wd });
writeFileSync(join(wd, "README.md"), "# x\n");

const runner = new CodexRunner({
  workingDirectory: wd,
  cyrusHome: join(process.env.HOME, ".cyrus"),
  sandbox: "read-only",
  useAppServer: true,
});

console.log("supportsStreamingInput:", runner.supportsStreamingInput);
const assistantTexts = [];
runner.on("message", (m) => {
  if (m.type === "assistant") {
    for (const b of m.message.content ?? []) {
      if (b?.type === "text") assistantTexts.push(b.text);
    }
  }
});

let steered = false;
runner.on("message", (m) => {
  // Steer once we see the first assistant text streaming (turn is active)
  if (!steered && runner.isStreaming()) {
    steered = true;
    try {
      runner.addStreamMessage("ALSO append the word MANGO to your reply.");
      console.log("[stream] addStreamMessage(steer) issued");
    } catch (e) {
      console.log("[stream] addStreamMessage threw:", e.message);
    }
  }
});

await runner.startStreaming(
  "Write ~100 words about how HTTPS/TLS establishes a secure connection.",
);

const mango = assistantTexts.some((t) => /MANGO/.test(t));
console.log("\n===== RUNNER STREAMING SUMMARY =====");
console.log("assistant messages:", assistantTexts.length);
console.log("steer issued:", steered);
console.log("steer obeyed (MANGO):", mango);
console.log("isRunning after:", runner.isRunning());
console.log("====================================");
process.exit(mango ? 0 : 1);
