/** The Settings journey's SYNTHETIC fixture (Settings revamp S1). One temp root holds HOME, XDG_CONFIG_HOME, the
 * database, the config folder and the projects folder; the console runs in-process on 127.0.0.1 at a random port.
 * No worker, no model call, never :4180, never ~/.config/standing-orders or the real database.
 *
 * Two kinds:
 *   - `fresh`: an empty installation with a setup code (the first-account page, then whatever the step drives).
 *   - `lived-in`: an owner (alex) and a viewer (sam), one project with four finished runs and one plan waiting,
 *     Sized by job applied, a budget near its hard stop, an open approver invite. Every value is labelled synthetic.
 *
 * `isolateEnvironment` must run before any `dist/` module is imported: the plane resolves its folders from the
 * environment when it is asked. `assertFixtureSafe` refuses a fixture whose paths reach the person's real setup. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LIVE_PORT = 4180;
export const OWNER = { name: "alex", password: "correct-horse-1" };
export const VIEWER = { name: "sam", password: "sam-password-1" };
export const SETUP_CODE = "482913";
export const FIXTURE_KINDS = ["fresh", "lived-in"];

/** The real account's home, from the password database, so a changed HOME can't hide it. */
export function realHome() {
  try { return realpathSync(userInfo().homedir); } catch { return resolve(userInfo().homedir); }
}

/** The real path, or for a path that doesn't exist yet, its deepest existing folder's real path plus the rest. */
const real = path => {
  const full = resolve(path);
  try { return realpathSync(full); } catch { /* not there yet */ }
  const up = dirname(full);
  return up === full ? full : join(real(up), basename(full));
};
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Every fixture path resolves inside the fixture's own temp root, never inside the real config folder, the real
 * home's Toolroll state or the live database, and the port isn't the live console's. Throws on the first breach. */
export function assertFixtureSafe({ root, paths, port, home: given = realHome(), liveDb = [] }) {
  const base = real(root), home = real(given);
  if (!inside(base, real(tmpdir())) && !inside(base, "/tmp") && !inside(base, "/private/tmp") && !inside(base, "/private/var/folders"))
    throw new Error(`fixture root ${base} isn't a temp folder`);
  if (inside(home, base)) throw new Error(`fixture root ${base} contains the real home`);
  const forbidden = [join(home, ".config", "standing-orders"), join(home, ".config", "toolroll"), join(home, ".standing-orders"), join(home, ".toolroll"), ...liveDb.filter(Boolean).map(real)];
  for (const [label, path] of Object.entries(paths)) {
    const at = real(path);
    if (!inside(at, base)) throw new Error(`fixture ${label} ${at} is outside the fixture root ${base}`);
    for (const one of forbidden) if (inside(at, real(one))) throw new Error(`fixture ${label} ${at} reaches the real setup (${one})`);
  }
  if (port !== undefined && (port === LIVE_PORT || !Number.isInteger(port) || port <= 0)) throw new Error(`fixture port ${port} isn't a free random port`);
}

const ENV_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "TOOLROLL_DB", "STANDING_ORDERS_DB", "TOOLROLL_NO_UPDATE_CHECK", "TOOLROLL_STORAGE_SWEEP", "TOOLROLL_SECRET_STORE", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];

/** Points this process at a fresh temp root (as test/setup-state.ts does for the suite) and returns it with a
 * restore function. The live database names are remembered so the guard can refuse them by path. */
export function isolateEnvironment() {
  const liveDb = [process.env.TOOLROLL_DB, process.env.STANDING_ORDERS_DB, join(realHome(), ".config", "standing-orders", "orders.db")];
  const before = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-settings-journey-")));
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "home", ".gitconfig"), "[user]\n\tuseConfigOnly = true\n");
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.TOOLROLL_DB = join(root, "plane.db");
  process.env.STANDING_ORDERS_DB = join(root, "plane.db");
  process.env.TOOLROLL_NO_UPDATE_CHECK = "1";
  process.env.TOOLROLL_STORAGE_SWEEP = "off";
  process.env.TOOLROLL_SECRET_STORE = "files";
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  assertFixtureSafe({ root, liveDb, paths: { home: process.env.HOME, config: process.env.XDG_CONFIG_HOME, db: process.env.TOOLROLL_DB } });
  const restore = () => {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  };
  return { root, liveDb, restore };
}

const dist = path => import(pathToFileURL(join(ROOT, "dist", path)).href);

function gitRepo(at) {
  mkdirSync(at, { recursive: true });
  const git = args => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: at, stdio: "ignore" });
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(at, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "node --test" } }, null, 1));
  writeFileSync(join(at, "README.md"), "# shop (synthetic fixture)\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
}

