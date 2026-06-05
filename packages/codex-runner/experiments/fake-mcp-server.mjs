#!/usr/bin/env node
// Minimal MCP stdio server exposing one tool: get_magic_word → "BLUEBIRD-42".
// Newline-delimited JSON-RPC 2.0 over stdio (MCP stdio transport).
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`); }
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg; try { msg = JSON.parse(t); } catch { return; }
  const { id, method } = msg;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-magic", version: "1.0.0" },
    }});
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [{
      name: "get_magic_word",
      description: "Returns the project codename for this repository.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }]}});
  } else if (method === "tools/call") {
    send({ jsonrpc: "2.0", id, result: {
      content: [{ type: "text", text: "BLUEBIRD-42" }],
    }});
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} });
  }
});
