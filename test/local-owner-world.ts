/**
 * A laptop install (easy-start plan F, C1): a database `up --laptop` made, local mode on for its owner `alex` (no
 * password), one git project with a task, and a real console. `localSession()` spends the console's own local link,
 * as `up --laptop` opens it, and returns the local owner's cookie and form token. Every probe and model seam is stubbed:
 * no model, no network, no child process beyond git. Shared by the local-owner attack suite and the route inventory.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalMode, openStore, type Store } from "../src/store.js";
import { createDecisionServer, type DecisionServer } from "../src/serve.js";
import type { ServeOptions } from "../src/server/http.js";
import { setLimitOverride } from "../src/request-budget.js";

export const LOCAL_T0 = new Date("2026-11-03T12:00:00.000Z");

export type LocalWorld = Awaited<ReturnType<typeof openLocalWorld>>;

/** `extra` may be a function of the world's own folder (for options that name it, like projectRoots). */
/** `listenOn`: the address the console listens on (default loopback only; "0.0.0.0" lets a test reach it from this
 * machine's own network address, as another device on the LAN would). */
export async function openLocalWorld(more: Partial<ServeOptions> | ((root: string) => Partial<ServeOptions>) = {}, listenOn = "127.0.0.1") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-local-")));
  const repo = join(root, "repo"); mkdirSync(repo);
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "-q", repo], { env: gitEnv });
  writeFileSync(join(repo, "README.md"), "# Shop\n");
  execFileSync("git", ["-C", repo, "add", "README.md"], { env: gitEnv });
  execFileSync("git", ["-C", repo, "-c", "user.email=q@example.com", "-c", "user.name=q", "commit", "-qm", "readme"], { env: gitEnv });
  const configDir = join(root, "config"); mkdirSync(configDir);
  const extra = typeof more === "function" ? more(root) : more;
  const store: Store = openStore(join(configDir, "state.db"), { createdBy: "laptop" });
  const init = initLocalMode(store, { owner: "alex", fenceAvailable: true, now: LOCAL_T0 });
  if (!init.ok) throw Error(`local mode: ${init.reason}`);
  setLimitOverride(store, "*", { readPerMinute: 600, actPerMinute: 600, perDay: 10000 }, "alex", LOCAL_T0);
  for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", LOCAL_T0);
  const made = store.createConsoleTask({ id: "one", title: "task one", repo, goal: "do one", acceptance: [{ id: "c1", statement: "one is done.", evidence: ["manual-review"] }], filedVia: "cli" }, LOCAL_T0);
  if (!made.ok) throw Error(made.reason);
  writeFileSync(join(configDir, "telegram-token"), "", { mode: 0o600 });
  const server: DecisionServer = createDecisionServer({
    store, evidenceRoot: join(root, "evidence"), repo, admittedRepos: () => [repo], configDir, telegramTokenFile: join(configDir, "telegram-token"),
    connectionHome: root, toolHome: root, platform: "darwin",
    connectionProbe: async () => ({ code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "", timedOut: false, notFound: false }),
    modelCatalogFetcher: (async () => { throw new Error("offline"); }) as typeof fetch,
    modelRunner: async () => ({ code: 1, stdout: "", stderr: "" }),
    firstTaskRunner: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: true }),
    ghList: async () => ({ ok: false, reason: "gh-missing", message: "gh is not installed" }) as never,
    chatFetcher: (async () => { throw new Error("offline"); }) as typeof fetch,
    subscriptionChatRunner: async () => { throw new Error("no model in this test"); },
    ...extra,
  });
  await new Promise<void>(resolve => server.listen(0, listenOn, resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  const send = (path: string, method: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> =>
    new Promise((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, connection: "close", ...headers } }, response => {
        let text = "";
        response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode!, body: text, headers: response.headers }));
      });
      request.on("error", reject); request.end(body);
    });
  const post = (path: string, cookie: string, form: Record<string, string>, accept?: string) =>
    send(path, "POST", { cookie, origin, "content-type": "application/x-www-form-urlencoded", ...(accept === undefined ? {} : { accept }) }, new URLSearchParams(form).toString());

  return {
    store, server, port, origin, root, repo, configDir, send, post,
    /** The local owner's browser session, as `up --laptop` opens it: the console's own one-time local link, spent. */
    async localSession(): Promise<{ cookie: string; csrf: string }> {
      const link = server.mintLocalLink();
      if (link === null) throw Error("no local link");
      const spent = await send(link, "GET");
      if (spent.status !== 303) throw Error(`local link ${spent.status}`);
      const cookie = [spent.headers["set-cookie"] ?? []].flat().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
      const csrf = (JSON.parse((await send("/chat?format=workspace", "GET", { cookie })).body) as { csrf: string }).csrf;
      if ((await post("/projects/select", cookie, { csrf, path: repo })).status !== 303) throw Error("open project");
      return { cookie, csrf };
    },
    async close() {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
