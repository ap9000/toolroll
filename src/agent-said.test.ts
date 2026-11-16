import { describe, expect, test } from "vitest";
import { AGENT_SAID_LINES, AGENT_SAID_WIDTH, agentSaidLine, agentSaidOf } from "./agent-said.js";
import type { Store } from "./store.js";

const storeWith = (tail: ((run: number) => unknown) | undefined) => ({ agentSaidTail: tail }) as unknown as Store;

describe("what the agent said, as every surface gets it", () => {
  test("no reader yet, nothing kept, or a reader that throws: null", () => {
    expect(agentSaidOf({} as Store, 1)).toBeNull();
    expect(agentSaidOf(storeWith(() => null), 1)).toBeNull();
    expect(agentSaidOf(storeWith(() => ["", "   "]), 1)).toBeNull();
    expect(agentSaidOf(storeWith(() => { throw new Error("db"); }), 1)).toBeNull();
    expect(agentSaidOf(storeWith(() => "not a list"), 1)).toBeNull();
  });
  test("the last lines only, each plain text and bounded", () => {
    const tail = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    tail[10] = "\u001b]52;c;ZXZpbA==\u0007evil ‮esrever\u001b[31m red\u001b[0m";
    tail[11] = "x".repeat(500);
    const said = agentSaidOf(storeWith(run => (run === 7 ? tail : null)), 7)!;
    expect(said).toHaveLength(AGENT_SAID_LINES);
    expect(said[0]).toBe("line 5");
    expect(said[6]).toBe("evil esrever red");
    expect(said[7]).toHaveLength(AGENT_SAID_WIDTH);
    expect(said.join("")).not.toMatch(/[\u0000-\u001f\u007f‮]/);
    expect(agentSaidLine("  a\tb\n c  ")).toBe("a b c");
  });
});
