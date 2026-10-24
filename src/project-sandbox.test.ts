/**
 * A project's sandbox settings (v133, project-sandbox.ts, docs/plans/sandbox-parity.md C9): read denies, macOS services
 * and unlocked protected files. Stored strictly, changed only by an approver with a password, sealed into new scopes
 * with policy v2 (each list part of the approved digest), and the widenings (services, unlocks) seal only on a
 * person's password, never a mode.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, describeScope, profileFromJson, propose } from "./scope.js";
import { profileWords } from "./server/render-tasks.js";
import { htmlString } from "./html.js";
import { runOperate, EXIT } from "./operate.js";
import { parseReadDeny, parseWriteUnlock, readDenyPath, sandboxOf, validMachLookup, validReadDeny } from "./project-sandbox.js";
import { launchSandboxOf } from "./agent-fence.js";

const REPO = "/repo/main";
let dir: string, db: string, store: Store, lines: string[];
const tokens: Record<string, string> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-project-sandbox-"));
  db = join(dir, "orders.db");
  store = openStore(db);
  const now = new Date();
  const alex = addApprover(store, "alex", now);
  if (!alex.ok) throw new Error("alex");
  tokens["alex"] = alex.token;
  const made = store.createConsoleTask({ title: "known", repo: REPO, filedVia: "console", filedBy: { name: "alex", kind: "person" } }, now);
  if (!made.ok) throw new Error(made.reason);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const run = async (argv: string[]) => { lines = []; return await runOperate("project", ["sandbox", ...argv], line => lines.push(line), { databaseFile: db }); };
const as = (name: string) => ["--as", name, "--token", tokens[name]!];

test("entries are refused unless exact: no patterns, no `..`, no bare home or root; unlocks only protected names", () => {
  expect(["~/.ssh", "/etc/secret", "~/Library/Keychains"].every(validReadDeny)).toBe(true);
  expect(["~", "~/", "/", ".ssh", "~/.ssh/*", "~/../x", "/a/./b", "~/.ssh/"].some(validReadDeny)).toBe(false);
  expect(validMachLookup("com.apple.trustd.agent") && validMachLookup("com.example.tool.*") && validMachLookup("org.chromium.Chromium.MachPortRendezvousServer")).toBe(true);
  // Never: wildcards too wide, or any of the services that act outside the sandbox (whatever the spelling or prefix).
  expect(["*", "trustd", "com.apple; (allow default)", "com.apple.*", "com.apple.coreservices.*", "com.apple.pasteboard.1", "com.apple.SecurityServer",
    "com.apple.securityd.xpc", "com.apple.security.agent", "com.apple.lsd.mapdb", "com.apple.coreservices.appleevents", "com.apple.tccd.system",
    "com.apple.windowserver.active", "com.apple.CoreServices.coreservicesd", "COM.APPLE.TCCD", "com.apple.coreservices.launchservicesd"].some(validMachLookup)).toBe(false);
  expect(parseReadDeny([" ~/.ssh ", "~/.aws", "~/.ssh", ""])).toEqual({ ok: true, list: ["~/.aws", "~/.ssh"] });
  expect(parseWriteUnlock(["src/index.ts"])).toMatchObject({ ok: false });
  expect(readDenyPath("~/.ssh", "/home/a")).toBe("/home/a/.ssh");
  // A damaged row keeps its valid read denies and grants nothing else.
  expect(sandboxOf({ readDeny: ["~/.ssh", "*"], machLookup: ["*"], writeUnlock: "x" })).toEqual({ readDeny: ["~/.ssh"], machLookup: [], writeUnlock: [] });
});

describe("the setting", () => {
  test("shown to anyone, changed by an approver with a password", async () => {
    expect(await run(["--repo", REPO])).toBe(EXIT.ok);
    expect(lines.join("\n")).toMatch(/can read your home folder, as in Anthropic's sandbox runtime/);
    expect(await run(["--repo", REPO, "--read-deny", "~/.ssh,~/.aws"])).toBe(EXIT.refused);
    expect(store.projectSandbox(REPO).readDeny).toEqual([]);
    expect(await run(["--repo", REPO, "--read-deny", "~/.ssh,~/.aws", ...as("alex")])).toBe(EXIT.ok);
    expect(store.projectSandbox(REPO)).toEqual({ readDeny: ["~/.aws", "~/.ssh"], machLookup: [], writeUnlock: [] });
    expect(await run(["--repo", REPO, "--read-deny", "~/../x", ...as("alex")])).toBe(EXIT.usage);
  });

  test("new scopes seal policy v2 and the lists, each changing the digest; services and unlocks seal only on a person's password", () => {
    store.createTask({ id: "t-1", title: "t-1" }, new Date());
    store.placeTask(store.lookupRef("t-1")!.id, REPO);
    for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", new Date());
    const file = () => propose(store, { taskId: "t-1", goal: "Do the thing", touches: ["a.ts"], acceptance: [{ id: "c1", statement: "It works", how: null, evidence: ["manual-review"] }], now: new Date() });
    const plain = file();
    expect(plain.profile).toMatchObject({ fencePolicy: 2 });
    expect(plain.profile?.readDeny).toBeUndefined();
    store.setProjectSandbox(REPO, { readDeny: ["~/.ssh"], machLookup: [], writeUnlock: [] }, "alex", new Date());
    const denied = file();
    expect(denied.profile?.readDeny).toEqual(["~/.ssh"]);
    expect(denied.digest).not.toBe(plain.digest);
    expect(launchSandboxOf(denied.profile!)).toEqual({ policy: 2, readDeny: ["~/.ssh"], machLookup: [], unlock: [] });
    // A mode may seal a read deny (it only narrows) but not a widening.
    expect(store.sealScopeApproval("t-1", "mode standard", new Date(), {}, { kind: "mode", modeDigest: "d" })).toBe(true);
    store.setProjectSandbox(REPO, { readDeny: [], machLookup: ["com.apple.trustd.agent"], writeUnlock: [".vscode/settings.json"] }, "alex", new Date());
    store.createTask({ id: "t-2", title: "t-2" }, new Date());
    store.placeTask(store.lookupRef("t-2")!.id, REPO);
    const wide = propose(store, { taskId: "t-2", goal: "Do it", touches: ["a.ts"], acceptance: [{ id: "c1", statement: "It works", how: null, evidence: ["manual-review"] }], now: new Date() });
    expect(wide.profile).toMatchObject({ machLookup: ["com.apple.trustd.agent"], writeUnlock: [".vscode/settings.json"] });
    // Every sealed term is said where the yes is asked for: the CLI's scope words and the console's scope view.
    const scope = store.getScope("t-2")!;
    const cli = describeScope(scope).join("\n");
    expect(cli).toMatch(/reads\s+your home folder, as in Anthropic's sandbox runtime/);
    expect(cli).toMatch(/services\s+also reaches these macOS services: com\.apple\.trustd\.agent/);
    expect(cli).toMatch(/unlocked\s+protected files it may still write: \.vscode\/settings\.json/);
    const web = htmlString(profileWords(scope));
    expect(web).toContain("data-scope-reads");
    expect(web).toContain("Also reaches these macOS services: com.apple.trustd.agent");
    expect(web).toContain("Protected files it may still write: .vscode/settings.json");
    expect(describeScope(store.getScope("t-1")!).join("\n")).toMatch(/reads\s+your home folder, as in Anthropic's sandbox runtime, except ~\/\.ssh/);
    for (const kind of ["mode", "grant", "chat"] as const) expect(store.sealScopeApproval("t-2", "alex", new Date(), {}, { kind, modeDigest: "d" }, "person")).toBe(false);
    expect(store.sealScopeApproval("t-2", "alex", new Date())).toBe(true);
  });

  test("an approval from before 0.9.70 reads as v1 with nothing listed; a stored profile with an unknown policy or a bad list is not this code's", () => {
    const legacy = { provider: "claude", model: "claude-opus-5-5", permissionArgv: "auto", maxTurns: 200, repairMaxTurns: 20, timeoutSeconds: 1800, repairTimeoutSeconds: 600, repairModel: "inherit" } as const;
    expect(launchSandboxOf(legacy)).toEqual({ policy: 1, readDeny: [], machLookup: [], unlock: [] });
    const wrap = (profile: unknown) => JSON.stringify({ digestVersion: 2, profile });
    expect(profileFromJson(wrap({ ...legacy, fencePolicy: 2, readDeny: ["~/.ssh"] }))).toMatchObject({ fencePolicy: 2, readDeny: ["~/.ssh"] });
    expect(profileFromJson(wrap({ ...legacy, fencePolicy: 3 }))).toBeNull();
    expect(profileFromJson(wrap({ ...legacy, readDeny: ["~/.ssh", "~/.aws"] }))).toBeNull();
    expect(profileFromJson(wrap({ ...legacy, machLookup: ["*"] }))).toBeNull();
  });
});
