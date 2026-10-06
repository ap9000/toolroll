import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../store.js";
import { fileTaskProposal } from "../proposal.js";
import { leadContext, LEAD_CONTEXT_MAX_BYTES } from "../lead-context.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { parseContract } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { leadContextSchema } from "./lead-context.js";

const T0 = new Date("2026-10-02T13:05:00.000Z");
const WEB = "/repo/web-shop";

const read = (input: unknown): SampleVerdict => {
  const parsed = parseContract(leadContextSchema, input);
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
};

describe("the lead context bundle contract", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
    store.saveApprover("sam.rivera", "h".repeat(64), T0);
  });
  afterEach(() => store.close());

  const built = (options: Parameters<typeof leadContext>[3] = {}) => JSON.parse(leadContext(store, [WEB], T0, { owner: "sam.rivera", channel: "telegram", timeZone: "Europe/London", projectName: () => "web-shop", ...options })) as Record<string, unknown>;

  it("holds: the JSON Schema round trip loses nothing, built bundles read, malformed ones are refused by path", () => {
    const filed = fileTaskProposal(store, { id: "checkout-fix", title: "Fix the checkout button", repo: WEB, filedVia: "cli" }, T0);
    if (!filed.ok) throw new Error(filed.reason);
    store.handle.prepare(`INSERT INTO project_decision(repo,identity,revision,claim,why,status,decided_by,decided_at,source_kind,recorded_by,sha)
      VALUES (?,'i',1,'Use Stripe Checkout','Hosted pages keep card data off our servers.','active','sam.rivera',?,'manual','sam.rivera','s')`).run(WEB, T0.toISOString());
    const bundle = built();
    const followed = { ...bundle,
      commitments: [{ id: 1, what: "Tell you when the checkout fix is ready", when: "when “Fix the checkout button” is Ready", expires: "2026-10-09T13:05:00.000Z" }],
      corrections: [{ proposal: 4, change: "Project instructions now end: Keep labels short." }],
      openProposals: [{ proposal: 5, kind: "task", about: null }],
      followThrough: "The operator confirmed these corrections since your last reply." };
    const ordered = Object.fromEntries(Object.keys(leadContextSchema.shape).filter(key => key in followed).map(key => [key, followed[key as keyof typeof followed]]));
    assertContract({
      schema: leadContextSchema,
      read,
      valid: [
        { name: "a built bundle", input: bundle },
        { name: "a built bundle outside any channel", input: built({ channel: undefined }) },
        { name: "with this conversation's follow-through", input: ordered },
      ],
      invalid: [
        { name: "another bundle version", input: { ...bundle, snapshotVersion: 2 }, paths: ["snapshotVersion"] },
        { name: "an unknown channel", input: { ...bundle, channel: { id: "email", fit: "x", replyLimit: null } }, paths: ["channel.id"] },
        { name: "an unknown key", input: { ...bundle, secrets: [] }, paths: ["payload"] },
        { name: "a task's checks are a status or null", input: { ...bundle, needsYou: [{ ...(bundle["needsYou"] as Record<string, unknown>[])[0], checks: 0 }] }, paths: ["needsYou[0].checks"] },
        { name: "a promise over its limit", input: { ...ordered, commitments: [{ id: 1, what: "w".repeat(TEXT_LIMITS.leadPromise + 1), when: "soon", expires: "x" }] }, paths: ["commitments[0].what"] },
        { name: "a correction over its limit", input: { ...ordered, corrections: [{ proposal: 4, change: "c".repeat(TEXT_LIMITS.leadCorrection + 1) }] }, paths: ["corrections[0].change"] },
        { name: "more than 8 projects", input: { ...bundle, projects: Array.from({ length: 9 }, (_, index) => ({ repo: `r${index + 1}`, name: "p", decisions: [] })) }, paths: ["projects"] },
        { name: "omissions count people", input: { ...bundle, omissions: { ...(bundle["omissions"] as Record<string, unknown>), people: undefined } }, paths: ["omissions.people"] },
      ],
    });
  });

  it("is held to TEXT_LIMITS.leadContextBytes as a whole", () => {
    expect(LEAD_CONTEXT_MAX_BYTES).toBe(TEXT_LIMITS.leadContextBytes);
    for (let index = 0; index < 8; index++) {
      store.handle.prepare(`INSERT INTO project_decision(repo,identity,revision,claim,why,status,decided_by,decided_at,source_kind,recorded_by,sha)
        VALUES (?,'i',1,?,?,'active','sam.rivera',?,'manual','sam.rivera','s')`).run(WEB, `Decision ${index} ${"about the checkout ".repeat(30)}`, "Because.", T0.toISOString());
    }
    const document = leadContext(store, [WEB], T0, { owner: "sam.rivera", channel: "slack", projectName: () => "web-shop", redact: text => text.replace(/^Decision /, `Decision ${"padding ".repeat(200)}`) });
    expect(Buffer.byteLength(document)).toBeLessThanOrEqual(TEXT_LIMITS.leadContextBytes);
    expect(read(JSON.parse(document))).toEqual({ ok: true });
  });
});
