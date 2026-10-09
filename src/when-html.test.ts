import { describe, expect, test, vi } from "vitest";
import { Window } from "happy-dom";
import { deadlineWords, localizeTimes, shortAge, shortWhen, whenHtml, whenUtc } from "./when-html.js";
import { ledgerBody } from "./ledger-view.js";
import { html, htmlString } from "./html.js";

describe("times on a phone", () => {
  const now = new Date("2026-09-30T17:10:00Z");

  test("today is the clock, yesterday and tomorrow say so, other days are a date", () => {
    expect(shortWhen("2026-09-30T16:39:12.000Z", now)).toBe("16:39");
    expect(shortWhen("2026-09-29T16:39:00Z", now)).toBe("Yesterday 16:39");
    expect(shortWhen("2026-10-01T08:05:00Z", now)).toBe("Tomorrow 08:05");
    expect(shortWhen("2026-09-28T23:59:00Z", now)).toBe("Sep 28");
    expect(shortWhen("2025-12-31T10:00:00Z", now)).toBe("Dec 31 2025");
    expect(shortWhen("not a time", now)).toBe("not a time");
  });

  test("the desk keeps the full stamp, and so does the title", () => {
    const stamp = htmlString(whenUtc("2026-09-30T16:39:12.000Z", now));
    expect(stamp).toBe('<time data-when datetime="2026-09-30T16:39:12.000Z" title="2026-09-30 16:39 UTC"><span class="so-when-full">2026-09-30 16:39 UTC</span><span class="so-when-short">16:39</span></time>');
    expect(htmlString(whenHtml(null, "never", now))).toBe("");
    expect(htmlString(whenHtml("2026-09-30T16:39:00Z", '<b>"', now))).toContain('title="&lt;b&gt;&quot;"');
  });
});

test("a Crew row's age is one short mark", () => {
  const now = new Date("2026-09-30T17:10:00Z");
  expect(shortAge("2026-09-30T17:09:31Z", now)).toBe("now");
  expect(shortAge("2026-09-30T18:00:00Z", now)).toBe("now");
  expect(shortAge("2026-09-30T17:06:00Z", now)).toBe("4m");
  expect(shortAge("2026-09-30T15:05:00Z", now)).toBe("2h");
  expect(shortAge("2026-09-29T17:11:00Z", now)).toBe("23h");
  expect(shortAge("2026-09-27T09:00:00Z", now)).toBe("3d");
  expect(shortAge("not a time", now)).toBe("");
});

describe("the one formatter in the viewer's zone", () => {
  const now = new Date("2026-10-02T19:00:00Z");
  const zone = "America/Los_Angeles";

  test("a deadline or history line further out keeps its time of day", () => {
    expect(shortWhen("2026-09-28T23:59:00Z", now, "UTC", true)).toBe("Sep 28 23:59");
    expect(shortWhen("2025-12-31T10:00:00Z", now, "UTC", true)).toBe("Dec 31 2025 10:00");
    expect(shortWhen("2026-10-02T16:30:00Z", now, "UTC", true)).toBe("16:30");
    expect(deadlineWords({ at: "2026-10-02T23:30:00Z", label: "No reply by" }, now, zone)).toBe("No reply by 16:30");
    expect(deadlineWords({ at: "2026-10-03T23:30:00Z", label: "No reply by" }, now, zone)).toBe("No reply by Tomorrow 16:30");
    expect(deadlineWords({ at: "2026-10-09T23:30:00Z", label: "Moves on at" }, now, zone)).toBe("Moves on Oct 9 16:30");
  });

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

  test("one Intl.DateTimeFormat per zone, however many times a page shows", () => {
    const made = vi.spyOn(Intl, "DateTimeFormat");
    try {
      for (let i = 0; i < 50; i++) shortWhen(`2026-09-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00Z`, now, "Asia/Kathmandu");
      expect(made.mock.calls.filter(call => (call[1] as Intl.DateTimeFormatOptions | undefined)?.timeZone === "Asia/Kathmandu")).toHaveLength(1);
    } finally { made.mockRestore(); }
  });
});
