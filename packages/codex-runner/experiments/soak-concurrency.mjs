// Soak/concurrency check for the app-server backend: run K CodexRunner instances
// at once (each spawns its own codex app-server process), verify isolation (each
// gets only its own token), and confirm processes are reaped (no leak) — across
// two churn batches.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { CodexRunner } from "../dist/index.js";

const K = 4;
const BATCHES = 2;

// Count MY app-server processes (vendored under node_modules/.pnpm), excluding
// the user's /Applications/Codex.app instances.
function myProcCount() {
  try {
    const out = execSync(`pgrep -f 'pnpm.*codex.*app-server' || true`).toString().trim();
    return out ? out.split("\n").filter(Boolean).length : 0;
  } catch { return 0; }
}

function makeRepo(i) {
  const wd = mkdtempSync(join(tmpdir(), `codex-soak-${i}-`));
  execFileSync("git", ["init", "-q"], { cwd: wd });
  writeFileSync(join(wd, "README.md"), "# x\n");
  return wd;
}

function runOne(i) {
  const wd = makeRepo(i);
  const runner = new CodexRunner({
    workingDirectory: wd,
    cyrusHome: join(process.env.HOME, ".cyrus"),
    sandbox: "read-only",
    useAppServer: true,
  });
  const texts = [];
  runner.on("message", (m) => {
    if (m.type === "assistant")
      for (const b of m.message.content ?? []) if (b?.type === "text") texts.push(b.text);
  });
  const token = `RUNNER-${i}`;
  return runner
    .startStreaming(`Reply with exactly the token ${token} and nothing else. Do not use any tools.`)
    .then(() => ({ i, token, ok: texts.some((t) => t.includes(token)),
      cross: texts.some((t) => /RUNNER-/.test(t) && !t.includes(token)),
      sessionId: runner.getMessages()[0]?.session_id }));
}

let peak = 0;
const sampler = setInterval(() => { peak = Math.max(peak, myProcCount()); }, 150);

const allResults = [];
for (let batch = 0; batch < BATCHES; batch++) {
  const before = myProcCount();
  const results = await Promise.all(Array.from({ length: K }, (_, i) => runOne(batch * K + i)));
  allResults.push(...results);
  // brief settle for fire-and-forget close() to reap processes
  await new Promise((r) => setTimeout(r, 1500));
  const after = myProcCount();
  console.log(`[soak] batch ${batch}: before=${before} after=${after} ok=${results.filter(r=>r.ok).length}/${K} crossTalk=${results.some(r=>r.cross)}`);
}
clearInterval(sampler);
await new Promise((r) => setTimeout(r, 1000));
const finalCount = myProcCount();

const distinctSessions = new Set(allResults.map((r) => r.sessionId)).size;
console.log("\n===== SOAK / CONCURRENCY SUMMARY =====");
console.log(`runners total: ${allResults.length}`);
console.log(`correct token (isolation): ${allResults.filter((r) => r.ok).length}/${allResults.length}`);
console.log(`any cross-talk: ${allResults.some((r) => r.cross)}`);
console.log(`distinct session ids: ${distinctSessions}/${allResults.length}`);
console.log(`peak concurrent app-server procs: ${peak} (expected ~${K})`);
console.log(`leaked procs after all done: ${finalCount} (expected 0)`);
console.log("======================================");
const pass = allResults.every((r) => r.ok && !r.cross)
  && distinctSessions === allResults.length && peak >= 2 && finalCount === 0;
process.exit(pass ? 0 : 1);
