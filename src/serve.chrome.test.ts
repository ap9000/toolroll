/**
 * The console server: the chrome layer — sensitivity, motion, editor links,
 * the phone shell, the project switcher and the reduction pass.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { createDecisionServer, SENSITIVE_INPUT } from "./serve.js";
import { presented, T0, workspaceOf } from "../test/serve-kit.js";

describe("arc 4 — the chrome layer, sensitivity, and motion contracts", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;
  let dir: string;

  const url = (path: string) => `${base}${path}`;
  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    dir = mkdtempSync(join(tmpdir(), "standing-orders-arc4-"));
    evidenceRoot = join(dir, "evidence");
    mkdirSync(evidenceRoot, { recursive: true });
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({
      store,
      evidenceRoot,
      clock: () => new Date(),
      repo: "/repo/main",
      telegramTokenFile: join(dir, "telegram-token"),
      configDir: dir,
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a password on screen strips the chrome additions but keeps the page's own behavior", async () => {
    const cookie = await login();
    // /fleet: register/retire take passwords; the reorder poller stays.
    const fleet = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    expect(fleet).not.toContain('id="palette-index"');
    expect(fleet).not.toContain('aria-label="keyboard shortcuts"');
    expect((fleet.match(/<script nonce=/g) ?? []).length).toBe(1);
    expect(fleet).toContain("fleet-region");
    // /settings: token forms beside the push enrollment script — exactly
    // one composed script, no palette.
    const settings = await fetch(url("/settings"), { headers: { cookie } });
    const settingsHtml = await settings.text();
    expect(settingsHtml).not.toContain('id="palette-index"');
    expect((settingsHtml.match(/<script nonce=/g) ?? []).length).toBe(1);
    expect(settings.headers.get("content-security-policy") ?? "").toContain("connect-src 'self'");
  });

  test("settings frame: the page before scripts has its breadcrumb in real links and one h1, the page's own", async () => {
    const cookie = await login();
    const page = await (await fetch(url("/settings/retention"), { headers: { cookie } })).text();
    // The server-rendered document (what a browser without JavaScript shows) beside the workspace's data.
    const shell = page.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(shell).toMatch(/<nav class="kit-crumbs" aria-label="Breadcrumb"><ol><li><a href="\/settings">Settings<\/a><\/li><li aria-current="page">Retention<\/li><\/ol><\/nav>/);
    expect(shell.match(/<h1\b/g)).toHaveLength(1);
    // The hub itself is the top of the trail: no breadcrumb there.
    const hub = (await (await fetch(url("/settings"), { headers: { cookie } })).text()).replace(/<script[\s\S]*?<\/script>/g, "");
    expect(hub).not.toContain('class="kit-crumbs"');
  });

  test("Settings shows one legacy webhook warning with replacement links, including both services", async () => {
    const cookie = await login();
    const get = async () => (await fetch(url("/settings"), { headers: { cookie } })).text();
    expect((workspaceOf(await get()).view as import("./browser-workspace.js").BrowserSettingsView).legacyWebhookWarning).toBeUndefined();
    for (const service of ["slack", "discord"]) writeFileSync(join(dir, `${service}-webhook`), `https://fixture.example/${service}-secret`);
    const html = await get(), view = workspaceOf(html).view as import("./browser-workspace.js").BrowserSettingsView;
    expect(view.legacyWebhookWarning).toBe("Legacy webhooks are deprecated. Connect Slack or Discord in Chat settings.");
    expect(html).not.toContain("fixture.example");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
    const invalid = await fetch(url("/settings/telegram-token"), { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf, token: "invalid" }) });
    expect(invalid.status).toBe(400);
    const failed = await invalid.text();
    expect((workspaceOf(failed).view as import("./browser-workspace.js").BrowserSettingsView).legacyWebhookWarning).toBe(view.legacyWebhookWarning);

  });

  test("sensitivity is judged per response: /next with a step-up is sensitive, all-clear is not", async () => {
    store.createTask({ id: "t-a", title: "needs a yes" }, T0);
    store.saveScope({
      taskId: "t-a", goal: "do the thing", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "d".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const cookie = await login();
    const pending = await (await fetch(url("/next"), { headers: { cookie } })).text();
    expect(pending).toContain("Approve this scope");
    expect(workspaceOf(pending).sensitive).toBe(true);
    expect(pending).not.toContain('id="palette-index"');

    const granted = approve(store, "t-a", "alex", T0, store.getScope("t-a")?.digest as string, approverToken);
    expect(granted.ok).toBe(true);
    const clear = await (await fetch(url("/next"), { headers: { cookie } })).text();
    expect(clear).not.toContain("Approve this scope");
    expect(workspaceOf(clear).sensitive).toBe(false);
  });

  test("the signed rubric restates above the seal on the ceremony, the read-only card, and /next — never a second amber form (v39)", async () => {
    store.createTask({ id: "t-rubric", title: "needs a yes with a rubric" }, T0);
    store.saveScope({
      taskId: "t-rubric", goal: "guard the payout path", outOfScope: null, touches: ["src/payout.ts"],
      acceptance: [
        { id: "c1", statement: "The payout guard rejects a negative amount.", how: "unit test it", evidence: ["check"] },
        { id: "c2", statement: "The settings panel still opens.", how: null, evidence: ["screenshot"] },
      ],
      proposedAt: T0.toISOString(), digest: "e".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const cookie = await login();
    const page = await (await fetch(url("/t/t-rubric"), { headers: { cookie } })).text();
    // Restated in the ceremony, above the seal, with id/statement/evidence.
    const ceremonyMarker = page.indexOf('id="approve"');
    const ceremonyStart = page.lastIndexOf("<form", ceremonyMarker);
    const ceremonyEnd = page.indexOf("</form>", ceremonyMarker);
    expect(ceremonyMarker).toBeGreaterThan(-1);
    const approveForm = page.slice(ceremonyStart, ceremonyEnd);
    // Plain sentences under "Done when" before the password; the ids and
    // evidence kinds in the Details fold, never in the main view.
    const ceremonyAcceptance = approveForm.indexOf("<dt>Done when</dt>");
    const ceremonySeal = approveForm.indexOf('<div class="approval-act" id="approval-confirm">');
    expect(ceremonyAcceptance).toBeGreaterThan(-1);
    expect(ceremonyAcceptance).toBeLessThan(ceremonySeal);
    expect(approveForm).toContain('<ul class="approval-done"><li>The payout guard rejects a negative amount.</li><li>The settings panel still opens.</li></ul>');
    const rows = approveForm.slice(0, approveForm.indexOf('<details class="approval-details">'));
    expect(rows).not.toMatch(/\bc[12]\b|requires:/);
    expect(approveForm).toContain('<code>c1</code> The payout guard rejects a negative amount. <span class="meta">shown by the project check</span>');
    expect(approveForm).toContain('<code>c2</code> The settings panel still opens. <span class="meta">shown by screenshots</span>');
    // No competing primary: exactly one submit button the ceremony form owns
    // (Edit plan's Save belongs to its own form).
    expect((approveForm.match(/<button type="submit"(?! form=)/g) ?? []).length).toBe(1);
    // Advisory `how` never renders inside the ceremony form itself — only
    // in the separate, later scope-EDIT textarea, which legitimately shows
    // it back for editing.
    expect(approveForm).not.toContain("unit test it");

    // The read-only scope card (post-approval) restates it too, above its seal.
    const granted = approve(store, "t-rubric", "alex", T0, store.getScope("t-rubric")?.digest as string, approverToken);
    expect(granted.ok).toBe(true);
    const after = await (await fetch(url("/t/t-rubric"), { headers: { cookie } })).text();
    const cardAcceptance = after.indexOf(">Acceptance<");
    const cardSeal = after.indexOf("approval binds to this exact wording");
    expect(cardAcceptance).toBeGreaterThan(-1);
    expect(cardAcceptance).toBeLessThan(cardSeal);

    // /next restates it identically for a second, unapproved task.
    store.createTask({ id: "t-rubric-2", title: "another" }, T0);
    store.saveScope({
      taskId: "t-rubric-2", goal: "g", outOfScope: null, touches: [],
      acceptance: [{ id: "c1", statement: "It works.", how: null, evidence: ["manual-review"] }],
      proposedAt: T0.toISOString(), digest: "f".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const next = await (await fetch(url("/next"), { headers: { cookie } })).text();
    expect(next).toContain("<code>c1</code> It works.");
    expect(next).toContain("[requires: manual-review]");
  });

  test("the classifier reads every password serialization and no near-miss", () => {
    for (const yes of [
      '<input type="password" name="token">',
      "<input type='password' name='token'>",
      "<input type=password>",
      '<input name="token" TYPE="Password" required>',
      '<input\n  class="wide"\n  type = "password">',
    ]) {
      expect(SENSITIVE_INPUT.test(yes), yes).toBe(true);
    }
    for (const no of [
      '<input data-type="password" name="x">',
      '<input type="text" placeholder="not a password here">',
      "<p>your password, typed again</p>",
      '<input type="text" name="password-hint">',
    ]) {
      expect(SENSITIVE_INPUT.test(no), no).toBe(false);
    }
  });

  test("the console palette (a page read with a token) is escaped JSON that parses back exactly", async () => {
    store.createTask({ id: "t-x", title: 'sharp <b>title</b> & "quotes"' }, T0);
    const bearer = { authorization: `Bearer alex:${approverToken}` };
    const first = await (await fetch(url("/done"), { headers: bearer })).text();

    // Escaping: the raw HTML never spells a closing script tag; parsing
    // restores the title exactly.
    const tag = /<script type="application\/json" id="palette-index">(.*?)<\/script>/s.exec(first);
    expect(tag?.[1]).toContain("\\u003c");
    expect(tag?.[1]).not.toContain("</script>");
    const parsed = JSON.parse(tag?.[1] ?? "[]") as { label: string }[];
    expect(parsed.some(one => one.label.includes('sharp <b>title</b> & "quotes"'))).toBe(true);

  });
});

describe("arc 6 — editor links, the review flow, and their guards", () => {
  test("editorFileHref refuses everything untame and encodes what it links", async () => {
    const { editorFileHref } = await import("./serve.js");
    // refusals
    expect(editorFileHref("relative/worktree", "a.ts")).toBeNull();
    expect(editorFileHref("/pool/t-1", "../escape.ts")).toBeNull();
    expect(editorFileHref("/pool/t-1", "src/../../up.ts")).toBeNull();
    expect(editorFileHref("/pool/t-1", "/absolute.ts")).toBeNull();
    expect(editorFileHref("/pool/t-1", "windows\\path.ts")).toBeNull();
    expect(editorFileHref("/pool/t-1", "src//double.ts")).toBeNull();
    expect(editorFileHref("/pool/t-1", "ctl" + String.fromCharCode(7) + ".ts")).toBeNull();
    expect(editorFileHref("/pool" + String.fromCharCode(0) + "bad", "a.ts")).toBeNull();
    expect(editorFileHref("/pool/../t-1", "a.ts")).toBeNull();
    // links, encoded
    expect(editorFileHref("/pool/t-1", "src/a.ts")).toBe("vscode://file/pool/t-1/src/a.ts");
    expect(editorFileHref("/pool/t-1", 'has space/"quote".ts')).toBe(
      "vscode://file/pool/t-1/has%20space/%22quote%22.ts",
    );
    // line bounds: the comment form's own range, nothing looser
    expect(editorFileHref("/pool/t-1", "a.ts", 42)).toBe("vscode://file/pool/t-1/a.ts:42");
    expect(editorFileHref("/pool/t-1", "a.ts", 0)).toBe("vscode://file/pool/t-1/a.ts");
    expect(editorFileHref("/pool/t-1", "a.ts", 1_000_001)).toBe("vscode://file/pool/t-1/a.ts");
  });

  describe("over real HTTP", () => {
    let store: Store;
    let server: Server;
    let base: string;
    let evidenceRoot: string;
    let approverToken: string;
    let runId: number;

    const url = (path: string) => `${base}${path}`;
    const login = async (): Promise<string> => {
      const response = await fetch(url("/login"), {
        method: "POST",
        body: new URLSearchParams({ name: "alex", token: approverToken }),
        redirect: "manual",
      });
      return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
    };
    const csrfOf = async (cookie: string): Promise<string> => {
      const html = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
      return /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] as string;
    };
    const activate = async (cookie: string, on = true): Promise<void> => {
      const csrf = await csrfOf(cookie);
      await fetch(url("/session/editor-links"), {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ csrf, on: on ? "1" : "0", return: `/r/${runId}` }),
        redirect: "manual",
      });
    };

    beforeEach(async () => {
      store = openStore(":memory:");
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
      store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
      evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-arc6-ev-"));
      const added = addApprover(store, "alex", T0);
      if (!added.ok) throw new Error("bootstrap failed");
      approverToken = added.token;
      store.createTask({ id: "t-review", title: "reviewed work" }, T0);
      const taskRef = store.refFor("built-in", "t-review").id;
      runId = store.startRun({
        taskRef, leaseId: "l-review", runner: "builder-1",
        branch: "so/t-review", worktree: "/pool/t review", now: T0,
        ...presented(store, taskRef, "builder"),
      });
      const patch = [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@",
        " keep",
        "-old value",
        "+edited",
        " end",
        "",
      ].join("\n");
      storeEvidence(store, evidenceRoot, runId, "terminal-diff", "terminal-diff.patch",
        Buffer.from(patch, "utf8"), "git diff (exit 0)", T0, { captureStatus: "ok" });
      storeEvidence(store, evidenceRoot, runId, "diff-stat", "terminal-diff-stat.json",
        Buffer.from(JSON.stringify({
          base: "b".repeat(12), head: "h".repeat(12), fileCount: 2, additions: 3, deletions: 1,
          binaryCount: 0, filesTruncated: false,
          files: [{ path: "src/a.ts", additions: 3, deletions: 1 }, { path: "../evil.ts", additions: 0, deletions: 0 }],
        }), "utf8"), "git diff --numstat (exit 0)", T0, { captureStatus: "ok" });
      store.finishRun(runId, { outcome: "built", committed: true, now: T0 });

      server = createDecisionServer({
        store, evidenceRoot, clock: () => new Date(), repo: "/repo/main",
        localRunner: "builder-1", poolRoot: "/pool",
        editorLinks: "vscode",
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("no address");
      base = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      rmSync(evidenceRoot, { recursive: true, force: true });
    });

    test("links render only after the SESSION says yes; hostile paths never link; the toggle flips both ways", async () => {
      const cookie = await login();
      // capability on, session off: no links, an offer to turn them on
      const before = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
      expect(before).not.toContain("vscode://");
      expect(before).toContain("open files in VS Code from this device");
      // session yes: tame paths link (worktree space encoded), traversal never does
      await activate(cookie);
      const after = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
      expect(after).toContain('href="vscode://file/pool/t%20review/src/a.ts"');
      expect(after.match(/vscode:[^"]*evil/) ?? []).toEqual([]);
      expect(after).toContain("on THIS device");
      // and off again
      await activate(cookie, false);
      const off = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
      expect(off).not.toContain("vscode://");
    });

    test("a run owned by ANOTHER runner never links and never offers", async () => {
      const other = store.startRun({
        taskRef: store.refFor("built-in", "t-review").id, leaseId: "l-other", runner: "someone-else",
        branch: "so/other", worktree: "/pool/other", now: T0,
        ...presented(store, store.refFor("built-in", "t-review").id, "builder"),
      });
      store.finishRun(other, { outcome: "built", committed: true, now: T0 });
      const cookie = await login();
      await activate(cookie);
      const html = await (await fetch(url(`/r/${other}`), { headers: { cookie } })).text();
      expect(html).not.toContain("vscode://");
      expect(html).not.toContain("open files in VS Code");
    });

    test("follow-up on build 1540: the annotation form advertises the server's own 4000-character limit, with helper text and a counter", async () => {
      const cookie = await login();
      const csrf = await csrfOf(cookie);
      // Enforced: exactly 4000 lands; 4001 is refused by the same rule the form now advertises.
      const post = (note: string) => fetch(url(`/r/${runId}/comment`), { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, path: "src/a.ts", line: "2", note }), redirect: "manual" });
      const full = await post("n".repeat(4000));
      expect(full.status).toBe(303);
      expect(store.liveDiffComments(runId)).toHaveLength(1);
      const over = await post("n".repeat(4001));
      expect(over.status).toBe(400);
      expect(await over.text()).toContain("a note is at most 4000 characters");
      expect(store.liveDiffComments(runId)).toHaveLength(1);
    });
  });

  test("--editor is validated before anything starts, on both commands", async () => {
    const { runOperate } = await import("./operate.js");
    for (const [verb, argv] of [
      ["serve", ["--editor", "emacs", "--json"]],
      ["serve", ["--editor", "vscode", "--json"]],
      ["up", ["--editor", "emacs", "--json"]],
    ] as const) {
      const lines: string[] = [];
      await runOperate(verb, argv as unknown as string[], line => lines.push(line), { databaseFile: ":memory:" });
      const body = JSON.parse(lines.join("\n")) as { ok: boolean; reason: string };
      expect(body.ok, `${verb} ${argv.join(" ")}`).toBe(false);
      expect(body.reason).toBe("usage");
    }
  });
});

describe("the phone shell (mobile pass): one header row, drawn controls, thumb-sized acts", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const T0 = new Date("2026-08-11T00:00:00.000Z");
  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-phone-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("an accent colour re-pigments the signal for this browser only", async () => {
    const cookie = await login();
    const page = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
    const post = (accent: string, quiet = false) => fetch(url("/settings/appearance"), { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, accent, ...(quiet ? { quiet: "1" } : {}) }), redirect: "manual" });
    const chosen = await post("#BB2649");
    expect(chosen.status).toBe(303);
    expect(chosen.headers.get("set-cookie")).toBe("so-accent=bb2649; SameSite=Lax; Path=/; Max-Age=31536000");
    // The picker saves in the background: no page to go back to.
    expect((await post("009473", true)).status).toBe(204);
    const html = await (await fetch(url("/inbox"), { headers: { cookie: `${cookie}; so-accent=bb2649` } })).text();
    expect(html).toMatch(/<link rel="stylesheet" href="[^"]+"><style data-accent="#bb2649">:root\{--so-signal:#bb2649;/);
    expect(html).toContain(':root[data-theme="dark"]{--so-signal:');
    // Not a colour: refused; a stale cookie: ignored; the default: clears the cookie.
    expect((await post("not-a-colour")).status).toBe(400);
    expect(await (await fetch(url("/inbox"), { headers: { cookie: `${cookie}; so-accent=not-a-colour` } })).text()).not.toContain("data-accent");
    expect((await post("#171717")).headers.get("set-cookie")).toBe("so-accent=; SameSite=Lax; Path=/; Max-Age=0");
  });
});

describe("the project switcher (board pass): one tap from any screen, forms with the session's own token", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;
  let repoA: string;
  let repoB: string;

  const T0 = new Date("2026-08-11T00:00:00.000Z");
  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };
  const csrfOf = (html: string): string => /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "";

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-switcher-"));
    const root = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-switcher-repos-")));
    repoA = join(root, "alpha");
    repoB = join(root, "beta");
    const { execSync } = await import("node:child_process");
    for (const repo of [repoA, repoB]) {
      mkdirSync(repo, { recursive: true });
      execSync("git init -q", { cwd: repo });
    }
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    store.setChatConfig({
      provider: "anthropic-api", model: "claude-sonnet-5", dailyTurns: 50,
      weeklyCeilingMicrousd: 100_000_000, priceInMicrousd: 3, priceOutMicrousd: 15,
    }, "alex", T0);
    server = createDecisionServer({
      store, evidenceRoot, clock: () => new Date(), repos: [repoA, repoB],
      chatEnv: { ANTHROPIC_API_KEY: "sk-test-key" },
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("opening a project returns to the screen the switch was made on — a same-site path only", async () => {
    const cookie = await login();
    const home = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    const csrf = csrfOf(home);
    const opened = await fetch(url("/projects/open"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf, path: repoA, return: "/queue" }),
      redirect: "manual",
    });
    expect(opened.status).toBe(303);
    expect(opened.headers.get("location")).toBe("/queue");
    // The project is open: the queue renders it and the menu marks it current.
    // An off-site or protocol-relative return lands home instead.
    for (const bad of ["https://evil.example/", "//evil.example/x", "queue"]) {
      const refused = await fetch(url("/projects/open"), {
        method: "POST", headers: { cookie },
        body: new URLSearchParams({ csrf, path: repoB, return: bad }),
        redirect: "manual",
      });
      expect(refused.status).toBe(303);
      expect(refused.headers.get("location")).toBe("/");
    }
    // Widening to all projects returns the same way.
    const widened = await fetch(url("/projects/select"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf, path: "", return: "/workbench" }),
      redirect: "manual",
    });
    expect(widened.headers.get("location")).toBe("/workbench");
  });

  test("Edit plan edits the goal, changes, won't-touch and done-when in place; the edited plan then approves with the password", async () => {
    const cookie = await login();
    const home = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    await fetch(url("/projects/open"), { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf: csrfOf(home), path: repoA, return: "/" }), redirect: "manual" });
    store.createTask({ id: "t-edit", title: "edit in place" }, T0);
    store.placeTask(store.refFor("built-in", "t-edit").id, repoA);
    propose(store, {
      taskId: "t-edit", goal: "guard the payout path", outOfScope: "billing", touches: ["src/payout.ts"], budgetMicrousd: 1_500_000, now: T0,
      acceptance: [
        { id: "c1", statement: "Negative payouts are refused.", how: "unit test it", evidence: ["check"] },
        { id: "c2", statement: "The settings panel opens.", how: null, evidence: ["screenshot"] },
        { id: "c3", statement: "Refusals are logged.", how: "read the log", evidence: ["check"] },
      ],
    });
    const before = store.getScope("t-edit")!;
    const page = await (await fetch(url("/t/t-edit"), { headers: { cookie } })).text();
    // The plain consent line, the password's reason, and the in-place editor.
    expect(page).toContain("You’re allowing: file edits and routine commands; anything risky stops · up to $1.50 per attempt</p>");
    expect(page).not.toContain("data-approval-you-check");
    // Submit exactly what the editor's form carries, with the fields edited.
    const editorForm = page.slice(page.indexOf('<form method="post" action="/t/t-edit/scope" id="plan-editor-form"'));
    const hidden = [...editorForm.slice(0, editorForm.indexOf("</form>")).matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(one => [one[1]!, one[2]!] as [string, string]);
    expect(Object.fromEntries(hidden)).toMatchObject({ sawDigest: before.digest, "permission-mode": "auto", "quality-mode": before.qualityMode ?? "default", "budget-microusd": "1500000" });
    expect(Object.keys(Object.fromEntries(hidden))).not.toContain("budget-usd");
    const edit = (fields: [string, string][]) => fetch(url("/t/t-edit/scope"), { method: "POST", headers: { cookie }, body: new URLSearchParams([...hidden, ...fields]), redirect: "manual" });
    // Every requirement cleared: refused, and the editor reopens with the draft and why.
    const refused = await edit([["goal", "guard it harder"], ["touches", ""], ["not", ""], ["requirement", ""], ["requirement", ""], ["requirement", ""], ["requirement-new", ""]]);
    expect(refused.status).toBe(400);
    const refusedPage = await refused.text();
    expect(refusedPage).toContain('<p class="problem" role="alert">Not saved: add at least one requirement under Done when.</p>');
    expect(store.getScope("t-edit")?.digest).toBe(before.digest);
    const saved = await edit([
      ["goal", "guard the payout path and log refusals"], ["touches", "src/payout.ts\nsrc/log.ts"], ["not", "billing and sign-in"],
      ["requirement", "Negative and zero payouts are refused."], ["requirement", ""], ["requirement", " Refusals are  logged. "], ["requirement-new", "The refusal reads plainly"],
    ]);
    expect(saved.status).toBe(303);
    const after = store.getScope("t-edit")!;
    expect(after).toMatchObject({ goal: "guard the payout path and log refusals", touches: ["src/payout.ts", "src/log.ts"], outOfScope: "billing and sign-in", budgetMicrousd: 1_500_000, qualityMode: before.qualityMode, approvedAt: null });
    // Ids kept by position; an unchanged one keeps its evidence and guidance; a rewritten one
    // drops them and, like an added one, is yours to check; the cleared one is dropped.
    expect(after.acceptance).toEqual([
      { id: "c1", statement: "Negative and zero payouts are refused.", how: null, evidence: ["manual-review"] },
      { id: "c3", statement: "Refusals are logged.", how: "read the log", evidence: ["check"] },
      { id: "c4", statement: "The refusal reads plainly", how: null, evidence: ["manual-review"] },
    ]);
    expect(after.profile).toMatchObject({ provider: "claude", permissionArgv: "auto" });
    expect(after.digest).not.toBe(before.digest);
    // The seal is unchanged: the new wording approves only through the password ceremony, bound to its digest.
    const edited = await (await fetch(url("/t/t-edit"), { headers: { cookie } })).text();
    expect(edited).toContain('<p class="approval-you-check" data-approval-you-check>You’ll check: Negative and zero payouts are refused; The refusal reads plainly</p>');
    const nonce = /name="nonce" value="([0-9a-f]+)"/.exec(edited)?.[1] ?? "";
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(edited)?.[1] ?? "";
    expect(digest).toBe(after.digest);
    const approved = await fetch(url("/t/t-edit/approve"), { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf: csrfOf(edited), nonce, digest, token: approverToken }), redirect: "manual" });
    expect(approved.status).toBe(303);
    expect(store.getScope("t-edit")).toMatchObject({ approvedDigest: after.digest, approvedBy: "alex" });
  });

  test("Edit plan in place keeps what it doesn't show: a stale draft stays stale, permissions never change, the cap round-trips exactly", async () => {
    const cookie = await login();
    const home = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    await fetch(url("/projects/open"), { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf: csrfOf(home), path: repoA, return: "/" }), redirect: "manual" });
    store.createTask({ id: "t-keep", title: "keep the terms" }, T0);
    store.placeTask(store.refFor("built-in", "t-keep").id, repoA);
    const acceptance = [{ id: "c1", statement: "Negative payouts are refused.", how: null, evidence: ["check" as const] }];
    propose(store, { taskId: "t-keep", goal: "guard the payout path", acceptance, now: T0 });
    const editorOf = async () => {
      const page = await (await fetch(url("/t/t-keep"), { headers: { cookie } })).text();
      const form = page.slice(page.indexOf('<form method="post" action="/t/t-keep/scope" id="plan-editor-form"'));
      return { page, hidden: [...form.slice(0, form.indexOf("</form>")).matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(one => [one[1]!, one[2]!] as [string, string]) };
    };
    const save = (hidden: [string, string][], goal: string) => fetch(url("/t/t-keep/scope"), { method: "POST", headers: { cookie },
      body: new URLSearchParams([...hidden, ["goal", goal], ["touches", ""], ["not", ""], ["requirement", "Negative payouts are refused."], ["requirement-new", ""]]), redirect: "manual" });

    // No limit stays no limit; an odd cap comes back to the millionth.
    const open = await editorOf();
    expect(open.page).toContain(" · no attempt limit</p>");
    expect(Object.fromEntries(open.hidden)["budget-microusd"]).toBe("none");
    expect((await save(open.hidden, "guard the payout path, plainly")).status).toBe(303);
    expect(store.getScope("t-keep")?.budgetMicrousd).toBeNull();
    propose(store, { taskId: "t-keep", goal: "guard the payout path", acceptance, budgetMicrousd: 1_234_567, now: T0 });
    const capped = await editorOf();
    expect(Object.fromEntries(capped.hidden)["budget-microusd"]).toBe("1234567");
    expect((await save(capped.hidden, "guard the payout path, again")).status).toBe(303);
    expect(store.getScope("t-keep")?.budgetMicrousd).toBe(1_234_567);

    // A draft edited from an older version is refused; it reopens bound to
    // the version now on file, so saving it again, having read why, succeeds.
    const stale = await editorOf();
    propose(store, { taskId: "t-keep", goal: "someone else's wording", acceptance, now: T0 });
    const current = store.getScope("t-keep")!.digest;
    const refused = await save(stale.hidden, "my wording");
    expect(refused.status).toBe(409);
    const reopened = await refused.text();
    const retried = /<form method="post" action="\/t\/t-keep\/scope" id="plan-editor-form"[^]*?<\/form>/.exec(reopened)?.[0] ?? "";
    const again = [...retried.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(one => [one[1]!, one[2]!] as [string, string]);
    expect(Object.fromEntries(again)["sawDigest"]).toBe(current);
    expect(Object.fromEntries(again)["sawDigest"]).not.toBe(Object.fromEntries(stale.hidden)["sawDigest"]);
    expect(store.getScope("t-keep")).toMatchObject({ goal: "someone else's wording", digest: current });
    expect((await save(again, "my wording")).status).toBe(303);
    expect(store.getScope("t-keep")?.goal).toBe("my wording");

    // A legacy accept-edits plan: saving in place never raises what the agent may do.
    const resolved = store.getScope("t-keep")!.profile!;
    if (resolved.provider !== "claude") throw new Error("expected a claude profile");
    propose(store, { taskId: "t-keep", goal: "guard the payout path", acceptance, now: T0, profile: { ...resolved, permissionArgv: "acceptEdits" } });
    const legacy = store.getScope("t-keep")!;
    expect(legacy.profile).toMatchObject({ permissionArgv: "acceptEdits" });
    const kept = await editorOf();
    expect(kept.page).toContain("You’re allowing: file edits only; commands are refused");
    const raised = await save(kept.hidden, "guard the payout path, edited");
    expect(raised.status).toBe(409);
    expect(await raised.text()).toContain("Not saved: this would change what the agent may do.");
    expect(store.getScope("t-keep")).toMatchObject({ goal: "guard the payout path", digest: legacy.digest, profile: { permissionArgv: "acceptEdits" } });
  });

  test("a sensitive page renders the switcher inert: the name and the one link, no forms in the chrome", async () => {
    const cookie = await login();
    const home = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    await fetch(url("/projects/open"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf: csrfOf(home), path: repoA, return: "/" }),
      redirect: "manual",
    });
    // A task whose scope awaits its password ceremony.
    store.createTask({ id: "t-sign", title: "needs the yes" }, T0);
    store.placeTask(store.refFor("built-in", "t-sign").id, repoA);
    store.saveScope({
      taskId: "t-sign", goal: "the goal", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "", approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const page = await (await fetch(url("/t/t-sign"), { headers: { cookie } })).text();
    expect(SENSITIVE_INPUT.test(page)).toBe(true);
    expect(page).not.toContain('<div class="switcher-menu"');
    expect(page).not.toContain('action="/projects/open"');
  });
});

describe("the reduction pass (Laws of UX): five always-visible rows and two accordion groups, five tabs, one accent in two places", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const T0 = new Date("2026-08-11T00:00:00.000Z");
  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-reduction-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("every retired destination still answers: the queue redirects to the board's order view; done, review, and activity are views of builds", async () => {
    const cookie = await login();
    const queue = await fetch(url("/queue"), { headers: { cookie }, redirect: "manual" });
    expect(queue.status).toBe(303);
    expect(queue.headers.get("location")).toBe("/board?view=order");
    // The fragment the order view polls is still served.
    expect((await fetch(url("/queue?fragment=1"), { headers: { cookie } })).status).toBe(200);
    for (const path of ["/done", "/review", "/activity", "/runs", "/workbench", "/tasks", "/fleet", "/projects", "/menu", "/board?view=order"]) {
      expect((await fetch(url(path), { headers: { cookie } })).status).toBe(200);
    }
  });
});
