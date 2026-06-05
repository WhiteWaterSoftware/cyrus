#!/usr/bin/env node
// Experiment: capture a real CODING turn through codex app-server so we can lock
// down the v2 item shapes for commandExecution / fileChange (and friends) that the
// AppServerCodexBackend must map to NormalizedCodexItem.
//
// Uses sandbox=workspace-write in a throwaway git repo and asks the model to create
// a file and run a command. Captures every framed message to a JSONL transcript.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const CODEX_BIN = execFileSync("bash", [
  "-c",
  "find /Users/agentops/code/cyrus/node_modules/.pnpm -path '*@openai+codex@*-darwin-arm64*/vendor/*/codex/codex' | head -1",
])
  .toString()
  .trim();

const workdir = mkdtempSync(join(tmpdir(), "codex-coding-capture-"));
execFileSync("git", ["init", "-q"], { cwd: workdir });
execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: workdir });
execFileSync("git", ["config", "user.name", "t"], { cwd: workdir });
writeFileSync(join(workdir, "README.md"), "# capture repo\n");

const captureDir = "/tmp/codex-appserver-capture";
mkdirSync(captureDir, { recursive: true });
const captureFile = join(captureDir, "coding-transcript.jsonl");
writeFileSync(captureFile, "");

const itemTypes = new Set();
function capture(direction, obj) {
  appendFileSync(captureFile, `${JSON.stringify({ direction, msg: obj })}\n`);
}

console.log(`[capture] workdir: ${workdir}`);
console.log(`[capture] file: ${captureFile}`);

const child = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://"], {
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
const pending = new Map();
function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  capture("client", msg);
  child.stdin.write(`${JSON.stringify(msg)}\n`);
  return new Promise((res, rej) => pending.set(id, { res, rej, method }));
}
function respond(id, result) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

let threadId = null;
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let p;
  try {
    p = JSON.parse(t);
  } catch {
    return;
  }
  capture("server", p);

  if (p.id !== undefined && (p.result !== undefined || p.error !== undefined)) {
    const e = pending.get(p.id);
    pending.delete(p.id);
    if (p.error) e?.rej?.(p.error);
    else e?.res?.(p.result);
    return;
  }
  if (p.id !== undefined && p.method) {
    // server request: approve everything so the coding turn proceeds
    console.log(`[capture] server-req ${p.method}`);
    if (/auth/i.test(p.method)) respond(p.id, { chatgptAuthToken: null });
    else respond(p.id, { decision: "accept" });
    return;
  }
  if (p.method) {
    if (p.method === "item/completed" || p.method === "item/started") {
      const item = p.params?.item;
      if (item?.type) {
        if (!itemTypes.has(item.type)) {
          itemTypes.add(item.type);
          console.log(`[capture] NEW item type via ${p.method}: ${item.type}`);
          console.log(JSON.stringify(item, null, 2).slice(0, 1200));
        }
      }
    }
    if (/turn\/completed/.test(p.method)) {
      console.log(`[capture] turn completed — item types seen: ${[...itemTypes].join(", ")}`);
      setTimeout(() => child.kill(), 1000);
    }
  }
});
child.stderr.on("data", (d) => {
  const s = d.toString().trim();
  if (s) console.log(`[capture][stderr] ${s.slice(0, 200)}`);
});
child.on("exit", () => {
  console.log(`[capture] done. transcript: ${captureFile}`);
  console.log(`[capture] item types: ${[...itemTypes].sort().join(", ")}`);
  process.exit(0);
});

(async () => {
  await send("initialize", {
    clientInfo: { name: "cyrus-coding-capture", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  const start = await send("thread/start", {
    cwd: workdir,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  threadId = start?.thread?.id;
  console.log(`[capture] threadId=${threadId}`);
  await send("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          "Do these steps: 1) create a file greet.py containing a function greet(name) that returns 'Hello, '+name. " +
          "2) run `ls -la` to list the directory. 3) run `python3 greet.py` is not needed; instead run `cat greet.py`. Keep edits minimal.",
      },
    ],
  });
})();

setTimeout(() => {
  console.log("[capture] timeout — killing");
  child.kill();
}, 90000);
