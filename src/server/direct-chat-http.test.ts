import { execFileSync } from "node:child_process";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDemoSandbox } from "../demo.js";
import type { CustodyIO, ProcessWitness, ProcRow } from "../flexible-custody.js";
import { declareNewInstallSolo } from "../install-mode.js";
import { addApprover } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { openStore, type Store } from "../store.js";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

const T0 = new Date("2026-10-27T12:00:00.000Z");

class FakeCustody implements CustodyIO {
  readonly platform: NodeJS.Platform = "darwin";
  readonly self = 1;
  readonly rows = new Map<number, ProcRow>();
  add(pid: number, pgid = pid, start = "s1764028800"): void {
    this.rows.set(pid, { pid, ppid: 1, pgid, uid: 501, start, zombie: false });
  }
  table(): ProcRow[] {
    return [...this.rows.values()];
  }
  namespaceOf(): string | null {
    return null;
  }
  holdersOf(): number[] {
    return [];
  }
  signal(targets: readonly ProcessWitness[]) {
    const sent: ProcessWitness[] = [];
    for (const t of targets) {
      const row = this.rows.get(t.pid);
      if (row && row.start === t.start) {
        this.rows.delete(t.pid);
        sent.push(t);
      }
    }
    return { sent, gone: [], mismatched: [], refused: [], unsupported: false, bestEffort: true };
  }
}

type TestWorld = {
  root: string;
  repo: string;
  store: Store;
  server: Server;
  origin: string;
  port: number;
  token: string;
  cookie: string;
  csrf: string;
  custody: FakeCustody;
  send: (path: string, method: string, headers?: Record<string, string>, body?: string) => Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>;
  post: (path: string, form: Record<string, string>, extraHeaders?: Record<string, string>) => Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>;
  close: () => Promise<void>;
};

