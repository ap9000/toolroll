/**
 * Interactive prompts, for exactly one situation: a person at a real
 * terminal left out a value a command needs. Every prompt is gated on a
 * TTY at both ends and never fires under --json — an agent or a cron job
 * gets the same immediate usage refusal as always, because a scheduler
 * hanging on "password:" at 3am is the one bug this module must not have.
 */

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { createInterface } from "node:readline";

/** Whether asking is even possible: a human on both ends of the pipe. */
export function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Variables a coding agent sets for the commands it runs. Only Codex's own CODEX_ names: a person exports others
 * (CODEX_HOME, CODEX_API_KEY, a profile) for themselves. */
const AGENT_VARIABLES = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "GEMINI_CLI", "CURSOR_AGENT", "OPENCODE", "GOOSE_TERMINAL", "AIDER_CHAT",
  "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID", "CODEX_CI", "CODEX_MANAGED_BY_NPM", "CODEX_MANAGED_BY_BUN"];
/** Agents known by the program running this command, for those that set no variable of their own. */
const AGENT_PROGRAMS = new Set(["claude", "codex", "gemini", "agy", "cursor-agent", "opencode", "aider", "copilot", "amp", "goose", "crush", "qwen"]);

/** The program names of this process's ancestors, nearest first: each one's command and, for a script run by node
 * or python, the script's name. Empty where `ps` cannot say. */
export function ancestorPrograms(): string[] {
  if (process.platform === "win32") return [];
  const names: string[] = [];
  let pid = process.ppid;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    const answered = spawnSync("/bin/ps", ["-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    const found = answered.status === 0 ? /^\s*(\d+)\s+(.*)$/.exec(answered.stdout.trim()) : null;
    if (!found) break;
    const words = found[2]!.split(/\s+/);
    const program = basename(words[0] ?? "");
    names.push(program);
    if (/^(node|bun|deno|python[\d.]*)$/.test(program) && words[1] !== undefined && !words[1].startsWith("-")) names.push(basename(words[1]));
    pid = Number(found[1]);
  }
  return names;
}

/**
 * Whether a coding agent is running this command. An agent's shell can be a
 * real terminal, yet whatever is printed lands in its transcript and nobody
 * types at the prompt, so it is treated like no terminal at all. The agent is
 * known by a variable it sets or, for one that sets none, by the program above
 * this one. `programs` is read only for this process's own environment.
 */
export function underAgent(env: Record<string, string | undefined> = process.env, programs: () => readonly string[] = env === process.env ? ancestorPrograms : () => []): boolean {
  if (AGENT_VARIABLES.some(name => env[name] !== undefined && env[name] !== "")) return true;
  return programs().some(name => AGENT_PROGRAMS.has(name.replace(/\.(?:js|mjs|cjs|py|exe)$/, "")));
}

export function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve =>
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

/** Like ask, but what is typed never echoes — passwords live here. */
/**
 * Raw-mode input is not text: a terminal with bracketed paste on wraps a
 * pasted password in ESC[200~ … ESC[201~, and any arrow or function key
 * arrives as an escape sequence. Every CSI/SS3 sequence is dropped whole,
 * so a pasted secret compares equal to a typed one (setup review: the
 * hidden prompt refused every pasted password on iTerm and Terminal.app).
 */
export function sanitizeHiddenInput(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001bO[@-~]/g, "").replace(/\u001b/g, "");
}

export function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode?.(true);
  stdin.resume();
  return new Promise(resolve => {
    let value = "";
    const finish = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer): void => {
      const text = sanitizeHiddenInput(chunk.toString("utf8"));
      for (const ch of text) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl-C during a hidden prompt: leave the terminal usable, then go.
          finish();
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** A yes/no gate for an act worth a beat of deliberateness. */
export async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} (yes/no) `);
  return answer.toLowerCase() === "yes" || answer.toLowerCase() === "y";
}
