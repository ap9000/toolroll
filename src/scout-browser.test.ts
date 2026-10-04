/**
 * The scout's real browser (run 2356): launched exactly as a scout gets it — the catalog's pinned Playwright, the
 * scout's arguments, its public-web-only proxy, its proxy environment and the agent fence — it opens a public page
 * and saves a screenshot in the image folder, never in the workspace. Skipped, with the reason, on a machine
 * without Chrome, npx or the web.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogTool } from "./project-tools.js";
import { readReportImage, SCOUT_BROWSER, scoutBrowser, scoutProxyEnv } from "./scout.js";
import { startScoutProxy, type ScoutProxy } from "./scout-net.js";
import { insideInheritedSandbox, linuxFenceAvailable, macosFenceAvailable } from "./agent-fence.js";
import { openBrowserSession, preflightBrowser, type BrowserLaunch } from "./scout-browser.js";

const CHROME = process.platform === "darwin" ? "/Applications/Google Chrome.app" : null;
const online = await lookup("example.com").then(() => true, () => false);
const why =
  spawnSync("npx", ["--version"], { stdio: "ignore" }).status !== 0 ? "npx is not installed"
  : process.platform === "darwin" && !existsSync(CHROME!) ? "Google Chrome is not installed"
  : process.platform !== "darwin" && spawnSync("which", ["google-chrome"], { stdio: "ignore" }).status !== 0 ? "Google Chrome is not installed"
  : !online ? "this machine can't reach the web"
  : null;
if (why !== null) console.warn(`The scout's real browser tests are skipped: ${why}.`);

describe.skipIf(why !== null)(`the scout's real browser${why === null ? "" : ` (skipped: ${why})`}`, () => {
  let root = "";
  let folder = "";
  let workspace = "";
  let proxy: ScoutProxy;
  let launch: BrowserLaunch;
  // Fenced as a scout is: wrapped in a fence of its own here, or held by the one this test already runs in.
  const fenced = macosFenceAvailable() || linuxFenceAvailable() || insideInheritedSandbox();
  const refused: string[] = [];
  const options = () => ({
    env: { ...process.env, ...scoutProxyEnv(proxy.url) },
    // A fenced folder of its own: the browser starts inside the same kind of fence a scout's does.
    fence: [mkdtempSync(join(root, "fenced-"))],
    cwd: workspace,
    timeoutMs: 180_000,
  });

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-scout-browser-")));
    folder = mkdtempSync(join(root, "images-"));
    workspace = mkdtempSync(join(root, "workspace-"));
    proxy = await startScoutProxy({ refused: target => refused.push(target) });
    const config = scoutBrowser(catalogTool("playwright"), folder, proxy.url, fenced)?.[SCOUT_BROWSER] as BrowserLaunch | undefined;
    if (config === undefined) throw new Error("the catalog has no Playwright entry");
    launch = config;
  });
  afterAll(async () => {
    await proxy?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the preflight starts it, inside the fence", async () => {
    expect(await preflightBrowser(launch, options())).toEqual({ ok: true });
    // The preflight's own screenshot went to its scratch folder, not the scout's.
    expect(readdirSync(folder)).toEqual([]);
  }, 240_000);

  test("a scout opens a public page and saves its screenshot in the image folder", async () => {
    const session = openBrowserSession(launch, options());
    try {
      expect(await session.start()).toEqual({ ok: true });
      expect(await session.call("browser_navigate", { url: "https://example.com/" })).toEqual({ ok: true });
      // As the brief says: by its full path in the image folder.
      expect(await session.call("browser_take_screenshot", { filename: join(folder, "home.png") })).toEqual({ ok: true });
      // The proxy still turns this machine away (the page is its refusal, not this machine's).
      await session.call("browser_navigate", { url: "http://127.0.0.1:65000/" });
    } finally {
      await session.close();
    }
    const saved = readReportImage(folder, "home.png");
    expect(saved).toMatchObject({ ok: true, kind: "png" });
    expect(readdirSync(workspace)).toEqual([]);
    expect(refused).toContain("http://127.0.0.1:65000");
  }, 240_000);
});