async function openDirectChatWorld(): Promise<TestWorld> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dc-http-")));
  const repo = join(root, "payments-api");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  writeFileSync(join(repo, "README.md"), "# Payments\n");
  execFileSync("git", ["-C", repo, "add", "README.md"], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], { env: GIT_ENV });

  const configDir = join(root, "config");
  mkdirSync(configDir);
  const store = openStore(join(configDir, "state.db"));
  const op = addApprover(store, "alex", T0);
  if (!op.ok) throw new Error("addApprover failed");
  declareNewInstallSolo(store, "alex", T0);

  const custody = new FakeCustody();
  let nextPid = 8100;
  const server = createDecisionServer({
    store,
    evidenceRoot: join(root, "evidence"),
    repo,
    admittedRepos: () => [repo],
    configDir,
    directChatSeams: {
      stateRoot: join(root, "dc-state"),
      custody,
      bootId: () => "boot-http",
      locateBinary: () => "/fake/claude",
      spawnTurn: input => {
        mkdirSync(dirname(input.logPath), { recursive: true });
        writeFileSync(
          input.logPath,
          `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Working on it." }] } })}\n`,
          { mode: 0o600 },
        );
        const pid = nextPid++;
        custody.add(pid, pid, `start-${pid}`);
        return { pid, pgid: pid, startIdentity: `start-${pid}` };
      },
    },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  const send = (
    path: string,
    method: string,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, connection: "close", ...headers } },
        res => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", chunk => { text += chunk; });
          res.on("end", () => resolve({ status: res.statusCode!, body: text, headers: res.headers }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });

  const login = await send(
    "/login",
    "POST",
    { "content-type": "application/x-www-form-urlencoded" },
    new URLSearchParams({ name: "alex", token: op.token }).toString(),
  );
  if (login.status !== 303) throw new Error(`login failed: ${login.status}`);
  const cookie = login.headers["set-cookie"]!.map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
  const projectsPage = await send("/projects", "GET", { cookie });
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(projectsPage.body)![1]!;

  const post = (path: string, form: Record<string, string>, extraHeaders: Record<string, string> = {}) =>
    send(
      path,
      "POST",
      {
        cookie,
        origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
        ...extraHeaders,
      },
      new URLSearchParams({ csrf, ...form }).toString(),
    );

  return {
    root,
    repo,
    store,
    server,
    origin,
    port,
    token: op.token,
    cookie,
    csrf,
    custody,
    send,
    post,
    async close() {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("Direct Chat HTTP + SSE routes", () => {
  const worlds: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (worlds.length > 0) await worlds.pop()!.close();
  });

  test("enforces loopback-only (refuses forwarded proxy headers), bearer refusal, unadmitted repo, and team-mode refusal", async () => {
    const world = await openDirectChatWorld();
    worlds.push(world);

    // 1. Proxied / forwarded header is refused even with a valid owner cookie.
    const proxiedList = await world.send("/engine/direct-chats", "GET", {
      cookie: world.cookie,
      "x-forwarded-for": "100.64.0.1",
    });
    expect(proxiedList.status).toBe(403);
    expect(JSON.parse(proxiedList.body)).toMatchObject({ available: false });

    const proxiedStart = await world.post(
      "/engine/direct-chats",
      { project: world.repo, prompt: "hi", provider: "claude", request: "a".repeat(32) },
      { "x-forwarded-for": "100.64.0.1" },
    );
    expect(proxiedStart.status).toBe(403);
    expect(JSON.parse(proxiedStart.body)).toMatchObject({ ok: false });

    // 2. Bearer token is refused (cookie-only route rejects bearer auth and never admits it).
    const bearerList = await world.send("/engine/direct-chats", "GET", {
      authorization: "Bearer tr_fake_token",
    });
    expect(bearerList.status).not.toBe(200);
    expect([303, 401, 403]).toContain(bearerList.status);

    // 3. Unadmitted repository path is refused with 404.
    const badRepo = await world.post("/engine/direct-chats", {
      project: "/tmp/not-an-admitted-repo",
      prompt: "hi",
      provider: "claude",
      request: "b".repeat(32),
    });
    expect(badRepo.status).toBe(404);
    expect(JSON.parse(badRepo.body)).toMatchObject({ ok: false });

    // 4. Adding a second approver switches install to team mode -> Direct Chat refuses.
    const second = addApprover(world.store, "jordan", T0, { name: "alex", token: world.token });
    expect(second.ok).toBe(true);
    const teamList = await world.send("/engine/direct-chats", "GET", { cookie: world.cookie });
    expect(teamList.status).toBe(403);
    expect(JSON.parse(teamList.body)).toMatchObject({ available: false });
    const teamStart = await world.post("/engine/direct-chats", {
      project: world.repo,
      prompt: "hi",
      provider: "claude",
      request: "c".repeat(32),
    });
    expect(teamStart.status).toBe(403);
    expect(JSON.parse(teamStart.body)).toMatchObject({ ok: false });
  });

  test("refuses demo mode", async () => {
    const made = createDemoSandbox(new Date());
    const server = createDecisionServer({
      store: made.store,
      evidenceRoot: made.evidenceRoot,
      clock: () => new Date(),
      repos: made.seed.repos,
      demoLead: made.lead,
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    worlds.push({
      close: async () => {
        made.lead.stop();
        await new Promise<void>(resolve => server.close(() => resolve()));
        made.store.close();
        rmSync(made.sandbox, { recursive: true, force: true });
      },
    });

    const link = server.mintSignInLink(made.seed.login.name)!;
    const signed = await fetch(base + link, { redirect: "manual" });
    const cookie = signed.headers.getSetCookie().map(one => one.split(";")[0]).join("; ");
    const res = await fetch(`${base}/engine/direct-chats`, { headers: { cookie } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ available: false });
  });

  test("end-to-end loopback lifecycle: start, list, detail, SSE room, stop, switch model, follow-up, delete", async () => {
    const world = await openDirectChatWorld();
    worlds.push(world);

    // Start a new chat thread.
    const startedRes = await world.post("/engine/direct-chats", {
      project: "payments-api",
      prompt: "Summarize README",
      provider: "claude",
      model: "claude-sonnet-4-6",
      request: "d".repeat(32),
    });
    expect(startedRes.status).toBe(200);
    const started = JSON.parse(startedRes.body) as { ok: true; threadId: string; turnId: string; room: string };
    expect(started.ok).toBe(true);
    expect(started.room).toBe(`direct-chat:${started.threadId}`);

    // List threads returns the created thread with plain-English posture.
    const listRes = await world.send("/engine/direct-chats", "GET", { cookie: world.cookie });
    expect(listRes.status).toBe(200);
    const list = JSON.parse(listRes.body) as { available: boolean; threads: Array<{ id: string; posture: { summary: string } }> };
    expect(list.available).toBe(true);
    expect(list.threads).toHaveLength(1);
    expect(list.threads[0]?.id).toBe(started.threadId);
    expect(list.threads[0]?.posture.summary).toBe("Runs commands without asking");

    // Detail returns the thread, turn, and diff.
    const detailRes = await world.send(`/engine/direct-chats/${started.threadId}`, "GET", { cookie: world.cookie });
    expect(detailRes.status).toBe(200);
    const detail = JSON.parse(detailRes.body) as { room: string; turns: Array<{ userPrompt: string }> };
    expect(detail.room).toBe(started.room);
    expect(detail.turns[0]?.userPrompt).toBe("Summarize README");

    // SSE room admits the owner over loopback and emits hello.
    const sse = await new Promise<{ status: number; contentType: string; chunk: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: world.port,
          path: `/live?room=${encodeURIComponent(started.room)}`,
          method: "GET",
          headers: {
            host: `127.0.0.1:${world.port}`,
            cookie: world.cookie,
            accept: "text/event-stream",
            "x-toolroll-live": "1",
          },
        },
        res => {
          let buf = "";
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            req.destroy();
            resolve({ status: res.statusCode!, contentType: String(res.headers["content-type"] ?? ""), chunk: buf });
          };
          res.setEncoding("utf8");
          res.on("data", chunk => {
            buf += chunk;
            if (buf.includes("event: hello")) finish();
          });
          res.on("end", finish);
        },
      );
      req.on("error", err => {
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
      });
      req.end();
    });
    expect(sse.status).toBe(200);
    expect(sse.contentType).toContain("text/event-stream");
    expect(sse.chunk).toContain("event: hello");

    // Stop running turn.
    const stopRes = await world.post(`/engine/direct-chats/${started.threadId}/stop`, {});
    expect(stopRes.status).toBe(200);
    expect(JSON.parse(stopRes.body)).toMatchObject({ ok: true, said: "Stopped." });

    // Switch provider/model once stopped.
    const modelRes = await world.post(`/engine/direct-chats/${started.threadId}/model`, {
      provider: "codex",
      model: "gpt-5.4",
    });
    expect(modelRes.status).toBe(200);
    expect(JSON.parse(modelRes.body)).toMatchObject({ ok: true });

    // Send follow-up turn.
    const followUpRes = await world.post(`/engine/direct-chats/${started.threadId}/messages`, {
      prompt: "Now list the modules",
      request: "e".repeat(32),
    });
    expect(followUpRes.status).toBe(200);
    expect(JSON.parse(followUpRes.body)).toMatchObject({ ok: true, threadId: started.threadId });

    // Stop, test Phase 1b attachment upload + artifact serving, apply-main-edits, and keep-branch Ship!
    await world.post(`/engine/direct-chats/${started.threadId}/stop`, {});

    const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const attachRes = await world.post(`/engine/direct-chats/${started.threadId}/attachments`, {
      filename: "screen.png",
      mimeType: "image/png",
      dataBase64: tinyPngBase64,
    });
    expect(attachRes.status).toBe(200);
    const attached = JSON.parse(attachRes.body) as { ok: true; artifact: { id: string; url: string }; cloneRelativePath: string };
    expect(attached.ok).toBe(true);
    expect(attached.cloneRelativePath).toContain(".toolroll-attachments/");

    // Fetch artifact with sandboxed CSP and nosniff.
    const artRes = await world.send(attached.artifact.url, "GET", { cookie: world.cookie });
    expect(artRes.status).toBe(200);
    expect(artRes.headers["content-type"]).toBe("image/png");
    expect(artRes.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(artRes.headers["content-security-policy"] ?? "")).toContain("sandbox");

    // Reject SVG attachment upload (415).
    const badAttach = await world.post(`/engine/direct-chats/${started.threadId}/attachments`, {
      filename: "bad.svg",
      mimeType: "image/svg+xml",
      dataBase64: Buffer.from("<svg></svg>").toString("base64"),
    });
    expect(badAttach.status).toBe(415);

    // Dirty main checkout -> bring uncommitted changes into clone -> preview + keep-branch Ship!
    writeFileSync(join(world.repo, "README.md"), "# Payments\nMain uncommitted edit\n");
    const applyMainRes = await world.post(`/engine/direct-chats/${started.threadId}/apply-main-edits`, {});
    expect(applyMainRes.status).toBe(200);
    expect(JSON.parse(applyMainRes.body)).toMatchObject({ ok: true });

    const previewRes = await world.post(`/engine/direct-chats/${started.threadId}/ship-preview`, {});
    expect(previewRes.status).toBe(200);
    const preview = JSON.parse(previewRes.body) as { termsDigest: string; mode: string; changedFiles: string[] };
    expect(preview.mode).toBe("keep-branch");
    expect(preview.changedFiles).toContain("README.md");

    const shipRes = await world.post(`/engine/direct-chats/${started.threadId}/ship`, {
      mode: "keep-branch",
      termsDigest: preview.termsDigest,
    });
    expect(shipRes.status).toBe(200);
    expect(JSON.parse(shipRes.body)).toMatchObject({ ok: true, ship: { state: "kept" } });

    // Delete the chat (now clean after snapshot commit, or discard).
    const delRes = await world.post(`/engine/direct-chats/${started.threadId}/delete`, { discard: "1" });
    expect(delRes.status).toBe(200);
    expect(JSON.parse(delRes.body)).toMatchObject({ ok: true });

    const afterList = JSON.parse((await world.send("/engine/direct-chats", "GET", { cookie: world.cookie })).body) as { threads: unknown[] };
    expect(afterList.threads).toHaveLength(0);
  });
});
