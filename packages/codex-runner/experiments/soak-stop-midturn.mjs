// Verify stop() mid-turn (fire-and-forget close) reaps the app-server process —
// the abrupt-teardown path (user unassigns / session stopped while running).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { CodexRunner } from "../dist/index.js";

const K = 4;
const myProcCount = () => {
  try {
    const o = execSync(`pgrep -f 'pnpm.*codex.*app-server' || true`).toString().trim();
    return o ? o.split("\n").filter(Boolean).length : 0;
  } catch { return 0; }
};

const runners = [];
for (let i = 0; i < K; i++) {
  const wd = mkdtempSync(join(tmpdir(), `codex-stopsoak-${i}-`));
  execFileSync("git", ["init", "-q"], { cwd: wd });
  writeFileSync(join(wd, "README.md"), "# x\n");
  const r = new CodexRunner({
    workingDirectory: wd, cyrusHome: join(process.env.HOME, ".cyrus"),
    sandbox: "read-only", useAppServer: true,
  });
  runners.push(r);
  // long-running prompt; do NOT await — we'll stop mid-flight
  r.startStreaming("Write a detailed 400-word essay on the history of computing. Take your time.").catch(() => {});
}

// Let the turns get going (processes spawned + active).
await new Promise((res) => setTimeout(res, 4000));
const during = myProcCount();

// Abruptly stop all of them mid-turn.
for (const r of runners) r.stop();

// Allow fire-and-forget close() to kill the processes.
await new Promise((res) => setTimeout(res, 2500));
const after = myProcCount();

console.log("\n===== STOP-MID-TURN SOAK SUMMARY =====");
console.log(`procs during (mid-turn): ${during} (expected ~${K})`);
console.log(`procs after stop(): ${after} (expected 0)`);
console.log(`all runners report not running: ${runners.every((r) => !r.isRunning())}`);
console.log("======================================");
process.exit(during >= 2 && after === 0 ? 0 : 1);
