import { describe, expect, test } from "vitest";
import {
  NOTHING_ATTACHED, deliverableClaim, dropDeliverableClaims, linkLabel, renderReply, replyHtmlInline, replyCarriesDeliverable,
  shapeReply, shapeReplyParts, voiceReply,
} from "./reply-shape.js";
import { warmTurn } from "./chat-warmth.js";
import { htmlString } from "./html.js";

const ORIGIN = "https://so.example.com";

describe("one reply shaper, every channel", () => {
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
  test("an app that refuses (no permission, no reactions) is skipped silently and never breaks the turn", async () => {
    const touches = warmTurn({ react: async () => { throw new Error("missing_scope"); }, typing: () => { throw new Error("boom"); } });
    expect(() => touches.onProgress({ kind: "tool", turn: 1, step: 1, label: "Listing tasks" })).not.toThrow();
    touches.stop();
    const none = warmTurn({});
    expect(() => none.onProgress({ kind: "tool", turn: 1, step: 1, label: "Listing tasks" })).not.toThrow();
    none.stop();
  });
});
