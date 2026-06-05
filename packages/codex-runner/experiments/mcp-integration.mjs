// Validate that an MCP server configured via thread/start `config.mcp_servers`
// actually loads and is callable under the app-server backend, and that the
// mcp_tool_call maps to a normalized item.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { AppServerCodexBackend } from "../dist/backend/AppServerCodexBackend.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "fake-mcp-server.mjs");
const wd = mkdtempSync(join(tmpdir(), "codex-mcp-it-"));
execFileSync("git", ["init", "-q"], { cwd: wd });
writeFileSync(join(wd, "README.md"), "# x\n");

const backend = new AppServerCodexBackend();
const events = [];
backend.on("event", (e) => {
  events.push(e);
  if (e.kind === "item-completed")
    console.log(`[event] item-completed:${e.item.type}`,
      e.item.type === "mcp_tool_call" ? `${e.item.server}/${e.item.tool}` : "");
});

const config = {
  sandbox: "workspace-write",
  approvalPolicy: "never",
  skipGitRepoCheck: true,
  workingDirectory: wd,
  additionalDirectories: [],
  codexHome: join(process.env.HOME, ".codex"),
  configOverrides: {
    sandbox_workspace_write: { network_access: true },
    mcp_servers: { magic: { command: process.execPath, args: [serverPath], default_tools_approval_mode: "approve" } },
  },
};

try {
  await backend.open(config);
  await backend.runTurn([{ type: "text", text:
    "Call the get_magic_word tool from the magic MCP server and tell me the project codename it returns." }]);
} catch (e) { console.error("FAILED:", e); }
finally { await backend.close(); }

const mcpItems = events.filter(
  (e) => e.kind === "item-completed" && e.item.type === "mcp_tool_call");
const agentTexts = events
  .filter((e) => e.kind === "item-completed" && e.item.type === "agent_message")
  .map((e) => e.item.text);
const recalled = agentTexts.some((t) => /BLUEBIRD-42/.test(t));

console.log("\n===== MCP INTEGRATION SUMMARY =====");
console.log("mcp_tool_call items seen:", mcpItems.length,
  mcpItems.map((e) => `${e.item.server}/${e.item.tool}`));
console.log("agent recalled tool result (BLUEBIRD-42):", recalled);
console.log("turn-completed:", events.some((e) => e.kind === "turn-completed"));
console.log("===================================");

console.log("\n--- DEBUG: mcp item result + agent texts ---");
for (const e of events) {
  if (e.kind === "item-completed" && e.item.type === "mcp_tool_call" && e.item.tool === "get_magic_word") {
    console.log("mcp result field:", JSON.stringify(e.item.result));
    console.log("mcp error field:", JSON.stringify(e.item.error));
  }
  if (e.kind === "item-completed" && e.item.type === "agent_message") {
    console.log("agent:", JSON.stringify(e.item.text.slice(0, 200)));
  }
}
