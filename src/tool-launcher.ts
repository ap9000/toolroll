/**
 * The launcher a Codex build starts each project tool through (v80):
 * `node tool-launcher.js <config.json>`. Codex hands its own environment
 * to the agent's shell whatever `shell_environment_policy` says (checked
 * against codex-cli 0.156), so nothing rides Codex's environment. A build's
 * launch file names its run's tool broker (tool-broker.ts) and that launch's
 * token, and this process relays stdio to it over HTTP; the tool's own
 * secrets stay in the broker. A launch file naming a local program is refused
 * (docs/plans/sandbox-parity.md C2): Codex starts this launcher outside its
 * command sandbox, so a program started here would run unfenced; every local
 * server runs in the broker, inside the server fence.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { ToolSpec } from "./project-tools.js";

type LaunchFile = { spec: ToolSpec; values: Record<string, string> };

/** The refusal for a launch file naming a local program: nothing is started (126, "could not be executed"). */
const LOCAL_LAUNCH_REFUSED = "This tool's launch names a local program, which only Toolroll's tool broker may start (inside its fence); nothing was started.";

/** stdio ↔ streamable HTTP: each line from Codex is POSTed; JSON or event-stream answers go back as lines. */
function relayWeb(spec: ToolSpec, values: Record<string, string>): void {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (spec.bearer !== null && values[spec.bearer]) headers["authorization"] = `Bearer ${values[spec.bearer]}`;
  for (const [header, secret] of Object.entries(spec.headerSecrets)) if (values[secret]) headers[header] = values[secret]!;
  let session: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  const out = (line: string) => { if (line.trim() !== "") process.stdout.write(`${line.trim()}\n`); };
  const post = async (line: string): Promise<void> => {
    let id: unknown = null;
    try { id = (JSON.parse(line) as { id?: unknown }).id ?? null; } catch { return; }
    try {
      const response = await fetch(spec.url!, { method: "POST", headers: { ...headers, ...(session === null ? {} : { "mcp-session-id": session }) }, body: line });
      session = response.headers.get("mcp-session-id") ?? session;
      if (response.status === 202 || response.body === null) return;
      if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
            const event = buffer.slice(0, end).replace(/\r$/, "");
            buffer = buffer.slice(end + 1);
            if (event.startsWith("data:")) out(event.slice(5));
          }
        }
        if (buffer.startsWith("data:")) out(buffer.slice(5));
      } else {
        const text = await response.text();
        if (response.ok) out(text);
        else if (id !== null) out(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: `The tool's server answered HTTP ${response.status}.` } }));
      }
    } catch {
      if (id !== null) out(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "The tool's server could not be reached." } }));
    }
  };
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => { chain = chain.then(() => post(line)); });
  lines.on("close", () => { void chain.then(() => process.exit(0)); });
}

const file = process.argv[2];
if (file === undefined) {
  process.stderr.write("usage: tool-launcher <config.json>\n");
  process.exit(2);
}
let launch: LaunchFile;
try {
  launch = JSON.parse(readFileSync(file, "utf8")) as LaunchFile;
} catch {
  process.stderr.write("the tool's launch settings could not be read\n");
  process.exit(2);
}
if (launch.spec.transport === "http") relayWeb(launch.spec, launch.values);
else {
  process.stderr.write(`${LOCAL_LAUNCH_REFUSED}\n`);
  process.exit(126);
}