/** The lived-in installation, built through the store's own doors (the same seed as Phase 0's capture). */
async function seedLivedIn(store, repo, now) {
  const { BUILT_IN } = await dist("store.js");
  const { addApprover, propose, hashPassword } = await dist("scope.js");
  const { applyModelChoices, presetChange, previewModelChange } = await dist("model-choices.js");
  const alex = addApprover(store, OWNER.name, now, undefined, undefined, {}, OWNER.password);
  if (!alex.ok) throw new Error("fixture: owner");
  store.upsertProject(repo, "shop", now);
  const at = now.toISOString();
  const seen = store.handle.prepare("INSERT INTO model_seen (source, id, name, input_usd, output_usd, context, tools, released_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)");
  seen.run("claude", "claude-opus-5-5", "Claude Opus 5.5", 4, 20, "2026-09-10T00:00:00.000Z", at, at);
  seen.run("claude", "claude-sonnet-5-5", "Claude Sonnet 5.5", 2, 10, "2026-09-10T00:00:00.000Z", at, at);
  seen.run("claude", "claude-haiku-5-5", "Claude Haiku 5.5", 1, 5, "2026-09-10T00:00:00.000Z", at, at);
  const change = presetChange("sized");
  const preview = previewModelChange(store, "installation", change);
  const applied = applyModelChoices(store, { scope: "installation", change, expected: { state: preview.state, change: preview.change }, strict: true, knownProject: () => false },
    { actor: OWNER.name, generation: store.accountOf(OWNER.name).generation, method: "password-now", live: () => true }, now);
  if (!applied.ok) throw new Error(`fixture: models: ${applied.problem}`);
  const legacy = { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" };
  const runs = [["Fix the checkout total rounding", "claude-sonnet-5-5", 1.84], ["Rework the order export to stream", "claude-opus-5-5", 7.42], ["Change the footer copy", "claude-haiku-5-5", 0.21], ["Add tests for coupon codes", "claude-sonnet-5-5", 3.1]];
  runs.forEach(([title, model, usd], i) => {
    const id = `sample-${i + 1}`;
    store.createTask({ id, title, filedBy: { name: OWNER.name, kind: "person" } }, now);
    const ref = store.refFor(BUILT_IN, id).id;
    store.placeTask(ref, repo);
    const run = store.startRun({ taskRef: ref, leaseId: `l-${i}`, runner: "b1", branch: `standing-orders/${id}`, worktree: `/w/${id}`, route: legacy, now: new Date(now.getTime() - (4 - i) * 60_000) });
    store.handle.prepare("UPDATE run SET model = ?, model_reported = ?, cost_usd = ?, billing_basis = ?, cost_unknown = 0 WHERE id = ?").run(model, model, usd, "evidence", run);
    store.handle.prepare("INSERT OR REPLACE INTO run_spend (run, microusd, source, billing, billing_fixed, priced_at) VALUES (?, ?, 'reported', 'api-key', 1, ?)").run(run, Math.round(usd * 1e6), at);
    store.finishRun(run, { outcome: "built", now });
  });
  store.createTask({ id: "waiting-1", title: "Add a returns page", filedBy: { name: OWNER.name, kind: "person" } }, now);
  store.placeTask(store.refFor(BUILT_IN, "waiting-1").id, repo);
  propose(store, { taskId: "waiting-1", goal: "A returns page customers can reach from their order.", now });
  store.setBudget({ scope: "installation", key: "*", limitMicrousd: 50e6, hardStop: false }, OWNER.name, now);
  store.setBudget({ scope: "project", key: repo, limitMicrousd: 13e6, hardStop: true }, OWNER.name, now);
  const invite = store.mintInvite("viewer", OWNER.name, now);
  const joined = store.consumeInviteAndCreateAccount({ tokenValue: invite.token, name: VIEWER.name, credentialHash: hashPassword(VIEWER.password) }, now);
  if (!joined.ok) throw new Error("fixture: viewer");
  return { openInvite: store.mintInvite("approver", OWNER.name, now).token };
}

/** Starts one fixture of `kind` under `root` (from isolateEnvironment) and returns its base URL, a way to sign in,
 * and `close`. Each call gets its own sub-folder and database, so steps never see each other's writes. */
export async function startFixture({ kind, root, liveDb = [] }) {
  if (!FIXTURE_KINDS.includes(kind)) throw new Error(`unknown fixture kind ${kind}`);
  const { openStore } = await dist("store.js");
  const { createDecisionServer } = await dist("serve.js");
  const dir = realpathSync(mkdtempSync(join(root, `${kind}-`)));
  const projects = join(dir, "projects");
  const repo = join(projects, "shop");
  gitRepo(repo);
  if (kind === "fresh") mkdirSync(join(projects, "notes-not-git"), { recursive: true });
  const paths = { dir, db: join(dir, "orders.db"), projects, repo, evidence: join(dir, "evidence"), config: dir, telegram: join(dir, "telegram-token"), registry: join(dir, "registry.json") };
  assertFixtureSafe({ root, paths, liveDb });
  const store = openStore(paths.db);
  const now = new Date();
  const seeded = kind === "lived-in" ? await seedLivedIn(store, repo, now) : {};
  const updates = { latest: async () => ({ version: "0.0.0-fixture" }), current: "0.0.0-fixture" };
  const server = createDecisionServer({
    store, terminalHost: null, updates, evidenceRoot: paths.evidence, projectRoots: [projects], configDir: paths.config,
    telegramTokenFile: paths.telegram, registryPath: paths.registry,
    ...(kind === "fresh"
      ? { repos: [], setupCode: SETUP_CODE, currentRepos: () => store.listProjects().map(one => one.path), admittedRepos: () => store.listProjects().map(one => one.path) }
      : { repos: [repo], currentRepos: () => [repo], admittedRepos: () => [repo] }),
  });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  try { assertFixtureSafe({ root, paths, port, liveDb }); } catch (error) { server.close(); store.close(); throw error; }
  const base = `http://127.0.0.1:${port}`;
  return {
    kind, base, port, repo, paths, store, ...seeded,
    /** A session cookie for Playwright's addCookies, through the real sign-in form. */
    async cookieFor(who) {
      const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: who.name, token: who.password }), redirect: "manual" });
      const cookie = login.headers.getSetCookie().map(one => one.split(";")[0]).find(one => /_session=/.test(one));
      if (cookie === undefined) throw new Error(`fixture: sign-in failed for ${who.name} (${login.status})`);
      const at = cookie.indexOf("=");
      return { name: cookie.slice(0, at), value: cookie.slice(at + 1), url: base };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise(done => server.close(() => done()));
      store.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}
