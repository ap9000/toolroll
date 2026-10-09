import { describe, expect, test, vi } from "vitest";
import {
  NOTHING_ATTACHED, deliverableClaim, dropDeliverableClaims, linkLabel, renderReply, replyHtmlInline, replyCarriesDeliverable,
  shapeReply, shapeReplyParts, telegramReply, voiceReply, type ReplyChannel,
} from "./reply-shape.js";
import { warmTurn } from "./chat-warmth.js";
import { htmlString } from "./html.js";

const ORIGIN = "https://so.example.com";
const CHANNELS: ReplyChannel[] = ["console", "terminal", "telegram", "slack", "discord", "teams"];

/** What a person sees on each channel: the console's HTML, Telegram's text with its entities, and the rest as sent. */
function seen(text: string, channel: ReplyChannel, asked?: string): { text: string; bold: string[]; links: Array<{ label: string; url: string }> } {
  const shaped = shapeReply(text, { appOrigin: ORIGIN, ...(asked === undefined ? {} : { asked }) });
  if (channel === "console") {
    const html = shaped.split("\n").map(line => htmlString(replyHtmlInline(line))).join("\n");
    return {
      text: html.replace(/<[^>]+>/g, ""),
      bold: [...html.matchAll(/<strong>(.*?)<\/strong>/g)].map(one => one[1]!),
      links: [...html.matchAll(/<a href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map(one => ({ label: one[2]!, url: one[1]!.replaceAll("&amp;", "&") })),
    };
  }
  if (channel === "telegram") {
    const sent = telegramReply(shaped);
    const cut = (offset: number, length: number) => sent.text.slice(offset, offset + length);
    return {
      text: sent.text,
      bold: sent.entities.filter(one => one.type === "bold").map(one => cut(one.offset, one.length)),
      links: sent.entities.flatMap(one => one.type === "text_link" ? [{ label: cut(one.offset, one.length), url: one.url }] : []),
    };
  }
  const out = renderReply(shaped, channel);
  if (channel === "terminal") return { text: out, bold: [], links: [...out.matchAll(/(the task|the result|Settings → Lead|github\.com) \((https:[^)\s]+)\)/g)].map(one => ({ label: one[1]!, url: one[2]! })) };
  if (channel === "slack") return {
    text: out,
    bold: [...out.matchAll(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g)].map(one => one[1]!),
    links: [...out.matchAll(/<(https:[^|>]+)\|([^>]+)>/g)].map(one => ({ label: one[2]!, url: one[1]!.replaceAll("&amp;", "&") })),
  };
  return {
    text: out,
    bold: [...out.matchAll(/\*\*(.+?)\*\*/g)].map(one => one[1]!),
    links: [...out.matchAll(/\[((?:\\.|[^\]\\])+)\]\((https:[^)\s]+)\)/g)].map(one => ({ label: one[1]!.replace(/\\(.)/g, "$1"), url: one[2]! })),
  };
}

