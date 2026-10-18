import { describe, expect, test } from "vitest";
import { Window } from "happy-dom";
import { localizeTimes, whenHtml, whenUtc } from "./when-html.js";
import { ledgerBody } from "./ledger-view.js";
import { html, htmlString } from "./html.js";

describe("times on a phone", () => {
  const now = new Date("2026-09-30T17:10:00Z");

  test("a missing time renders nothing and an untrusted title is escaped", () => {
    expect(htmlString(whenHtml(null, "never", now))).toBe("");
    expect(htmlString(whenHtml("2026-09-30T16:39:00Z", '<b>"', now))).toContain('title="&lt;b&gt;&quot;"');
  });
});

describe("the one formatter in the viewer's zone", () => {
  const now = new Date("2026-10-02T19:00:00Z");
  const zone = "America/Los_Angeles";

  test("only the server's stamps are reworded, the ledger's keeping its seconds; React's times and relative ages keep theirs", async () => {
    const window = new Window();
    try {
      const ledger = ledgerBody([{ id: 7, at: "2026-10-01T21:16:42.123Z", actor: "sam", repo: null, taskId: null, runId: null, action: "Approved", outcome: "ok", source: "work", detail: null }], [], new URLSearchParams());
      window.document.body.innerHTML =
        htmlString(html`<div data-workspace-native>${whenUtc("2026-10-01T21:16:00.000Z", now)}${ledger}</div>`) +
        // The home lead's age and a thread time, as React writes them.
        `<p id="lead"><time datetime="2026-10-02T18:57:00.000Z">3 min ago</time></p><p id="thread"><time datetime="2026-10-02T16:39:00.000Z" title="2026-10-02 09:39">09:39</time></p>` +
        `<p id="chat"><time datetime="2026-10-02T18:57:00.000Z">3m ago</time></p>`;
      // Without script, the ledger's own UTC words, said as UTC.
      expect(window.document.querySelector(".ledger-time time")!.textContent).toBe("2026-10-01 21:16:42 UTC");
      localizeTimes(window.document as unknown as ParentNode, now, zone);
      const server = window.document.querySelector("time[data-when]")!;
      expect(server.textContent).toBe("Yesterday 14:16");
      expect(server.getAttribute("title")).toBe("2026-10-01 14:16");
      const exact = window.document.querySelector(".ledger-time time")!;
      expect(exact.textContent).toBe("2026-10-01 14:16:42");
      expect(exact.getAttribute("title")).toBe("2026-10-01T21:16:42.123Z");
      expect(window.document.querySelector("#lead time")!.textContent).toBe("3 min ago");
      expect(window.document.querySelector("#thread time")!.textContent).toBe("09:39");
      expect(window.document.querySelector("#thread time")!.getAttribute("title")).toBe("2026-10-02 09:39");
      expect(window.document.querySelector("#chat time")!.textContent).toBe("3m ago");
    } finally { await window.happyDOM.close(); }
  });
});
