/**
 * The scout's real browser (run 2356, review 828): the worker starts the pinned Playwright, installed in Toolroll's
 * helpers folder with its own Chrome for Testing, outside the agent fence under its launch contract (sandbox parity
 * C4), Chrome's own sandbox on, behind the scout's public-web-only proxy; a client inside the fence (as the scout is)
 * reaches it only by its loopback address, opens a public page and saves a screenshot in the image folder. The helper
 * is installed once into a test-only folder in the system temp folder and reused. Skipped, with the reason, on a
 * machine without npm or the web, or when this test itself runs inside a sandbox (Chrome's sandbox can't start there;
 * that is the failure the preflight reports).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readReportImage, scoutBrowserLaunch, scoutProxyEnv } from "./scout.js";
import { startScoutProxy, type ScoutProxy } from "./scout-net.js";
import { linuxFenceAvailable, linuxFenced, macosFenceAvailable, macosFenced, NO_GRANTS, SANDBOX_EXEC } from "./agent-fence.js";
import { nativeSeccomp } from "../test/seccomp-fixture.js";
import { SCOUT_BROWSER_ENV, scoutBrowserTool, startContractedBrowser, startScoutBrowser, type BrowserLaunch, type ScoutBrowserServer } from "./scout-browser.js";

describe("a browser that can't start", () => {
  let folder = "";
  beforeAll(() => { folder = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-scout-nobrowser-"))); });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const tool = (source: string): BrowserLaunch => {
    const script = join(folder, `tool-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(script, source);
    return { command: process.execPath, args: [script] };
  };

  test("is said in one line, with the tool's own last word", async () => {
    const started = await startScoutBrowser(tool("process.stderr.write('Chromium distribution \\'chrome\\' is not found\\n'); process.exit(1);"), { env: process.env, folder });
    expect(started).toEqual({ ok: false, reason: "the browser tool stopped (exit 1): Chromium distribution 'chrome' is not found" });
  });

  test("that never answers is given up on within the time limit", async () => {
    const at = Date.now();
    const started = await startScoutBrowser(tool("setInterval(() => undefined, 1000);"), { env: process.env, folder, timeoutMs: 2_000 });
    expect(started).toEqual({ ok: false, reason: "the browser did not start within 2 seconds" });
    expect(Date.now() - at).toBeLessThan(10_000);
  });
});

const online = await lookup("example.com").then(() => true, () => false);
const why =
  spawnSync("npm", ["--version"], { stdio: "ignore" }).status !== 0 ? "npm is not installed"
  : !online ? "this machine can't reach the web"
  : process.platform === "linux" && linuxFenceAvailable() && nativeSeccomp() === null ? "no seccomp helper built (node vendor/seccomp/build.mjs)"
  : process.platform === "darwin" && existsSync(SANDBOX_EXEC) && !macosFenceAvailable() ? "this test runs inside a sandbox, where Chrome's own sandbox can't start; run it from an unsandboxed shell"
  : null;
if (why !== null) console.warn(`The scout's real browser tests are skipped: ${why}.`);

describe.skipIf(why !== null)(`the scout's real browser${why === null ? "" : ` (skipped: ${why})`}`, () => {
  let root = "";
  let folder = "";
  let proxy: ScoutProxy;
  let server: ScoutBrowserServer | null = null;
  const refused: string[] = [];

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-scout-browser-")));
    folder = mkdtempSync(join(root, "images-"));
    proxy = await startScoutProxy({ refused: target => refused.push(target) });
  });
  afterAll(async () => {
    await server?.close();
    await proxy?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("starts outside the fence and passes its preflight through the proxy within a minute", async () => {
    // A test-only helpers folder, kept between runs (the pinned tool and its Chrome are a large download).
    const helpers = join(tmpdir(), `toolroll-test-scout-helpers-${process.getuid?.() ?? "user"}`);
    mkdirSync(helpers, { recursive: true, mode: 0o700 });
    chmodSync(helpers, 0o700);
    const launch = scoutBrowserLaunch(scoutBrowserTool(helpers), folder, proxy.url);
    if (launch === null) throw new Error("no browser launch");
    expect(launch.args).not.toContain("--no-sandbox");
    const env = { ...Object.fromEntries(SCOUT_BROWSER_ENV.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])), ...scoutProxyEnv(proxy.url) };
    const contract = { helpers, proxy: proxy.url };
    // The first run installs the pinned helper (its own time limit), then the start is held to its minute.
    await startContractedBrowser({ command: "/bin/false", args: [] }, { env, folder, contract });
    const at = Date.now();
    const started = await startContractedBrowser(launch, { env, folder, contract });
    expect(started).toMatchObject({ ok: true, server: { url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/) } });
    expect(Date.now() - at).toBeLessThan(65_000);
    server = started.ok ? started.server : null;
    // The preflight's own screenshot and notes are gone: the folder is the scout's.
    expect(readdirSync(folder)).toEqual([]);
  }, 90_000);

  test("a scout inside the fence opens a public page and saves its screenshot in the image folder", async () => {
    if (server === null) throw new Error("the browser did not start");
    const secret = mkdtempSync(join(root, "fenced-"));
    // The scout's own MCP client, as a fenced process: the browser's loopback port is the only address it reaches
    // without the proxy.
    const client = join(root, "client.mts");
    writeFileSync(client, `
      import { openSession } from ${JSON.stringify(resolve("src/scout-browser.ts"))};
      const session = openSession(process.argv[2], Date.now() + 90_000, "late");
      const steps = [await session.start()];
      for (const [tool, input] of [
        ["browser_navigate", { url: "https://example.com/" }],
        ["browser_take_screenshot", { filename: "home.png", type: "png" }],
        ["browser_take_screenshot", { filename: process.argv[3] + "/stolen.png", type: "png" }],
        ["browser_navigate", { url: "http://127.0.0.1:65000/" }],
        ["browser_navigate", { url: "file:///etc/hosts" }],
      ]) steps.push(await session.call(tool, input));
      await session.close();
      console.log(JSON.stringify(steps.map(step => step.ok ? "ok" : step.reason)));
    `);
    const tsx = resolve("node_modules/.bin/tsx");
    let { file, args } = { file: tsx, args: [client, server.url, secret] };
    if (macosFenceAvailable()) ({ file, args } = macosFenced(file, args, [secret]));
    else if (linuxFenceAvailable()) ({ file, args } = linuxFenced(file, args, [secret], { ...NO_GRANTS, seccomp: nativeSeccomp()! }));
    const env = { ...process.env, ...scoutProxyEnv(proxy.url, server.url) };
    const output = await new Promise<string>((done, fail) => {
      const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      let errors = "";
      child.stdout.on("data", chunk => { text += String(chunk); });
      child.stderr.on("data", chunk => { errors += String(chunk); });
      child.on("error", fail);
      child.on("exit", code => (code === 0 ? done(text) : fail(new Error(`the fenced client failed (${code}): ${errors}`))));
    });
    const steps = JSON.parse(output.trim().split("\n").at(-1)!) as string[];
    expect(steps.slice(0, 3)).toEqual(["ok", "ok", "ok"]);
    // Nowhere but the image folder (the fenced folder is outside the browser's roots).
    expect(steps[3]).toMatch(/outside allowed roots/);
    expect(readdirSync(secret)).toEqual([]);
    // The proxy still turns this machine away, and file: never opens.
    expect(refused).toContain("http://127.0.0.1:65000");
    expect(steps[5]).toMatch(/file/);
    expect(readReportImage(folder, "home.png")).toMatchObject({ ok: true, kind: "png" });
  }, 120_000);
});
