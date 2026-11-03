/**
 * The console never waits on a folder outside its own data (the 0.9.82 and 0.9.87 deploys: the console listened on
 * :4180 but answered nothing, its main thread inside a directory read of a folder that had stopped answering).
 *
 * A folder that stops answering is stood in for here: every synchronous read of the project's folder on this thread is
 * recorded (and, where a test asks, blocks the thread the way the kernel would), and every off-thread look at it
 * (folder-look.ts) never answers. Signed in, against every GET and HEAD row of the route table, the console must not
 * read that folder on its thread, must not read "/" or anything under /Volumes on its thread, and must keep answering
 * /healthz and /login within two seconds.
 */
import { afterEach, expect, test, vi } from "vitest";

const hang = vi.hoisted(() => ({
  /** When on, the project folder doesn't answer. */
  on: false,
  /** How long a synchronous read of it holds the thread (0: recorded only). */
  blockMs: 0,
  /** Synchronous reads that reached it, or reached "/" or /Volumes, with where they came from. */
  reached: [] as string[],
}));
// The world's project folder (test/quiet-world.ts names it so); its setup only writes there.
const PROJECT = /\/so-getquiet-[^/]+\/repo(\/|$)/;
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  const reads = ["readdirSync", "opendirSync", "statSync", "lstatSync", "realpathSync", "existsSync", "accessSync", "readFileSync", "openSync", "readlinkSync", "statfsSync"] as const;
  const wrapped: Record<string, unknown> = {};
  for (const name of reads) {
    const fn = (real as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
    const one = (...args: unknown[]): unknown => {
      const path = typeof args[0] === "string" ? args[0] : args[0] instanceof URL ? args[0].pathname : null;
      if (path !== null) {
        const root = (name === "readdirSync" || name === "opendirSync" || name === "statfsSync") && (path === "/" || path === "/Volumes" || path.startsWith("/Volumes/"));
        const project = hang.on && PROJECT.test(path);
        // The world's own setup (test/quiet-world.ts seeding the store) is not the console.
        const limit = Error.stackTraceLimit;
        Error.stackTraceLimit = 80;
        const stack = new Error().stack!;
        Error.stackTraceLimit = limit;
        const seeding = stack.includes("quiet-world.ts") && !stack.includes("/src/serve.ts");
        if ((root || project) && !seeding) {
          hang.reached.push(`${name} ${path}\n${stack.split("\n").slice(2, 7).join("\n")}`);
          if (project && hang.blockMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hang.blockMs);
        }
      }
      return fn(...args);
    };
    if (name === "realpathSync") (one as unknown as { native: unknown }).native = (real.realpathSync as unknown as { native: unknown }).native;
    wrapped[name] = one;
  }
  return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});

import { childLook, type FolderLookRunner } from "../folder-look.js";
import { projectIdentities } from "../project-identity.js";
import { ROUTES } from "./route-table.js";
import { openQuietWorld, type QuietWorld } from "../../test/quiet-world.js";

/** The off-thread look: the real child for every other folder; for the project folder, while it hangs, never an answer. */
const looks: FolderLookRunner = (request, deadlineMs) => {
  const paths = request.op === "identities" ? request.paths : request.op === "origins" ? [...request.registered, ...request.roots] : [request.path];
  if (hang.on && paths.some(one => PROJECT.test(one))) return { answer: new Promise(() => {}), ended: Promise.resolve() };
  return childLook(request, deadlineMs);
};

let world: QuietWorld | null = null;
afterEach(async () => {
  hang.on = false; hang.blockMs = 0; hang.reached.length = 0;
  vi.restoreAllMocks();
  await world?.close();
  world = null;
});

const timed = async (send: () => Promise<{ status: number }>): Promise<{ status: number; ms: number }> => {
  const at = Date.now();
  const answer = await send();
  return { status: answer.status, ms: Date.now() - at };
};

async function open(hungFromTheStart: boolean) {
  hang.on = hungFromTheStart;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("no network in this test"); });
  const identities = projectIdentities({ runner: looks, deadlineMs: 300 });
  const opened = await openQuietWorld(() => {}, { identities, backgroundChecks: true, backgroundChecksMs: 200 });
  world = opened;
  return { world: opened, identities };
}

test("started while the project folder doesn't answer: /healthz and /login answer at once, and nothing reads the folder on the console's thread", async () => {
  hang.blockMs = 5_000;
  const { world: w } = await open(true);
  // The background pass is under way (its first run starts as the console listens), and its look at the folder hangs.
  const [health, login] = await Promise.all([timed(() => w.send("/healthz", "GET")), timed(() => w.send("/login", "GET"))]);
  expect(health).toMatchObject({ status: 200 });
  expect(login).toMatchObject({ status: 200 });
  expect(Math.max(health.ms, login.ms)).toBeLessThan(2_000);
  // A few background passes later, still nothing on the thread.
  await new Promise(done => setTimeout(done, 700));
  expect((await timed(() => w.send("/healthz", "GET"))).ms).toBeLessThan(2_000);
  expect(hang.reached).toEqual([]);
}, 30_000);

test("a project folder that stops answering after it was resolved: every GET and HEAD row answers without reading it on the console's thread", async () => {
  const { world: w, identities } = await open(false);
  await identities.refresh([w.repo]);
  const { cookie, csrf } = await w.signIn();
  // The folder stops answering; the console learns it the way production does, from a look that didn't answer.
  hang.on = true;
  await identities.refresh([w.repo]).catch(() => false);
  expect(await identities.resolveNow(w.repo)).toBe("no-answer");
  const project = encodeURIComponent(w.repo);
  const deeper = [`/settings/knowledge?repo=${project}&q=refunds`, `/settings/skills?repo=${project}`, `/settings/learning?repo=${project}`,
    `/settings/tools?repo=${project}`, `/settings/project?repo=${project}`, `/settings/pull-requests?repo=${project}`, "/t/one", "/chat?task=one", "/workbench?t=one"];
  const targets = [...ROUTES.filter(row => row.method !== "POST").flatMap(row => (row.method === "GET,HEAD" ? ["GET", "HEAD"] : ["GET"]).map(method => ({ method, path: row.sample }))),
    ...deeper.map(path => ({ method: "GET", path }))];
  const reachedBy: string[] = [];
  for (const { method, path } of targets) {
    hang.reached.length = 0;
    const answer = await w.send(path, method, { cookie });
    await new Promise(done => setTimeout(done, 5));
    expect(answer.status, `${method} ${path}`).toBeLessThan(500);
    if (hang.reached.length > 0) reachedBy.push(`${method} ${path}\n  ${hang.reached[0]!.replace(/\n/g, "\n  ")}`);
  }
  // Filing work there (a POST: its sealed network names the repository's ecosystems, egress.ts) doesn't read it either.
  hang.reached.length = 0;
  const filed = await w.post("/tasks/add", cookie, { csrf, id: "two", title: "filed while the folder hangs", repo: w.repo });
  expect(filed.status).toBeLessThan(500);
  if (hang.reached.length > 0) reachedBy.push(`POST /tasks/add\n  ${hang.reached[0]!.replace(/\n/g, "\n  ")}`);
  expect(reachedBy).toEqual([]);
  // And while one of those pages is asked for, the health check doesn't wait for it.
  hang.blockMs = 5_000;
  const [, health] = await Promise.all([w.send(`/settings/knowledge?repo=${project}&q=refunds`, "GET", { cookie }), timed(() => w.send("/healthz", "GET"))]);
  expect(health.ms).toBeLessThan(2_000);
}, 120_000);
