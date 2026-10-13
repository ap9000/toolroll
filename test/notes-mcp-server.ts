/**
 * A stdio MCP server for tool-broker and fence tests: it logs what reaches it
 * (start, each call, the answer to its own request) to the file named by its
 * first argument, and answers a call with the sha256 of its NOTES_TOKEN — the
 * proof it got its secret, never the value.
 */
export const NOTES_SERVER = `import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
const log = process.argv[2];
appendFileSync(log, "start " + process.pid + "\\n");
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
let asked = null;
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "notes", version: "1" } } });
  else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "read_note", inputSchema: { type: "object" } }, { name: "delete_note", inputSchema: { type: "object" } }, { name: "ask_roots", inputSchema: { type: "object" } }] } });
  else if (message.method === "tools/call" && message.params.name === "ask_roots") { asked = message.id; send({ jsonrpc: "2.0", id: "server-1", method: "roots/list" }); }
  else if (message.method === "tools/call") { appendFileSync(log, "call " + message.params.name + "\\n"); send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: createHash("sha256").update(process.env.NOTES_TOKEN ?? "").digest("hex") }] } }); }
  else if (message.id === "server-1") { appendFileSync(log, "roots " + JSON.stringify(message.error ?? message.result) + "\\n"); send({ jsonrpc: "2.0", id: asked, result: { content: [{ type: "text", text: "asked" }] } }); }
  else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
setInterval(() => undefined, 1 << 30);
`;