describe("one reply shaper, every channel", () => {
  describe.each(CHANNELS)("%s", channel => {
    test("Markdown headers become plain lines", () => {
      const shown = seen("## Status\nThe payout fix is ready.\n\nNext steps\n===\nOpen it when you can.", channel);
      expect(shown.text).not.toMatch(/#|===/);
      expect(shown.text).toContain("Status");
      expect(shown.text).toContain("Next steps");
      expect(shown.text).toContain("The payout fix is ready.");
    });

    test("bold stays on at most three short anchors", () => {
      const shown = seen("**Ready**: the **payout fix** passed **all checks**, and **the login page** is next. **This whole sentence is far too long to be a short anchor at all.**", channel);
      if (channel === "terminal") expect(shown.text).not.toContain("*");
      else expect(shown.bold).toEqual(["Ready", "payout fix", "all checks"]);
      expect(shown.text).toContain("the login page is next");
      expect(shown.text).toContain("This whole sentence is far too long to be a short anchor at all.");
    });

    test("bare URLs become labelled links, named from where they go", () => {
      const shown = seen(`The task: ${ORIGIN}/chat?task=payout. Its result: ${ORIGIN}/chat?task=payout&result=7, rename me at ${ORIGIN}/settings/lead and the PR is https://github.com/acme/app/pull/9.`, channel);
      expect(shown.links).toEqual([
        { label: "the task", url: `${ORIGIN}/chat?task=payout` },
        { label: "the result", url: `${ORIGIN}/chat?task=payout&result=7` },
        { label: "Settings → Lead", url: `${ORIGIN}/settings/lead` },
        { label: "github.com", url: "https://github.com/acme/app/pull/9" },
      ]);
      if (channel === "telegram" || channel === "console") expect(shown.text).not.toContain("https://");
    });

    test("internal ids are removed unless the owner asked for them", () => {
      const reply = `The payout fix (run #42) failed in r1. Digest ${"4f2a9c1b".repeat(4)} is stale, and run #42 is queued again.`;
      const plain = seen(reply, channel);
      expect(plain.text).not.toMatch(/#4\d|r1\b|4f2a9c1b/);
      expect(plain.text).toContain("The payout fix failed in the project. The digest is stale, and the run is queued again.");
      const asked = seen(reply, channel, "what's the run id and digest?");
      expect(asked.text).toMatch(/#42/);
      expect(asked.text).toContain("4f2a9c1b");
    });

    test("several ids of one kind stay, so two items never read the same", () => {
      const shown = seen(`Run #42 passed in r1 and run #43 failed in r2. Digests ${"4f2a9c1b".repeat(2)} and ${"9c1b4f2a".repeat(2)} differ.`, channel);
      // Discord and Teams show an escaped "\#" as "#".
      const text = shown.text.replace(/\\(.)/g, "$1");
      expect(text).toContain("Run #42 passed in r1 and run #43 failed in r2.");
      expect(text).toContain(`Digests ${"4f2a9c1b".repeat(2)} and ${"9c1b4f2a".repeat(2)} differ.`);
    });

    test("three or more blank lines collapse to one", () => {
      const shown = seen("The fix is ready.\n\n\n\n\nOpen it when you can.", channel);
      expect(shown.text).not.toMatch(/\n\s*\n\s*\n/);
      expect(shown.text).toMatch(/ready\.\n+Open it/);
    });
  });

  test("shaping never changes meaning: code is untouched, ordinary prose passes through, and shaping is idempotent", () => {
    const reply = "Run `git log r1 --grep=#42` to see it.\n\n- first\n- second\n\n```\n## not a header 4f2a9c1b4f2a9c1b\n```";
    expect(shapeReply(reply)).toBe(reply);
    const messy = `# Done\n**One** **two** **three** **four**, see ${ORIGIN}/t/abc (run #9).\n\n\n\nBye`;
    const once = shapeReply(messy, { appOrigin: ORIGIN });
    expect(shapeReply(once, { appOrigin: ORIGIN })).toBe(once);
    expect(shapeReply("I'll check the r2-d2 branch and version 1.2.")).toBe("I'll check the r2-d2 branch and version 1.2.");
    expect(shapeReply("Call bad() then retry (it is safe).")).toBe("Call bad() then retry (it is safe).");
  });

  test("only the app's own origin earns an app label: a foreign link always shows its real host, whatever the model called it", () => {
    const spoof = shapeReply("Open [the task](https://evil.example/chat?task=payout) or https://evil.example/settings/lead", { appOrigin: ORIGIN });
    expect(spoof).toBe("Open [evil.example](https://evil.example/chat?task=payout) or [evil.example](https://evil.example/settings/lead)");
    expect(shapeReply(`See ${ORIGIN}/chat?task=a`)).toBe(`See [so.example.com](${ORIGIN}/chat?task=a)`);
    expect(shapeReply(`See [the payout fix](${ORIGIN}/t/a)`, { appOrigin: ORIGIN })).toBe(`See [the payout fix](${ORIGIN}/t/a)`);
  });

  test("the console's and terminal's several addresses all count as the app's own", () => {
    const origins = ["http://localhost:4400", null, ORIGIN];
    expect(shapeReply("Open http://localhost:4400/chat?task=a or https://so.example.com/settings/lead", { appOrigin: origins }))
      .toBe("Open [the task](http://localhost:4400/chat?task=a) or [Settings → Lead](https://so.example.com/settings/lead)");
    expect(voiceReply(`See ${ORIGIN}/chat?task=a&result=2`, "terminal", { appOrigin: origins })).toBe(`See the result (${ORIGIN}/chat?task=a&result=2)`);
  });

  test("a long reply is split as written, then each part shaped: no cut inside a link or a bold anchor, one bold budget", () => {
    const filler = "word ".repeat(30).trim();
    const reply = `**One** ${filler} ${ORIGIN}/chat?task=payout **Two** ${filler} **Three** ${filler} **Four** ${filler}`;
    for (const size of [60, 90, 150]) {
      const parts = shapeReplyParts(reply, size, { appOrigin: ORIGIN });
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(part.length).toBeLessThanOrEqual(size);
        expect(part.split("**").length % 2, part).toBe(1);
        expect(part).not.toMatch(/\[the task\]\([^)]*$|^[^[]*\]\(/);
      }
      const joined = parts.join(" ");
      expect([...joined.matchAll(/\*\*(\w+)\*\*/g)].map(one => one[1])).toEqual(["One", "Two", "Three"]);
      expect(joined).toContain(`[the task](${ORIGIN}/chat?task=payout)`);
      expect(joined.replace(/\*\*|\s+/g, " ").replace(/\s+/g, " ")).toContain("Four");
    }
    expect(shapeReplyParts("Short.", 100)).toEqual(["Short."]);
    expect(shapeReplyParts("Para one.\n\nPara two is here.", 20)).toEqual(["Para one.", "Para two is here."]);
  });

  test("parts are measured as the channel renders them: escapes that lengthen a part cut it again", () => {
    const escaped = (shaped: string): number => renderReply(shaped, "slack").length;
    const reply = Array.from({ length: 40 }, (_, index) => `**N${index}** a<b & c>d https://docs.example.org/${index}?x=1&y=2`).join(" ");
    const parts = shapeReplyParts(reply, 200, { appOrigin: ORIGIN }, escaped);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(escaped(part)).toBeLessThanOrEqual(200);
    const joined = parts.join(" ");
    for (let index = 0; index < 40; index++) expect(joined).toContain(`[docs.example.org](https://docs.example.org/${index}?x=1&y=2)`);
    expect(joined.match(/a<b & c>d/g)).toHaveLength(40);
  });

  test("a cut always moves forward: an emoji at the cut is kept whole, never looped on", () => {
    expect(shapeReplyParts("👍👍👍", 1)).toEqual(["👍", "👍", "👍"]);
    expect(shapeReplyParts("ab👍cd", 3)).toEqual(["ab", "👍c", "d"]);
    // A part that renders longer than the cap around an emoji still ends.
    expect(shapeReplyParts("👍x👍", 2, {}, shaped => shaped.length * 2).join("")).toBe("👍x👍");
    for (const part of shapeReplyParts("😀".repeat(50), 7)) expect(part).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  });

  test("a URL is never cut, even one longer than a part, and a cut never lands inside a link", () => {
    const url = `https://docs.example.org/${"a".repeat(80)}`;
    const parts = shapeReplyParts(`See ${url} and more words after it`, 30);
    expect(parts).toContain(`[docs.example.org](${url})`);
    expect(parts.join(" ")).toContain("more words after it");
    const linked = shapeReplyParts(`[docs](${url})x and then the rest`, 20);
    expect(linked[0]).toBe(`[docs.example.org](${url})`);
    expect(linked.join("")).toContain("x and then the rest");
    for (const size of [10, 25, 40]) {
      // No space to cut at: each part ends before the next link, never inside one.
      const many = shapeReplyParts(Array.from({ length: 6 }, (_, index) => `https://x.example.org/${index}/${"p".repeat(20)}`).join("\u00a0"), size);
      for (const part of many) expect(part).toMatch(/^\u00a0?\[x\.example\.org\]\(https:\/\/x\.example\.org\/\d\/p{20}\)\u00a0?$/);
      expect(many).toHaveLength(6);
    }
  });

  test("each channel escapes its own syntax around what the shaper keeps", () => {
    expect(renderReply(shapeReply("a <b> & c"), "slack")).toBe("a &lt;b&gt; &amp; c");
    expect(renderReply(shapeReply("use @here and _x_"), "discord")).toBe("use @​here and \\_x\\_");
    expect(htmlString(replyHtmlInline(shapeReply(`<script>x</script> ${ORIGIN}/t/a"b`, { appOrigin: ORIGIN })))).not.toMatch(/<script>|"b"/);
    expect(linkLabel("not a url")).toBe("not a url");
  });
});

describe("deliverables", () => {
  test("a claim is an attachment noun plus a send verb", () => {
    for (const claim of ["I've attached the log.", "I'm sending you the report now.", "Sending the file.", "The screenshots are attached.", "I'll share a link to the result.", "Here's the screenshot.",
      "Here's the link to the result.", "Here is a link to the result.", "Below is the log file.", "Attached is the file."])
      expect(deliverableClaim(claim), claim).not.toBeNull();
    for (const plain of ["Here's what the log shows: the build failed.", "Want me to send the screenshot?", "The report is ready to review.", "I can attach the log if you like.",
      "Here are the files I changed: a.ts, b.ts.", "Here's the report.", "I sent the reminder.", "Here's the screenshot I'd take next: the login page.",
      "Here's the log file: build failed at step 3.", "Here are the links:\n- the task\n- the result"])
      expect(deliverableClaim(plain), plain).toBeNull();
  });
  test("a claim whose content the reply lists itself is not a claim", () => {
    expect(deliverableClaim("I've included the files I changed: a.ts, b.ts.")).toBeNull();
    expect(deliverableClaim("I've attached the files I changed:\n- a.ts\n- b.ts")).toBeNull();
    // A screenshot can't be listed in words: naming one is still a claim.
    expect(deliverableClaim("I've attached the screenshots: login page, settings page.")).toBe("I've attached the screenshots");
  });
  test("a link or quoted content backs a claim; dropping a claim says so once and keeps the rest", () => {
    expect(replyCarriesDeliverable(`Here's the link: ${ORIGIN}/t/a`)).toBe(true);
    expect(replyCarriesDeliverable("Here's the log:\n```\nerror\n```")).toBe(true);
    expect(replyCarriesDeliverable("Here's the screenshot.")).toBe(false);
    expect(dropDeliverableClaims("Checks pass. I've attached the screenshot. I've attached the log.\nShip it?")).toBe(`Checks pass. ${NOTHING_ATTACHED}\nShip it?`);
    expect(dropDeliverableClaims("Here's the screenshot.")).toBe(NOTHING_ATTACHED);
  });
  test("dropping a claim never drops what it listed", () => {
    expect(dropDeliverableClaims("I've attached the screenshots: login page, settings page.")).toBe("I couldn't attach that to this reply: login page, settings page.");
    expect(dropDeliverableClaims("I've attached the screenshots:\n- login page\n- settings page")).toBe("I couldn't attach that to this reply:\n- login page\n- settings page");
    const listed = "Here are the files I changed: a.ts, b.ts. I've attached the screenshot.";
    expect(dropDeliverableClaims(listed)).toBe(`Here are the files I changed: a.ts, b.ts. ${NOTHING_ATTACHED}`);
  });
});

describe("warm touches", () => {
  test("the first tool step reacts once and starts typing, refreshed until the turn ends; a quick reply gets neither", async () => {
    vi.useFakeTimers();
    try {
      const react = vi.fn(async () => undefined), typing = vi.fn(async () => undefined);
      const quick = warmTurn({ react, typing });
      quick.onProgress({ kind: "started", turn: 1 });
      quick.onProgress({ kind: "step", turn: 1, step: 1 });
      quick.onProgress({ kind: "text", turn: 1, step: 1, text: "Hi" });
      quick.stop();
      expect(react).not.toHaveBeenCalled();
      expect(typing).not.toHaveBeenCalled();

      const slow = warmTurn({ react, typing }, { refreshMs: 1_000 });
      slow.onProgress({ kind: "step", turn: 2, step: 1 });
      slow.onProgress({ kind: "tool", turn: 2, step: 1, label: "Reading the task" });
      slow.onProgress({ kind: "tool", turn: 2, step: 2, label: "Reading the result" });
      expect(react).toHaveBeenCalledTimes(1);
      expect(typing).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(typing).toHaveBeenCalledTimes(3);
      slow.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(typing).toHaveBeenCalledTimes(3);
      expect(react).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  test("an app that refuses (no permission, no reactions) is skipped silently and never breaks the turn", async () => {
    const touches = warmTurn({ react: async () => { throw new Error("missing_scope"); }, typing: () => { throw new Error("boom"); } });
    expect(() => touches.onProgress({ kind: "tool", turn: 1, step: 1, label: "Listing tasks" })).not.toThrow();
    touches.stop();
    const none = warmTurn({});
    expect(() => none.onProgress({ kind: "tool", turn: 1, step: 1, label: "Listing tasks" })).not.toThrow();
    none.stop();
  });
});
