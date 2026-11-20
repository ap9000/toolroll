import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { centralProfile, maybeRunConnectCommand } from "./connect-cli.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { openStore } from "./store.js";

const dirs: string[] = [];
const servers: http.Server[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()!;
    await new Promise<void>(resolve => s.close(() => resolve()));
  }
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("unexpected address");
  return `http://127.0.0.1:${addr.port}`;
}

describe("browser-assisted CLI pairing and multi-workspace profiles", () => {
  test("toolroll connect --browser pairs via fresh browser password step-up, delivers token once, and --list/--use manage profiles", async () => {
    const root = tempDir("so-pair-");
    const repo = join(root, "app");
    mkdirSync(repo, { recursive: true });
    const store = openStore(join(root, "state.db"));
    const now = new Date("2026-11-20T16:00:00Z");

    const alex = addApprover(store, "alex", now);
    if (!alex.ok) throw new Error("alex");

    const server = createDecisionServer({
      store,
      configDir: root,
      evidenceRoot: join(root, "evidence"),
      repos: [repo],
      clock: () => now,
      terminalHost: null,
    });
    const origin = await listen(server);

    // Browser headers on /api/connect/pair/start are refused (400).
    const badStart = await fetch(`${origin}/api/connect/pair/start`, { method: "POST", headers: { origin } });
    expect(badStart.status).toBe(400);

    // Sign into the browser console as alex (full password session).
    const loginRes = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "alex", token: alex.token }),
      redirect: "manual",
    });
    expect(loginRes.status).toBe(303);
    const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("=");

    const profileFile = join(root, "remote", "profiles.json");
    const lines: string[] = [];
    const errs: string[] = [];
    const ac = new AbortController();
    let browserErr: unknown = null;
    let browserFlow: Promise<void> | null = null;

    // Run `toolroll connect <origin> --browser --profile acme` while our test simulates browser confirmation.
    const connectPromise = maybeRunConnectCommand(
      ["connect", origin, "--browser", "--profile", "acme"],
      line => lines.push(line),
      {
        profileFile,
        pollIntervalMs: 15,
        signal: ac.signal,
        stderr: line => errs.push(line),
        openBrowser: url => {
          browserFlow = (async () => {
            try {
              // 1. Load confirmation page to get CSRF token.
              const pageRes = await fetch(url, { headers: { cookie } });
              expect(pageRes.status).toBe(200);
              const pageHtml = await pageRes.text();
              const csrf = /name="csrf" value="([^"]+)"/.exec(pageHtml)?.[1] ?? "";
              expect(csrf.length).toBeGreaterThan(0);
              // 2. Wrong password is refused (403) and does not approve pairing.
              const bad = await fetch(url, {
                method: "POST",
                headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ csrf, access: "act", password: "wrong-password" }),
              });
              expect(bad.status).toBe(403);
              // 3. Correct password approves pairing and mints a purpose='api' token.
              const good = await fetch(url, {
                method: "POST",
                headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ csrf, access: "act", password: alex.token }),
              });
              const goodBody = await good.text();
              expect(good.status, goodBody).toBe(200);
            } catch (err) {
              browserErr = err;
              ac.abort();
            }
          })();
        },
      },
    );

    const exit = await connectPromise;
    await browserFlow;
    if (browserErr !== null) throw browserErr;
    expect(exit).toBe(0);
    expect(lines.join("\n")).toContain(`Connected to ${origin} as alex.`);

    // Saved profile holds pinned workspace identity and an ordinary so_ API token.
    const saved = centralProfile({ profileFile }, "acme");
    expect(saved).not.toBeNull();
    expect(saved!.apiToken).toBe(true);
    expect(saved!.account).toBe("alex");
    expect(saved!.workspaceId).toBe(store.workspaceIdentity().id);
    expect(saved!.recoveryGeneration).toBe(store.workspaceIdentity().recoveryGeneration);

    // Save a second profile `staging` and verify `--list` never prints tokens and `--use` switches cleanly.
    const lines2: string[] = [];
    expect(await maybeRunConnectCommand(
      ["connect", origin, "--as", "alex", "--token-stdin", "--profile", "staging"],
      line => lines2.push(line),
      { profileFile, readStdin: async () => saved!.token, stderr: () => {} },
    )).toBe(0);

    const listed: string[] = [];
    expect(await maybeRunConnectCommand(["connect", "--list"], line => listed.push(line), { profileFile, stderr: () => {} })).toBe(0);
    const listText = listed.join("\n");
    expect(listText).toContain("acme");
    expect(listText).toContain("* staging");
    expect(listText).not.toContain(saved!.token);
    expect(listText).not.toContain("so_");

    const switched: string[] = [];
    expect(await maybeRunConnectCommand(["connect", "--use", "acme"], line => switched.push(line), { profileFile, stderr: () => {} })).toBe(0);
    expect(switched.join("\n")).toContain("Active profile switched to acme");
    expect(centralProfile({ profileFile })?.name).toBe("acme");
  });
});
