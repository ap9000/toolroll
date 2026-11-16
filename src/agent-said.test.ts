/** What the agent said on its way out of a failed attempt (agent-said.ts): short, plain and safe to show or send. */
import { describe, expect, test } from "vitest";
import { AGENT_SAID_CHARS, AGENT_SAID_LINES, agentSaidTail } from "./agent-said.js";
import { privateWords } from "./outbound-privacy.js";

describe("the agent's last words, kept short and safe", () => {
  test("at most eight lines of at most 200 characters, the last ones, with blank lines gone", () => {
    const text = Array.from({ length: 20 }, (_, at) => `line ${at + 1}`).join("\n\n") + `\n${"x".repeat(500)}\n`;
    const kept = agentSaidTail(text);
    expect(kept).toHaveLength(AGENT_SAID_LINES);
    expect(kept.at(-2)).toBe("line 20");
    expect(kept.at(-1)).toHaveLength(AGENT_SAID_CHARS);
    expect(kept.at(-1)!.endsWith("…")).toBe(true);
    expect(agentSaidTail("")).toEqual([]);
    expect(agentSaidTail(null)).toEqual([]);
  });
  test("terminal escape sequences and control characters are stripped", () => {
    expect(agentSaidTail("\u001b[31mError:\u001b[0m bad\u0007 config\r\n\u001b]0;title\u0007done\u0000")).toEqual(["Error: bad config", "done"]);
  });
  test("no folder on this computer and no key: paths said as [path], key lines hidden, and nothing private left", () => {
    const kept = agentSaidTail([
      "/Users/me/work/shop/src/app.ts: cannot read",
      "see ~/notes.txt and C:\\Users\\me\\x.log",
      "/private/tmp/run-1/claude.log: Operation not permitted",
      "please run /login",
      `token sk-ant-api03-${"A".repeat(80)}`,
    ].join("\n"));
    expect(kept.slice(0, 4)).toEqual(["[path]: cannot read", "see [path] and [path]", "[path]: Operation not permitted", "please run /login"]);
    expect(kept.join("\n")).not.toContain("sk-ant-");
    for (const line of kept) expect(privateWords(line), line).toBe(false);
  });
});
