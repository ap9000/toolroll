/**
 * The parts every bare `claude -p` call shares: a throwaway working folder, the flags that leave it with no tools,
 * no MCP servers and no saved session, and reading its one JSON reply. Each caller still builds its own argv around
 * these, in its own order.
 */
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictJsonParse } from "./converse.js";
import type { ExecResult, run } from "./exec.js";

export type CommandRunner = (file: string, args: readonly string[], options: Parameters<typeof run>[2]) => Promise<ExecResult>;

/** No tools, no permission prompts, no MCP servers, nothing kept: a `claude -p` call that can only answer. */
export const CLAUDE_NO_TOOLS_ARGS: readonly string[] = [
  "--safe-mode", "--no-session-persistence", "--tools", "", "--permission-mode", "dontAsk",
  "--permission-prompts", "none", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
];

/** `--model <model>`, or nothing for the CLI's own default. */
export const claudeModelArgs = (model: string): string[] => (model === "default" ? [] : ["--model", model]);

/** What a failed call's output says when this computer's Claude isn't signed in. */
export const CLAUDE_SIGNED_OUT = /not logged in|login|authenticat/i;

/** `claude -p --output-format json` stdout as its one object, or null. */
export function claudeJsonBody(stdout: string, cap: number): Record<string, unknown> | null {
  const parsed = strictJsonParse(Buffer.from(stdout, "utf8"), cap, 12);
  return parsed.ok && typeof parsed.value === "object" && parsed.value !== null && !Array.isArray(parsed.value) ? (parsed.value as Record<string, unknown>) : null;
}

/** Runs `work` in a fresh temporary folder named `<prefix>…`, removed afterwards whatever happens. */
export async function inScratchDir<T>(prefix: string, work: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
