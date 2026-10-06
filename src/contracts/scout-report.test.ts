import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseReport } from "../scout-report.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { toModelSchema } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { REPORT_LIMITS, SCOUT_OUTPUT_JSON_SCHEMA, scoutHandbackSchema, scoutReportSchema, storedReportSchema } from "./scout-report.js";

type Sample = { name: string; payload: unknown };
const saved = JSON.parse(readFileSync(new URL("../../test/fixtures/scout-reports/report-payloads.json", import.meta.url), "utf8")) as {
  stored: (Sample & { release: string })[];
  written: Sample[];
  invalid: (Sample & { paths: string[] })[];
};

const reader = (stored: boolean) => (input: unknown): SampleVerdict => {
  // Stored reports are read back exactly as the runner wrote them: pretty-printed JSON.
  const parsed = parseReport(JSON.stringify(input, null, stored ? 2 : 0), { stored });
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.problems.map(problem => problem.message) };
};
const report = (payload: Record<string, unknown>) => parseReport(JSON.stringify({ version: 1, title: "t", summary: "s", report: "r", ...payload }));

describe("the scout report contract", () => {
  it.each([false, true].flatMap(stored => [undefined, 1, null].map(version => ({ stored, version }))))(
    "reads extra keys and null lists like an unversioned report (version: $version, stored: $stored)", ({ stored, version }) => {
    const expected = {
      title: "t", summary: "s", report: "r",
      followUps: [{ title: "Follow up", goal: "Check the finding." }],
      items: [{ title: "Finding", why: "It matters.", url: "https://example.com/", image: "home.png" }],
      images: [{ file: "home.png", caption: "Home page", url: "https://example.com/", sha256: "a".repeat(64), artifact: 1 }],
    };
    const payload = {
      ...expected, version, notes: "scratch",
      followUps: expected.followUps.map(one => ({ ...one, extra: true })),
      items: expected.items.map(one => ({ ...one, extra: true })),
      images: expected.images.map(one => ({ ...one, extra: true })),
    };
    expect(parseReport(JSON.stringify(payload), { stored })).toEqual({ ok: true, report: expected });
    expect(parseReport(JSON.stringify({ ...payload, followUps: null, items: null, images: null }), { stored })).toEqual({
      ok: true, report: { ...expected, followUps: [], items: [], images: [] },
    });
  });

  it("holds for what a scout writes: the round trip loses nothing, current and older reports parse, malformed ones are refused by path", () => {
    expect(saved.stored.length + saved.written.length).toBeGreaterThanOrEqual(10);
    assertContract({
      schema: scoutHandbackSchema,
      read: reader(false),
      valid: [...saved.written, ...saved.stored.filter(one => one.release !== "0.9.28")].map(one => ({ name: one.name, input: one.payload })),
      invalid: saved.invalid.map(one => ({ name: one.name, input: one.payload, paths: one.paths })),
    });
  });

  it("holds for every saved report: each release's report.json reads back, long text included, and every other rule still refuses", () => {
    assertContract({
      schema: storedReportSchema,
      read: reader(true),
      valid: [...saved.stored, ...saved.written].map(one => ({ name: one.name, input: one.payload })),
      invalid: saved.invalid.filter(one => !one.name.startsWith("too many")).map(one => ({ name: one.name, input: one.payload, paths: one.paths })),
    });
    // The report kept whole after its shorten turn is over today's limit when written, and whole when read back.
    const kept = saved.stored.find(one => one.release === "0.9.28")!.payload as { summary: string };
    expect(reader(false)(kept)).toEqual({ ok: false, lines: [`summary: over ${TEXT_LIMITS.reportSummary.toLocaleString("en-US")} bytes`] });
    expect(parseReport(JSON.stringify(kept), { stored: true })).toMatchObject({ ok: true, report: { summary: kept.summary } });
  });

  it("reads each saved report into the same shape the runner wrote", () => {
    for (const one of saved.stored) {
      const payload = one.payload as Record<string, unknown>;
      const parsed = parseReport(JSON.stringify(payload, null, 2), { stored: true });
      expect(parsed, one.name).toEqual({ ok: true, report: { followUps: [], items: [], images: [], ...payload } });
    }
  });

  it("is what the scout's --json-schema says, with limits from TEXT_LIMITS", () => {
    expect(SCOUT_OUTPUT_JSON_SCHEMA).toEqual(toModelSchema(scoutHandbackSchema));
    const properties = SCOUT_OUTPUT_JSON_SCHEMA["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["report"]).toEqual(toModelSchema(scoutReportSchema));
    expect(SCOUT_OUTPUT_JSON_SCHEMA).toMatchObject({ required: ["kind"], additionalProperties: false, properties: { kind: { enum: ["report", "question"] } } });
    const fields = properties["report"]!["properties"] as Record<string, Record<string, unknown>>;
    expect(fields["summary"]).toMatchObject({ maxLength: TEXT_LIMITS.reportSummary, description: expect.stringContaining(`at most ${TEXT_LIMITS.reportSummary.toLocaleString("en-US")} bytes`) });
    expect(fields["report"]?.["maxLength"]).toBe(TEXT_LIMITS.reportDocumentBytes);
    expect(fields["followUps"]).toMatchObject({ maxItems: REPORT_LIMITS.followUps, items: { additionalProperties: false, required: ["title", "goal"] } });
    expect(fields["items"]).toMatchObject({ maxItems: REPORT_LIMITS.items, items: { required: ["title", "why", "url"] } });
    expect(fields["images"]).toMatchObject({ maxItems: REPORT_LIMITS.images, items: { required: ["file", "caption", "url"] } });
    expect(properties["report"]).toMatchObject({ required: ["version", "title", "summary", "report"], additionalProperties: false });
    // The question branch is the park mailbox's decision, the fields parseDecision reads.
    expect(properties["decision"]).toMatchObject({ required: ["urgency", "recap", "question", "options", "recommendation"], additionalProperties: false });
  });

  it.each([undefined, 1, null])("keeps reason codes and field paths for version %s", version => {
    const lines = (payload: Record<string, unknown>) => {
      const parsed = report({ version, notes: "scratch", ...payload });
      return parsed.ok ? [] : parsed.problems.map(problem => [problem.reason, problem.message]);
    };
    expect(lines({ title: "x".repeat(REPORT_LIMITS.title + 1) })).toEqual([["title-too-long", "title: over 200 bytes"]]);
    expect(lines({ items: [{ title: "t", why: "漢".repeat(400), url: "https://example.com/" }] })).toEqual([["items[0].why-too-long", "items[0].why: over 1,000 bytes"]]);
    expect(lines({ items: [{ title: "t", why: "w", url: "file:///etc/passwd" }] })).toEqual([["items[0].url-not-a-link", "items[0].url: must be an http or https address"]]);
    expect(lines({ followUps: [{ title: "t", onFail: "x" }] })).toEqual([
      ["missing-followUps[0].goal", "followUps[0].goal: required"],
    ]);
    expect(lines({ items: [{ title: "t", why: "w", url: "https://example.com/", image: "home.png" }], images: null })).toEqual([
      ["bad-items[0].image", "items[0].image: must name one of images by its file"],
    ]);
    expect(lines({ items: [null] })).toEqual([["missing-items[0]", "items[0]: required"]]);
    expect(lines({ items: "none" })).toEqual([["bad-items", "items: must be an array (got a string)"]]);
    expect(lines({ version: "1" })).toEqual([["bad-version", 'version: unknown version "1" (this Toolroll reads 1 and 0)']]);
    expect(lines({ version: 3 })).toEqual([["newer-version", "version: made by a newer Toolroll (version 3; this one reads up to 1)"]]);
  });

  it("refuses a payload over its byte cap, and anything that is not one JSON object, before the schema", () => {
    expect(parseReport("x".repeat(REPORT_LIMITS.payload + 1))).toMatchObject({ ok: false, problems: [{ reason: "too-large", message: "payload: over 98,304 bytes" }] });
    expect(parseReport("{")).toMatchObject({ ok: false, problems: [{ reason: "not-json" }] });
    expect(parseReport("[]")).toMatchObject({ ok: false, problems: [{ reason: "not-an-object", message: "payload: must be one JSON object" }] });
  });
});

describe("docs/plans/zod-revamp.md", () => {
  it("marks wave 1 item 4 done", () => {
    const doc = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");
    expect(doc).toMatch(/^\| 4 ✅ \| \*\*Scout report\*\*/m);
    expect(doc.slice(doc.indexOf("## Done"))).toContain("**4. Scout report**");
  });
});
