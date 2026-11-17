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
  test("a token in a web address is never kept: its query, fragment and userinfo hidden, the address otherwise kept", () => {
    const kept = agentSaidTail([
      "fetch failed: https://api.example.com/v1/items?access_token=abc123secret&x=1",
      "see https://example.com/docs#token=zzz",
      "push to https://sam:hunter2@git.example.com/shop.git refused",
    ].join("\n"));
    expect(kept).toEqual(["fetch failed: https://api.example.com/v1/items?[hidden]", "see https://example.com/docs?[hidden]", "push to https://[hidden]@git.example.com/shop.git refused"]);
    expect(kept.join("\n")).not.toMatch(/abc123secret|zzz|hunter2/);
  });
  test("a named home's folder and a file at the root are folders on this computer: [path]", () => {
    expect(agentSaidTail("~sam/notes/key.txt is unreadable\ncannot open /secret.txt\nrun /login, or /help")).toEqual(["[path] is unreadable", "cannot open [path]", "run /login, or /help"]);
    // Found by agent-said.property.test.ts: a folder right after a web address or glued to another folder is its own.
    expect(agentSaidTail("see https://x.example/a<~sam/notes and https://x.example/b\"/opt/srv/x")).toEqual(["see https://x.example/a<[path] and https://x.example/b\"[path]"]);
    // Glued rooted paths are one span; a path keeps every character up to a space, a quote or `)>],:;`.
    expect(agentSaidTail("/opt/a/b(C:\\Users\\me\\x /opt/a/b=/srv/c/d")).toEqual(["[path] [path]"]);
  });
  test.each([
    ["after =", "/opt/customer=Acme/ledger.txt"],
    ["after (", "/opt/customer(Acme/ledger.txt"],
    ["after <", "/opt/customer<Acme/ledger.txt"],
    ["after [", "/opt/customer[Acme/ledger.txt"],
    ["a drive glued with no break", "/a/bxC:\\Users\\me\\ledger.txt"],
    ["JSON-escaped", '"\\/Users\\/me\\/ledger.txt"'],
    ["percent-encoded", "%2FUsers%2Fme%2Fledger.txt"],
    ["a drive, percent-encoded", "C%3A%5CUsers%5Cme%5Cledger.txt"],
    ["$HOME", "$HOME/ledger.txt"],
    ["${HOME}", "${HOME}/ledger.txt"],
    ["%USERPROFILE%", "%USERPROFILE%\\ledger.txt"],
    ["a file address", "file:///Users/me/ledger.txt"],
    ["a network share", "\\\\fileserver\\finance\\ledger.txt"],
  ])("a folder %s is said as [path] whole: nothing of it is left", (_, path) => {
    const kept = agentSaidTail(`could not read ${path} today`);
    expect(kept).toHaveLength(1);
    expect(kept[0]).not.toMatch(/ledger|Acme|Users|finance|fileserver|HOME|USERPROFILE/);
    expect(kept[0]).toMatch(/^could not read "?\[path\]"? today$/);
  });
  test("a percent escape is decoded once, never again; a web address's own escapes stay", () => {
    expect(agentSaidTail("see %252FUsers%252Fme ok")).toEqual(["see %252FUsers%252Fme ok"]);
    expect(agentSaidTail("see https://example.com/a%2Fb ok")).toEqual(["see https://example.com/a%2Fb ok"]);
    expect(agentSaidTail("100% done, a=$HOMEDIR/x")).toEqual(["100% done, a=$HOMEDIR/x"]);
  });
  test("the cut never leaves a mark a second cleaning would read as part of a hidden query, nor half a character", () => {
    const line = `${"a".repeat(170)} https://x.example/p?token=1 and more after it`;
    const once = agentSaidTail(line);
    expect(agentSaidTail(once.join("\n"))).toEqual(once);
    expect(agentSaidTail(`${"a".repeat(198)}\u{1f600}\u{1f600} more`)[0]!.isWellFormed()).toBe(true);
    expect(agentSaidTail("left\u061cright")).toEqual(["leftright"]);
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
