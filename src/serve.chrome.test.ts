/**
 * The console server: the chrome layer — sensitivity, motion, editor links,
 * the phone shell, the project switcher and the reduction pass.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { acquire } from "./claim.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { createDecisionServer, SENSITIVE_INPUT } from "./serve.js";
import { presented, T0, stylesOf, workspaceOf } from "../test/serve-kit.js";

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

  test("the workspace is console-wide: /done has its navigation and search, and a nonce'd script", async () => {
    const cookie = await login();
    const response = await fetch(url("/done"), { headers: { cookie } });
    const html = await response.text();
    const workspace = workspaceOf(html);
    expect(workspace.path).toBe("/done");
    expect(workspace.navigation.map(one => one.label)).toEqual(expect.arrayContaining(["Chat", "Tasks", "Flows", "Projects", "Settings"]));
    // The workspace's search (⌘K) stands in for the console palette and its overlay.
    expect(html).not.toContain('id="palette-index"');
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'nonce-/);
    expect(csp).toContain("connect-src 'self'"); // the workspace beat fetches
    // Not a live page: nothing reloads what someone was typing.
    expect(html).not.toContain('http-equiv="refresh"');
    expect(workspace.refreshSeconds).toBeUndefined();
  });

  test("settings is secondary: the first row of the settings group, only where the console offers it, and never a primary destination", async () => {
    const cookie = await login();
    const html = await (await fetch(url("/done"), { headers: { cookie } })).text();
    const side = /<aside class="side">(.*?)<\/aside>/s.exec(html)?.[1] ?? "";
    const primary = /<nav>(.*?)<\/nav>/s.exec(side)?.[1] ?? "";
    expect(primary).not.toContain("/settings");
    expect(side).not.toContain('class="nav-settings"');
    const tools = /<details class="nav-group" data-group="tools"[^>]*>(.*?)<\/details>/s.exec(side)?.[1] ?? "";
    const settings = /<details class="nav-group" data-group="settings"[^>]*>(.*?)<\/details>/s.exec(side)?.[1] ?? "";
    expect(tools).not.toContain("/settings");
    expect(settings).toMatch(/^<summary>Settings<svg.*?<nav class="nav-group-items"><a href="\/settings" aria-label="Settings" title="Settings">Settings<\/a>/s);
    // The phone's overflow drawer mirrors it — its own headed section, last.
    const menu = await (await fetch(url("/menu"), { headers: { cookie } })).text();
    expect(menu).toContain('<h2 class="menu-group-label">Settings</h2>');
    expect(menu).toContain('<a class="menu-row" href="/settings">');
    // And the phone's tab bar never carries it: settings is a header action.
    const tabbar = /<nav class="tabbar">(.*?)<\/nav>/s.exec(html)?.[1] ?? "";
    expect(tabbar).not.toContain("/settings");
    expect(html).toContain('<a class="mobile-more" href="/menu" aria-label="tools and settings"');
  });

  test("the active page's accordion group opens itself; the other stays collapsed", async () => {
    const cookie = await login();
    const groupsOf = async (path: string): Promise<{ workflows: string | undefined; admin: string | undefined }> => {
      const html = await (await fetch(url(path), { headers: { cookie } })).text();
      const side = /<aside class="side">(.*?)<\/aside>/s.exec(html)?.[1] ?? "";
      return {
        workflows: /<details class="nav-group" data-group="tools"([^>]*)>/.exec(side)?.[1],
        admin: /<details class="nav-group" data-group="settings"([^>]*)>/.exec(side)?.[1],
      };
    };
    // /workbench is a work-tools destination: its own group opens, settings stays shut.
    const onWorkbench = await groupsOf("/workbench");
    expect(onWorkbench.workflows).toBe(" open");
    expect(onWorkbench.admin).toBe("");
    // /fleet is a settings destination: the reverse.
    const onFleet = await groupsOf("/fleet");
    expect(onFleet.workflows).toBe("");
    expect(onFleet.admin).toBe(" open");
    // A page under Work itself (done is a builds view) opens no group.
    const onDone = await groupsOf("/work");
    expect(onDone.workflows).toBe("");
    expect(onDone.admin).toBe("");
  });

  test("the accordion is keyboard-operable and focusable like every other control, and its chevron dies under reduced motion", async () => {
    const cookie = await login();
    const home = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    // Native <details>/<summary> — the same accessible pattern the project
    // switcher already uses — carries keyboard open/close and a focus ring
    // for free; no bespoke widget or extra ARIA wiring was added for it.
    const css = await stylesOf(home, base);
    expect(css).toContain('button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }');
    expect(css).toContain('.nav-group > summary .chevron { width: .875rem; height: .875rem; flex: none; transition: transform .15s; }');
    // The rotation is real motion, so it dies under prefers-reduced-motion —
    // universally, since the UI polish pass (2026-09-13): every animation
    // and transition, not a hand-kept list of selectors.
    expect(css).toContain('@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after { animation: none !important; transition: none !important; }');
  });

  test("the board keeps its poller privileges: connect-src, the noscript opt-out, and swap preservation", async () => {
    const cookie = await login();
    const response = await fetch(url("/board"), { headers: { cookie } });
    const html = await response.text();
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'nonce-/);
    expect(csp).toContain("connect-src 'self'");
    // Inside the workspace its own poller swaps the board; nothing reloads the page.
    expect(workspaceOf(html).path).toBe("/board");
    expect(html).not.toContain('http-equiv="refresh"');
    // The swap gives back what it took: focus without re-scroll, the
    // centered lane, each lane's place.
    expect(html).toContain("preventScroll");
    expect(html).toContain("lane-[a-z]+");
    // …and each lane's fold (board pass): a section the reader closed
    // stays closed through the swap, one they opened stays open.
    expect(html).toContain('data.fold[k]=d.open');
    expect(html).toContain('if(data.fold[k])d.setAttribute("open","");else d.removeAttribute("open")');
    // The stylesheet ships the motion contracts and the phone's stacked lanes.
    const css = await stylesOf(html, base);
    expect(css).toContain("@view-transition { navigation: auto; }");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain(".board { display: flex; flex-direction: column;");
    expect(css).toContain("--brand:");
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

  test("settings lists each worker with its capacity and the tasks it is running", async () => {
    const now = new Date();
    const busy = register(store, { name: "mac-mini", host: "here", capacity: 3, repos: ["/repo/main"], now });
    register(store, { name: "spare", host: "there", capacity: 1, repos: ["/repo/main"], now });
    store.createTask({ id: "t-live", title: "Fix the checkout total" }, now);
    const ref = store.refFor("built-in", "t-live").id;
    store.placeTask(ref, "/repo/main");
    expect(acquire(store, ref, "mac-mini", { token: busy.token, now, ttlMs: 10 * 60_000, newLeaseId: () => "lease-live" })).toMatchObject({ ok: true });
    const cookie = await login();
    const html = await (await fetch(url("/settings"), { headers: { cookie } })).text();
    const view = workspaceOf(html).view as import("./browser-workspace.js").BrowserSettingsView;
    expect(view.workers).toEqual([
      { name: "mac-mini", tone: "ok", state: "Connected", capacity: 3, busy: 1, running: [{ taskId: "t-live", title: "Fix the checkout total", href: "/t/t-live", project: "main" }] },
      { name: "spare", tone: "ok", state: "Connected", capacity: 1, busy: 0, running: [] },
    ]);
    expect(html).toContain("1 of 3 running");
    expect(html).toContain("Nothing running.");
    expect(html).toContain("runner capacity &lt;name&gt; &lt;n&gt;");
    // A retired worker is not listed.
    store.retireRunner("spare", new Date());
    const after = workspaceOf(await (await fetch(url("/settings"), { headers: { cookie } })).text()).view as import("./browser-workspace.js").BrowserSettingsView;
    expect(after.workers?.map(one => one.name)).toEqual(["mac-mini"]);
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
    expect(pending).toContain('class="sticky-actions"');
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
    expect(approveForm).toContain('<button type="submit" form="plan-editor-form">Save plan</button>');
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

  test("a decision's option-per-card forms are never sticky-wrapped", async () => {
    store.createTask({ id: "t-q", title: "asked" }, T0);
    const ref = store.refFor("built-in", "t-q").id;
    const run = store.startRun({ taskRef: ref, leaseId: "l1", runner: "b", branch: "br", worktree: "/w", now: T0, ...presented(store, ref, "builder") });
    store.saveDecision({
      run, urgency: "blocking", recap: "Two ways.", question: "Which way?",
      options: [
        { id: "a", label: "One", consequence: "x", reversible: true },
        { id: "b", label: "Two", consequence: "y", reversible: true },
      ],
      recommendation: "a",
    }, T0);
    const cookie = await login();
    const html = await (await fetch(url("/d/1"), { headers: { cookie } })).text();
    expect(html).toContain("Which way?");
    expect(html).not.toContain('class="sticky-actions"');
  });

  test("the one-time worker token answer carries no script of any kind", async () => {
    const cookie = await login();
    const fleet = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(fleet)?.[1] as string;
    const response = await fetch(url("/fleet/runner/register"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, name: "builder-9", capacity: "1", token: approverToken }),
    });
    const html = await response.text();
    expect(html).toContain("is registered");
    expect(html).not.toContain("<script");
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

  test("the console palette (a page read with a token) is cached between renders, invalidated by an accepted mutation, and escaped", async () => {
    store.createTask({ id: "t-x", title: 'sharp <b>title</b> & "quotes"' }, T0);
    const real = store.paletteTasks.bind(store);
    let calls = 0;
    (store as { paletteTasks: typeof store.paletteTasks }).paletteTasks = (...args: Parameters<typeof store.paletteTasks>) => {
      calls += 1;
      return real(...args);
    };
    const cookie = await login();
    const bearer = { authorization: `Bearer alex:${approverToken}` };
    const first = await (await fetch(url("/done"), { headers: bearer })).text();
    const tasks = await (await fetch(url("/tasks"), { headers: { cookie } })).text();
    expect(calls).toBe(1);

    // Escaping: the raw HTML never spells a closing script tag; parsing
    // restores the title exactly.
    const tag = /<script type="application\/json" id="palette-index">(.*?)<\/script>/s.exec(first);
    expect(tag?.[1]).toContain("\\u003c");
    expect(tag?.[1]).not.toContain("</script>");
    const parsed = JSON.parse(tag?.[1] ?? "[]") as { label: string }[];
    expect(parsed.some(one => one.label.includes('sharp <b>title</b> & "quotes"'))).toBe(true);

    // An accepted mutation invalidates at once.
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(tasks)?.[1] as string;
    expect(csrf).toBeTruthy();
    await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, title: "fresh work", repo: "/repo/main" }),
      redirect: "manual",
    });
    await (await fetch(url("/done"), { headers: bearer })).text();
    expect(calls).toBe(2);
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

    test("UI polish 2026-09-13 / package 3: a finished build leads with its result panel and diff; the machine facts fold under Build details", async () => {
      const cookie = await login();
      const html = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
      const details = html.indexOf('<details class="run-facts-details"><summary>Run record<span class="meta">builder-1 · claude · built</span></summary><div id="run-facts">');
      const panel = html.indexOf('class="card result-panel" id="result"');
      const diff = html.indexOf('<div class="diff-review" data-review-diff>');
      const review = html.indexOf('<section class="result-request" id="request-changes">');
      expect(panel).toBeGreaterThan(-1);
      expect(diff).toBeGreaterThan(panel);
      expect(review).toBeGreaterThan(diff);
      expect(details).toBeGreaterThan(review);
      // The annotation road is intact: the mode switch, the line pins, the form, no revision until a note exists.
      expect(html).toContain('<button type="button" data-diff-mode="annotate" aria-pressed="false">Annotate</button>');
      expect(html).toContain('id="comment-form"');
      expect(html).not.toContain(">Revise</button>");
      // No stamp region on a finished build: nothing polls the folded facts.
      expect(html).not.toContain('id="run-facts-stamp"');
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

    test("commenting lands back at the review card with the note field ready; plain loads stay quiet", async () => {
      const cookie = await login();
      const csrf = await csrfOf(cookie);
      const posted = await fetch(url(`/r/${runId}/comment`), {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ csrf, path: "src/a.ts", line: "3", note: "tighten this" }),
        redirect: "manual",
      });
      expect(posted.status).toBe(303);
      // Package 3: the receipt names the request token when the form
      // carried one (so the browser clears exactly that draft) and "1"
      // for a bare post; either way the reader lands on the form.
      expect(posted.headers.get("location")).toBe(`/r/${runId}?noted=1#request-changes`);
      const noted = await (await fetch(url(`/r/${runId}?noted=1`), { headers: { cookie } })).text();
      expect(noted).toContain('id="request-changes"');
      expect(noted).toMatch(/name="note"[^>]* autofocus/);
      const plain = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
      expect(plain).not.toMatch(/name="note"[^>]* autofocus/);
    });

    test("follow-up on build 1540: the annotation form advertises the server's own 4000-character limit, with helper text and a counter", async () => {
      const cookie = await login();
      const csrf = await csrfOf(cookie);
      const html = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
      // Advertised: maxlength is LIMITS.note (4000), never the old 500; the helper names it and the textarea points at the helper.
      expect(html).toContain('<textarea name="note" rows="2" maxlength="4000" placeholder="Describe the change…" aria-label="review comment" aria-describedby="comment-note-limit"></textarea><span class="meta diff-comment-limit" id="comment-note-limit">up to 4000 characters</span>');
      expect(html).not.toContain('maxlength="500" placeholder="Describe');
      // The counter rides the result panel's script and reads the textarea's own maxlength.
      expect(html).toContain("limit.textContent=noteBox.value.length===0?'up to '+noteBox.maxLength+' characters':noteBox.value.length+' of '+noteBox.maxLength+' characters'");
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

    test("the prefill button and its script ride the page exactly when the comment form does", async () => {
      const cookie = await login();
      const html = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
      expect(html).toContain('class="pick-file" data-path="src/a.ts"');
      expect(html).toContain('id="comment-form"');
      expect(html).toContain('data-review-diff');
      expect(html).toContain('class="diff-file" open');
      expect(html).toContain('class="diff-annotate pick-line" data-path="src/a.ts" data-line="2" data-side="old"');
      expect(html).toContain('aria-label="Annotate src/a.ts, old line 2"');
      expect(html).toContain('class="diff-annotate pick-line" data-path="src/a.ts" data-line="2" data-side="new"');
      expect(html).toContain('aria-label="Annotate src/a.ts, new line 2"');
      expect(html).toContain('data-diff-mode="view" aria-pressed="true"');
      expect(html).toContain('data-diff-mode="annotate" aria-pressed="false"');
      expect(html).toContain("closest('button.pick-file,button.pick-line')");
      expect(html).toContain("form.scrollIntoView({behavior:window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'})");
      // prefill alone earns no network: script-src yes, connect-src no
      const csp = (await fetch(url(`/r/${runId}`), { headers: { cookie } })).headers.get("content-security-policy") ?? "";
      expect(csp).toMatch(/script-src 'nonce-/);
      expect(csp).toContain("connect-src 'self'"); // v28: the chrome beat fetches
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

  test("the head declares the phone: safe-area viewport and standalone capability on both platforms", async () => {
    const cookie = await login();
    const html = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
    expect(html).toContain('<meta name="mobile-web-app-capable" content="yes">');
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');
  });

  test("the design system (v4): one palette in two schemes, a pinned theme, a theme color per scheme, icons on the sidebar's primary rows", async () => {
    const cookie = await login();
    const html = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    const css = await stylesOf(html, base);
    // Light is the root; dark follows the device unless a theme is pinned.
    const root = /:root \{\s*color-scheme: light;(.*?)\n  \}/s.exec(css)?.[1] ?? "";
    const dark = /:root\[data-theme="dark"\] \{\s*color-scheme: dark;(.*?)\n  \}/s.exec(css)?.[1] ?? "";
    expect(css).toContain(':root:not([data-theme="light"]) {');
    for (const token of ["--so-ground", "--so-paper", "--so-ink", "--so-muted", "--so-line", "--so-accent", "--so-on-accent", "--so-danger", "--so-success", "--so-warning", "--so-info"]) {
      expect(root).toContain(`${token}:`);
      expect(dark).toContain(`${token}:`);
    }
    // The console's names are views onto the palette, never a second ramp.
    for (const token of ["--background", "--foreground", "--card", "--muted", "--muted-foreground", "--border", "--input", "--brand", "--running", "--success", "--destructive", "--ring"]) {
      expect(root).toMatch(new RegExp(`${token}: var\\(--so-`));
    }
    expect(html).toContain('<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0b0b">');
    expect(html).toContain('<meta name="theme-color" media="(prefers-color-scheme: light)" content="#efefef">');
    // A pinned theme reaches the document before any script runs.
    const pinned = await (await fetch(url("/inbox"), { headers: { cookie: `${cookie}; so-theme=dark` } })).text();
    expect(pinned).toContain('<html lang="en" data-theme="dark">');
    expect(pinned).toContain('<meta name="theme-color" content="#0b0b0b">');
    // Sidebar primary rows carry a drawn icon; the foot's rows stay text.
    expect(html).toMatch(/<a href="\/work"[^>]*><span class="glyph"><svg/);
    expect(html).toMatch(/<a href="\/projects"[^>]*><span class="glyph"><svg/);
    expect(html).toMatch(/<a href="\/workbench" aria-label="Portfolio" title="Portfolio">Portfolio<\/a>/);
    // Section headers speak sans; status labels are quiet rounded rectangles,
    // while numeric counts retain the conventional pill silhouette.
    expect(css).toContain("color: var(--muted-foreground); margin: 2rem 0 .5rem; font-family: var(--font-sans);");
    expect(css).toContain("border: 1px solid var(--border); border-radius: .375rem;");
    expect(css).toContain(".count {");
    expect(css).toContain("border-radius: 9999px;");
    expect(css).not.toContain(".badge-running::before");
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

  test("the header pill names the scope: project with counts when one is open, 'all projects' on the portfolio", async () => {
    const cookie = await login();
    const home = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    const pill = /<details class="project-pill switcher"><summary>(.*?)<\/summary>/s.exec(home)?.[1] ?? "";
    expect(pill).toContain('<span class="name">main<svg');
    expect(pill).toMatch(/<span class="pill-status">.*needs you.*live.*queued.*<\/span>/s);
    const portfolio = await (await fetch(url("/workbench"), { headers: { cookie } })).text();
    const wide = /<details class="project-pill switcher"><summary>(.*?)<\/summary>/s.exec(portfolio)?.[1] ?? "";
    expect(wide).toContain('<span class="name">All projects<svg');
    expect(wide).not.toContain("pill-status");
  });

  test("queue cards carry drawn controls — a grip and a to-front arrow — never a glyph standing in for an icon", async () => {
    store.createTask({ id: "t-q", title: "queued work" }, T0);
    store.placeTask(store.refFor("built-in", "t-q").id, "/repo/main");
    const cookie = await login();
    const html = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    const card = /<div class="card queue-card" data-task="t-q".*?<\/div>/s.exec(html)?.[0] ?? "";
    expect(card).toContain('<span class="queue-handle" aria-hidden="true"><svg');
    expect(card).toContain('<button type="submit" class="icon-button" aria-label="move to the front"><svg');
    expect(card).not.toContain("≡");
    expect(card).not.toContain("▲");
    expect(card).not.toContain('style="cursor:grab');
    // The fleet's cards share the same grip.
    const fleet = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    expect(fleet).toContain('<span class="queue-handle" aria-hidden="true"><svg');
    expect(fleet).not.toContain("≡");
  });

  test("the one-at-a-time screen's 'not now' is a real control, beside its count", async () => {
    store.createTask({ id: "t-n", title: "asks a question" }, T0);
    const ref = store.refFor("built-in", "t-n").id;
    store.placeTask(ref, "/repo/main");
    const run = store.startRun({ taskRef: ref, leaseId: "lease-n", runner: "b1", branch: "standing-orders/t-n", worktree: "/pool/t-n", now: T0, ...presented(store, ref, "builder") });
    store.saveDecision(
      {
        run, urgency: "blocking", recap: "why it stopped", question: "Which way?",
        options: [{ id: "a", label: "A", consequence: "a", reversible: true }, { id: "b", label: "B", consequence: "b", reversible: true }],
        recommendation: "a",
      },
      T0,
    );
    const cookie = await login();
    const html = await (await fetch(url("/next"), { headers: { cookie } })).text();
    expect(html).toMatch(/<p class="meta next-pager"><span>[^<]*waiting on you<\/span><a class="skip" href="\/next\?skip=[^"]*">not now — next →<\/a><\/p>/);
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

  test("every served project is one form in the menu, each carrying the token and this screen as the return", async () => {
    const cookie = await login();
    const board = await (await fetch(url("/board?scope=all"), { headers: { cookie } })).text();
    const bar = board.slice(board.indexOf('<div class="scope-bar">'), board.indexOf("<main>"));
    expect(bar).toContain('<summary class="name">All projects<svg');
    expect(bar).toContain('<button type="submit" class="current" aria-current="true">All projects</button>');
    for (const repo of [repoA, repoB]) {
      expect(bar).toContain(`<form method="post" action="/projects/open"><input type="hidden" name="csrf" value="${csrfOf(board)}"><input type="hidden" name="return" value="/board?scope=all"><input type="hidden" name="path" value="${repo}"><button type="submit">${repo.split("/").pop()}</button></form>`);
    }
    // The phone pill carries the same menu and a direct management route;
    // the bottom bar stays focused on the five daily destinations.
    expect(board).toContain('<details class="project-pill switcher"><summary>');
    expect(board).toContain('<a class="manage" href="/projects">manage projects</a>');
    // The rail's row, the switcher's manage link, and the phone's Projects tab.
    expect((board.match(/href="\/projects"/g) ?? []).length).toBe(3);
    // The workspace's own project picker (the page's shell) offers the same projects.
    expect(workspaceOf(board).projects.map(one => one.path)).toEqual(expect.arrayContaining([repoA, repoB]));
  });

  test("chat is a projectless, all-project surface when several projects are served", async () => {
    for (const [id, repo] of [["chat-alpha", repoA], ["chat-beta", repoB]] as const) {
      const made = store.createConsoleTask({ id, title: id, repo, goal: `do ${id}`, acceptance: [{ id: "c1", statement: `${id} is done.`, evidence: ["manual-review"] }], filedVia: "test" }, T0);
      expect(made.ok).toBe(true);
    }
    const cookie = await login();
    const response = await fetch(url("/chat"), { headers: { cookie }, redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy") ?? "").toContain("connect-src 'self'");
    const before = await response.text();
    expect(before).toContain("<h1>Chat</h1>");
    expect(before).toMatch(/<span class="name">All projects/);
    expect(before).not.toContain("<h1>projects</h1>");

    const csrf = csrfOf(before);
    const minted = await fetch(url("/chat/mate/mint"), {
      method: "POST", headers: { cookie, origin: base }, redirect: "manual",
      body: new URLSearchParams({ csrf, "ceiling-usd": "5", token: approverToken }),
    });
    expect(minted.status).toBe(303);
    const html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(html).toContain('class="chat-workspace"');
    expect(html).toContain("projects in this conversation");
    expect(html).toContain("<strong>alpha</strong>");
    expect(html).toContain("<strong>beta</strong>");
    expect(html).toContain('data-waiting="2"');
    expect(html).toContain(`name="path" value="${repoA}"`);
    expect(html).toContain('name="return" value="/board"');

    const opened = await fetch(url("/projects/open"), {
      method: "POST", headers: { cookie, origin: base }, redirect: "manual",
      body: new URLSearchParams({ csrf, path: repoA, return: "/board" }),
    });
    expect(opened.status).toBe(303);
    expect(opened.headers.get("location")).toBe("/board");
  });

  test("a project card that is not open is itself the open form: the name returns home, and it carries the session's token", async () => {
    const cookie = await login();
    const projects = await (await fetch(url("/projects"), { headers: { cookie } })).text();
    const csrf = csrfOf(projects);
    const beta = repoB.split("/").pop() as string;
    expect(projects).toContain(
      `<form method="post" action="/projects/open" class="inline"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="path" value="${repoB}"><input type="hidden" name="return" value="/"><button type="submit" class="project-name">${beta}</button></form>`,
    );
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
    const queue = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    expect(queue).toContain('<summary class="name">alpha<svg');
    expect(queue).toContain(`<input type="hidden" name="path" value="${repoA}"><button type="submit" class="current" aria-current="true">alpha</button>`);
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

  test("the portfolio's workspace cards say one status word, count four ways, bar the same counts, and open the board in one tap", async () => {
    const cookie = await login();
    store.createTask({ id: "t-a", title: "alpha needs a scope" }, T0);
    store.placeTask(store.refFor("built-in", "t-a").id, repoA);
    const portfolio = await (await fetch(url("/workbench"), { headers: { cookie } })).text();
    const card = /<div class="workspace-card hot">.*?<div class="workspace-bar" aria-hidden="true">.*?<\/div><\/div>/s.exec(portfolio)?.[0] ?? "";
    expect(card).toContain('<span class="workspace-name">alpha</span><span class="badge badge-open">Needs you</span>');
    expect(card).toContain(`<input type="hidden" name="path" value="${repoA}"><input type="hidden" name="return" value="/board"><button type="submit">Board →</button>`);
    expect(card).toContain('<span class="pulse-stat hot"><b>1</b> need you</span>');
    expect(card).toContain('<span class="seg attention" style="flex-grow:1"></span>');
    expect(card).not.toContain('class="seg building"');
    // Follow the tap: the board opens on that project.
    const board = await fetch(url("/projects/open"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf: csrfOf(portfolio), path: repoA, return: "/board" }),
      redirect: "manual",
    });
    expect(board.headers.get("location")).toBe("/board");
  });

  test("a scope waiting for approval shows its plan open as plain rows, one Approve & start, and the rest in one Details fold", async () => {
    const cookie = await login();
    const home = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    await fetch(url("/projects/open"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf: csrfOf(home), path: repoA, return: "/" }),
      redirect: "manual",
    });
    store.createTask({ id: "t-yes", title: "needs the yes" }, T0);
    store.placeTask(store.refFor("built-in", "t-yes").id, repoA);
    store.saveScope({
      taskId: "t-yes", goal: "the goal", outOfScope: "not that", touches: ["src/a.ts"], acceptance: [],
      proposedAt: T0.toISOString(), digest: "", approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const page = await (await fetch(url("/t/t-yes"), { headers: { cookie } })).text();
    const ceremony = page.indexOf('<form method="post" action="/t/t-yes/approve" class="approve-form approval-sheet" id="approve" data-sticky>');
    const title = page.indexOf('<h1 class="task-main-title">needs the yes</h1>');
    expect(title).toBeGreaterThan(0);
    const bar = page.indexOf('<div class="acts-bar">');
    const layout = page.indexOf('<div class="task-layout">');
    expect(ceremony).toBeGreaterThan(title);
    expect(bar).toBeGreaterThan(ceremony);
    expect(layout).toBeGreaterThan(bar);
    expect(page).not.toContain('ready to run · approve');
    // The plan is open in its own section: no opener, no "approve exactly this".
    expect(page).toContain('<section class="task-plan-review" aria-label="Approve the plan"><form method="post" action="/t/t-yes/approve"');
    expect(page).not.toContain('<span class="button-link">Approve plan</span></summary>');
    expect(page).not.toContain("Approve exactly this:");
    // Plain rows, then who builds, then the one act, its after-line and the secondary acts; Details last.
    const rows = page.indexOf('<dl class="approval-rows">');
    const confirm = page.indexOf('<div class="approval-act" id="approval-confirm">');
    const details = page.indexOf('<details class="approval-details"><summary>Plan details</summary>');
    expect(rows).toBeGreaterThan(ceremony);
    expect(confirm).toBeGreaterThan(rows);
    expect(details).toBeGreaterThan(confirm);
    expect(page.slice(ceremony, page.indexOf("</form>", ceremony)).match(/<button type="submit"(?! form=)/g)).toHaveLength(1);
    expect(page).toContain('<button type="submit" data-primary-action>Approve & start</button></div><p class="approval-after">An agent starts in its own branch. You&#39;ll hear when it&#39;s ready to review.</p>'.replace(/&#39;/g, "'"));
    // Edit plan opens the rows for editing in place, saved through the scope's own route.
    expect(page).toContain('<div class="approval-secondary"><details class="approval-edit" id="plan-editor"><summary class="approval-link"><span class="approval-edit-open">Edit plan</span><span class="approval-edit-close">Cancel</span></summary>');
    expect(page).toContain('</details><a class="approval-link" href="/work">Not now</a></div>');
    expect(page).toContain('<form method="post" action="/t/t-yes/scope" id="plan-editor-form" class="approval-editor-form">');
    // What the yes allows sits right above it, and the password says why it is asked.
    expect(page).toContain('<p class="approval-allowing" data-approval-allowing>You’re allowing: ');
    expect(page.indexOf("data-approval-allowing")).toBeLessThan(confirm);
    expect(page).toContain('<p class="approval-password-note" id="approval-password-note">Your password signs this approval.</p>');
    expect(page.slice(rows, confirm)).toContain('<div class="approval-row"><dt>Goal</dt><dd><p class="approval-goal">the goal</p></dd></div>');
    expect(page.slice(rows, confirm)).toContain('<ul class="approval-paths"><li><span class="mono">src/a.ts</span></li></ul>');
    expect(page.slice(rows, confirm)).toContain("<dt>Won’t touch</dt><dd><p>not that</p></dd>");
    // No hashes in the main view: the seal is in Details.
    expect(page.slice(ceremony, details)).not.toContain('class="seal');
    expect(page.slice(details, page.indexOf("</form>", details))).toContain("<h3>Seal</h3>");
    // The recipe road rides with the scope section, off the title-to-action path.
    expect(page.indexOf("Reuse this scope as a recipe")).toBeGreaterThan(page.indexOf('<details class="section" id="scope"'));
    // Both views stay one tap apart.
    expect(page).toContain('<a href="/t/t-yes" class="active" aria-current="page">Overview</a><a href="/chat?task=t-yes">Ask</a>');
    expect(page).toContain('name="username" autocomplete="username" class="visually-hidden"');
    expect(page).toContain('<details class="section" id="scope"><summary><h2>Scope</h2></summary>');
    // No other act wears primary while the ceremony leads; the old
    // "needs your approval" card is gone (the ceremony says it).
    expect(page.slice(bar, page.indexOf("</div>", bar))).not.toContain('class="primary"');
    expect(page).not.toContain("its scope needs your approval");
    // The scope section still holds the goal card and the edit road, not the ceremony.
    // (The section holds nested details — the agents card's closed
    // reasons — so it ends at the NEXT section, not the first `</details>`.)
    const scopeStart = page.indexOf('<details class="section" id="scope"');
    const nextSection = page.indexOf('<details class="section"', scopeStart + 1);
    const scopeSection = page.slice(scopeStart, nextSection === -1 ? page.length : nextSection);
    expect(scopeSection).not.toContain('action="/t/t-yes/approve"');
    expect(scopeSection).toContain("Edit the scope");

    // A scope the store could not resolve to a routing gets the fix road,
    // never a password it cannot use.
    store.setPhaseConfig("installation", "build", "claude", null, "test", T0);
    store.createTask({ id: "t-fix", title: "cannot be approved yet" }, T0);
    store.placeTask(store.refFor("built-in", "t-fix").id, repoA);
    store.saveScope({
      taskId: "t-fix", goal: "the goal", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "", approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const fix = await (await fetch(url("/t/t-fix"), { headers: { cookie } })).text();
    if (fix.includes("filed but unapprovable")) {
      expect(fix).toContain('<div class="card approve-form" id="approve"><p><strong>This task is waiting on you: its scope cannot be approved yet.</strong></p>');
      expect(fix).toContain('<a class="button-link" href="#scope">edit the scope to fix it →</a>');
      expect(fix).not.toContain('action="/t/t-fix/approve"');
    }
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
    // Edit plan starts folded; arriving to edit (chat's Edit plan) opens it.
    expect(page).toContain('<details class="approval-edit" id="plan-editor"><summary');
    expect(await (await fetch(url("/t/t-edit?edit=plan"), { headers: { cookie } })).text()).toContain('<details class="approval-edit" id="plan-editor" open><summary');
    // No written steps on this plan, so no steps link.
    expect(page).not.toContain(">Edit steps</a>");
    // The plain consent line, the password's reason, and the in-place editor.
    expect(page).toContain("You’re allowing: file edits and routine commands; anything risky stops · up to $1.50 per attempt</p>");
    expect(page).not.toContain("data-approval-you-check");
    expect(page).toContain("Your password signs this approval.");
    const editor = page.slice(page.indexOf('<details class="approval-edit" id="plan-editor">'), page.indexOf('<details class="approval-details">'));
    expect(editor).toContain('<textarea name="goal" rows="3" form="plan-editor-form">guard the payout path</textarea>');
    expect(editor).toContain('<textarea name="touches" rows="2" form="plan-editor-form">src/payout.ts</textarea>');
    expect(editor).toContain('<textarea name="not" rows="2" form="plan-editor-form">billing</textarea>');
    expect(editor).toContain('<input type="text" name="requirement" value="Negative payouts are refused." aria-label="Requirement 1" form="plan-editor-form">');
    expect(editor).not.toContain("unit test it");
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
    expect(refusedPage).toContain('<details class="approval-edit" id="plan-editor" open>');
    expect(refusedPage).toContain('<p class="problem" role="alert">Not saved: add at least one requirement under Done when.</p>');
    expect(refusedPage).toContain('<textarea name="goal" rows="3" form="plan-editor-form">guard it harder</textarea>');
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
    expect(reopened).toContain('<details class="approval-edit" id="plan-editor" open>');
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
    expect(page).toContain('<div class="scope-bar"><span class="name">alpha</span>');
    expect(page).toContain('<a class="project-pill" href="/projects"><span class="name">alpha</span>');
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

  /** One parked decision: the inbox has something that waits. */
  const parkOne = (): void => {
    store.createTask({ id: "t-ask", title: "asks a question" }, T0);
    const ref = store.refFor("built-in", "t-ask").id;
    store.placeTask(ref, "/repo/main");
    const run = store.startRun({ taskRef: ref, leaseId: "lease-ask", runner: "b1", branch: "standing-orders/t-ask", worktree: "/pool/t-ask", now: T0, ...presented(store, ref, "builder") });
    store.saveDecision(
      {
        run, urgency: "blocking", recap: "why it stopped", question: "Which way?",
        options: [{ id: "a", label: "A", consequence: "a", reversible: true }, { id: "b", label: "B", consequence: "b", reversible: true }],
        recommendation: "a",
      },
      T0,
    );
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

  test("the rail is Chat · Tasks · Flows · Projects and two collapsed accordion groups (work tools, settings); the tab bar carries the same three; the queue and the switch link are gone from chrome", async () => {
    parkOne();
    const cookie = await login();
    // The console chrome beneath the workspace (its fallback). Its collapse toggle and group
    // script ride the console's chrome script, which a browser no longer runs: the workspace's
    // own sidebar stands in for them.
    const home = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    const side = /<aside class="side">(.*?)<\/aside>/s.exec(home)?.[1] ?? "";
    const primary = /<nav>(.*?)<\/nav>/s.exec(side)?.[1] ?? "";
    // Workspace package 1 (plus Flows): four primary destinations, nothing else.
    expect([...primary.matchAll(/<a href="([^"]+)"/g)].map(m => m[1])).toEqual(["/chat", "/work", "/flows", "/projects"]);
    // The count rides the Work row (the inbox lives under it); every
    // primary row wears an icon; the inbox page lights Work.
    // It says which projects it counts, aloud and on hover.
    expect(primary).toMatch(/<a href="\/work" aria-label="Tasks, 1 needs you in main" title="Tasks" class="active" aria-current="page" data-waiting="1"><span class="glyph"><svg.*?<span aria-label="1 needs you in main" title="1 needs you in main" class="count badge badge-open">1<\/span><\/a>/s);
    expect((primary.match(/<span class="glyph">/g) ?? []).length).toBe(4);

    // Both groups collapsed by default: neither carries the inbox's group open.
    const tools = /<details class="nav-group" data-group="tools"([^>]*)>(.*?)<\/details>/s.exec(side);
    const settings = /<details class="nav-group" data-group="settings"([^>]*)>(.*?)<\/details>/s.exec(side);
    expect(tools?.[1]).toBe(" open");
    expect(settings?.[1]).toBe("");
    expect(tools?.[2]).toContain("<summary>Work tools");
    expect(settings?.[2]).toContain("<summary>Settings");
    const toolRows = /<nav class="nav-group-items">(.*?)<\/nav>/s.exec(tools?.[2] ?? "")?.[1] ?? "";
    const settingsRows = /<nav class="nav-group-items">(.*?)<\/nav>/s.exec(settings?.[2] ?? "")?.[1] ?? "";
    expect([...toolRows.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(m => `${m[2]} ${m[1]}`)).toEqual([
      "Coding sessions /code",
      "Inbox /inbox",
      "Board /board",
      "Task list /tasks",
      "Recipes /recipes",
      "Routines /routines",
      "Portfolio /workbench",
      "Action ledger /ledger",
      "Spend /spend",
    ]);
    // Settings is the group's first row only where the console offers it
    // Learning is available even without a telegram token file.
    expect([...settingsRows.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(m => `${m[2]} ${m[1]}`)).toEqual([
      "Settings /settings",
      "Fleet /fleet",
      "Requirements /caps",
      "People /people",
      "Operating mode /mode",
      "System /system",
    ]);
    // The group rows stay text, the way Linear's does — only the rail's
    // primary rows and the chevrons wear a drawn icon.
    expect(toolRows).not.toContain("<svg");
    expect(settingsRows).not.toContain("<svg");
    expect(side).not.toContain('href="/queue"');
    expect(side).not.toContain('class="nav-settings"');
    expect(home).not.toContain("switch project");

    const tabbar = /<nav class="tabbar">(.*?)<\/nav>/s.exec(home)?.[1] ?? "";
    expect([...tabbar.matchAll(/<a href="([^"]+)"/g)].map(m => m[1])).toEqual(["/chat", "/work", "/flows", "/projects"]);
    // A phone tab says THAT something waits — a dot, never a number.
    expect(tabbar).toContain('<span class="dot-badge" role="img" aria-label="1 needs you in main"></span>');
    expect(tabbar).not.toContain("badge-open");
    expect(home).toContain('<a class="manage" href="/projects">manage projects</a>');
    // Tools and settings are a header action on the phone, never a tab.
    expect(home).toContain('<a class="mobile-more" href="/menu" aria-label="tools and settings" title="tools and settings">');

    // /menu mirrors the same two groups, nothing else.
    const menu = await (await fetch(url("/menu"), { headers: { cookie } })).text();
    expect(menu).toContain('<h2 class="menu-group-label">Work tools</h2>');
    expect(menu).toContain('<h2 class="menu-group-label">Settings</h2>');
    const rows = [...menu.matchAll(/<a class="menu-row" href="([^"]+)">/g)].map(m => m[1]);
    expect(rows).toEqual(["/code", "/inbox", "/board", "/tasks", "/recipes", "/routines", "/workbench", "/ledger", "/spend", "/settings", "/fleet", "/caps", "/people", "/mode", "/system"]);
  });

  test("every retired destination still answers: the queue redirects to the board's order view; done, review, and activity are views of builds", async () => {
    const cookie = await login();
    const queue = await fetch(url("/queue"), { headers: { cookie }, redirect: "manual" });
    expect(queue.status).toBe(303);
    expect(queue.headers.get("location")).toBe("/board?view=order");
    // The fragment the order view polls is still served.
    expect((await fetch(url("/queue?fragment=1"), { headers: { cookie } })).status).toBe(200);
    for (const [path, current] of [["/done", "done"], ["/review", "review"], ["/activity", "activity"], ["/runs", "builds"]] as const) {
      const html = await (await fetch(url(path), { headers: { cookie } })).text();
      // Every builds view lights the Work destination (workspace package 1).
      expect(html).toContain('<a href="/work" aria-label="Tasks" title="Tasks" class="active" aria-current="page"');
      const strip = /<p class="meta board-view">(.*?)<\/p>/s.exec(html)?.[1] ?? "";
      if (current === "review") {
        expect(strip).toBe(""); // Work tools retain these routes; review has one focused result view.
        continue;
      }
      expect(strip).toContain(`<strong>${current}</strong>`);
      for (const other of ["builds", "done", "review", "activity"].filter(one => one !== current)) {
        expect(strip).toContain(`>${other}</a>`);
      }
    }
    for (const path of ["/workbench", "/tasks", "/fleet", "/projects", "/menu", "/board?view=order"]) {
      expect((await fetch(url(path), { headers: { cookie } })).status).toBe(200);
    }
    const order = await (await fetch(url("/board?view=order"), { headers: { cookie } })).text();
    expect(order).toContain('<a href="/work" aria-label="Tasks" title="Tasks" class="active" aria-current="page"');
    expect(order).toContain('<a href="/board" aria-label="Board" title="Board" class="active">');
  });

  test("every count is a road: the header's counts, and a project card's name and chips, open what they count", async () => {
    parkOne();
    const cookie = await login();
    const home = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    // The needs-you count opens Work's Needs-you view (workspace package 1).
    expect(home).toContain('<span class="scope-status"><a class="hot" href="/work?view=needs-you">1 needs you</a><a href="/runs">');
    expect(home).toMatch(/<a href="\/board\?view=order">\d+ queued<\/a><\/span>/);
    // The phone pill keeps plain text inside its summary — the pill is the switcher.
    const pill = /<details class="project-pill switcher"><summary>(.*?)<\/summary>/s.exec(home)?.[1] ?? "";
    expect(pill).toContain('<span class="hot">1 needs you</span>');
    expect(pill).not.toContain("<a ");
    const projects = await (await fetch(url("/projects"), { headers: { cookie } })).text();
    const start = projects.indexOf('<div class="card project-card">');
    expect(start).toBeGreaterThan(0);
    const card = projects.slice(start, start + 1500);
    expect(card).toContain('<a class="project-name" href="/"><strong>main</strong></a>');
    expect(card).toContain('<a class="badge badge-open" href="/">1 waiting on you</a>');
  });

  test("the signal colour (magenta, once amber) lives in exactly two kinds of place: the needs-you count and the act that resolves a screen — never a card, a frame, or a seal", async () => {
    parkOne();
    const cookie = await login();
    const home = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    // Same color assertions, now over the actual cacheable stylesheet.
    const css = (await stylesOf(home, base)).replace(/\/\*.*?\*\//gs, "");
    const amber = new Set<string>();
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if ((rule[2] as string).includes("var(--brand)")) amber.add((rule[1] as string).trim().replace(/\s+/g, " "));
    }
    expect([...amber].sort()).toEqual(
      [
        ".count.badge-open",
        ".approve-form button[type=submit], .approve-form .sticky-actions button[type=submit]",
        ".approve-form button[type=submit]:hover, .approve-form .sticky-actions button[type=submit]:hover",
        ".scope-status .hot",
        ".mobile-top .pill-status .hot",
        ".tabbar a .dot-badge",
        ".lane-attention h2::before",
        ".command-metric.attention .label::before",
        ".chat-project-stats span.hot, .chat-project-stats span.hot b",
        // The folded chat overview's needs-you count (UI polish 2026-09-13): a count, by the law.
        ".chat-fleet-context > summary .hot",
        ".workspace-stats .pulse-stat.hot b",
        ".workspace-bar .seg.attention",
      ].sort(),
    );
    // The card that waits is on the page, in the neutral border.
    expect(home).toContain('class="decide-card"');
    expect(css).toMatch(/\.decide-card \{\s*display: block; border: 1px solid var\(--border\);/);
    expect(css).toMatch(/\.approve-form \{ margin: \.75rem 0; \}/);
    expect(css).not.toContain(".lane-attention .lane-card {");
    expect(css).not.toContain(".workspace-card.hot {");
    expect(css).toMatch(/\.seal \{[^}]*border: 1px solid var\(--border\);[^}]*color: var\(--foreground\)/s);
  });
});
