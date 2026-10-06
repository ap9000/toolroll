#!/usr/bin/env node
/**
 * Toolroll, end to end: every main feature a person uses, through
 * the real console, the real worker and real Claude, in a throwaway world
 * (scripts/e2e-kit.mjs). Flows have their own run (scripts/flows-e2e.mjs);
 * this one covers the rest, and the newer flow features on top.
 *
 *   npm run e2e:app      (or: node scripts/app-e2e.mjs [--group <name>] [--only <pattern>] [--keep] [--skip-build])
 *   npm run e2e:app:parallel      (every group at once, each in its own world)
 *   node scripts/app-e2e.mjs --groups      (the groups and what each covers)
 *
 * The journeys are in groups. Each group runs in a world of its own, so the
 * groups can run at once; a journey that needs an earlier one is in its group.
 * A journey others build on can be in more than one group (it runs in each).
 * With no --group, every journey runs in one world, one after another.
 *
 * Needs: a built dist/, `claude` logged in, git, npm, sqlite3; Docker for the
 * real mail server (the email inbox check is skipped without it); python3
 * for the Python script. Spends a few Claude turns and real builds.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash, generateKeyPairSync, randomBytes, sign as signWith } from "node:crypto";
import { flag, freePort, GiveUp, groupAlive, groupList, mailSink, option, own, REAL_MODEL, REAL_TURN_MS, SCRIPTED, Skip, SKIPPED_FADE, spawnOwned, stopGroups, waitFor, world } from "./e2e-kit.mjs";
import { makeTempRoot } from "./suite-lifecycle.mjs";

const skipBuild = flag("--skip-build");

/** The groups, in the order they're listed, with how many journeys each has, how many of those are real-model, and how
 * many of its scripted ones another group runs too (checked at the end of every run). Every journey that isn't
 * real-model is scripted: it tests Toolroll's own behaviour with the model scripted. */
const GROUPS = {
  console: { journeys: 14, about: "Sign-in and its hardening, sessions and tokens, approval rules and audit, monitoring, spend, the command line, projects, knowledge, skills, tools, models, routines" },
  pages: { journeys: 7, about: "Every main page on desktop and phone, settings, search, identity provider, the demo and its scripted lead, signing out" },
  task: { journeys: 4, about: "A task from an idea to an accepted result, then sent back twice" },
  builds: { journeys: 1, real: 1, about: "A build that asks a question" },
  stop: { journeys: 1, about: "A build stopped and resumed" },
  lead: { journeys: 4, real: 3, shared: 1, about: "The lead chat: questions, tasks and flows from plain words" },
  maya: { journeys: 3, real: 1, shared: 1, about: "AI teammates (Maya), which the lead then changes" },
  rosa: { journeys: 4, real: 1, shared: 1, about: "A teammate that acts with a real tool: its rules, routine, week and undo" },
  memory: { journeys: 2, shared: 1, about: "A teammate that acts with a real tool: its memory, and the looser rule it suggests" },
  mail: { journeys: 2, about: "A real mail server: the email inbox and follow-ups (needs Docker)" },
  flows: { journeys: 5, about: "Code steps and schedules in flows, the live canvas, starter kits and one-click connections" },
  onboarding: { journeys: 4, about: "From an empty home folder: toolroll up opens Chat signed in with the lead on, a first task filed and followed to Ready, no agent shows the command and turns on by itself, the wrong-host page" },
};
const group = option("--group", null);
if (flag("--groups")) {
  const list = groupList(GROUPS);
  console.log(flag("--json") ? JSON.stringify(list) : list.map(one => `${one.name.padEnd(10)} ${String(one.journeys).padStart(2)} journeys (${one.real} real-model)  ${one.about}`).join("\n"));
  process.exit(0);
}
if (group !== null && !(group in GROUPS)) { console.error(`No group "${group}". The groups: ${Object.keys(GROUPS).join(", ")}`); process.exit(2); }

// The real mail server for the email inbox: GreenMail in Docker, over TLS on 127.0.0.1:993 with a
// certificate made for this run (the console and worker trust it, and only it, beside the usual ones).
const docker = !flag("--list") && (group === null || group === "mail") && (() => { try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }); return true; } catch { return false; } })();
let mailCert = null;
const certDir = join(process.env.TMPDIR ?? "/tmp", `so-e2e-mail-${randomBytes(4).toString("hex")}`);
if (docker) {
  mkdirSync(certDir, { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  execFileSync("openssl", ["pkcs12", "-export", "-in", join(certDir, "cert.pem"), "-inkey", join(certDir, "key.pem"), "-out", join(certDir, "keystore.p12"), "-passout", "pass:e2e-keystore", "-name", "greenmail"], { stdio: "ignore" });
  mailCert = join(certDir, "cert.pem");
}

// A stand-in for Stripe's MCP server and its sign-in, on this computer: it says where to sign in, lets
// Toolroll registers itself, asks the person to allow it, trades the code (PKCE checked) for a
// two-minute token the worker has to renew, and answers MCP only with a current token.
const stand = { port: await freePort(), codes: new Map(), live: new Set(), refresh: new Map(), grants: [], registered: [] };
const standBase = `http://127.0.0.1:${stand.port}`;
const standIn = createHttpServer(async (request, response) => {
  const url = new URL(request.url, standBase);
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const send = (status, body, headers = {}) => { response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(typeof body === "string" ? body : JSON.stringify(body)); };
  if (url.pathname === "/mcp") {
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (bearer === undefined || !stand.live.has(bearer)) return send(401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${standBase}/.well-known/oauth-protected-resource/mcp"` });
    const message = JSON.parse(raw);
    if (message.id === undefined) return send(202, "");
    if (message.method === "initialize") return send(200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stripe", version: "1" } } });
    if (message.method === "tools/list") return send(200, { jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "list_payments", description: "List recent payments", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
      { name: "create_refund", description: "Refund a payment", inputSchema: { type: "object", properties: { payment: { type: "string" }, amount: { type: "number" } }, required: ["payment"] } }] } });
    return send(200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "No payments yet." }] } });
  }
  if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return send(200, { resource: `${standBase}/mcp`, authorization_servers: [standBase] });
  if (url.pathname === "/.well-known/oauth-authorization-server") return send(200, { issuer: standBase, authorization_endpoint: `${standBase}/authorize`, token_endpoint: `${standBase}/token`, registration_endpoint: `${standBase}/register`, code_challenge_methods_supported: ["S256"] });
  if (url.pathname === "/register") { const body = JSON.parse(raw); stand.registered.push(body); return send(201, { client_id: `client-${stand.registered.length}`, redirect_uris: body.redirect_uris }); }
  if (url.pathname === "/authorize") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(`<!doctype html><title>Stripe</title><h1>Allow Toolroll to use your Stripe account?</h1><form method="get" action="/allow">${[...url.searchParams].map(([k, v]) => `<input type="hidden" name="${k}" value="${v.replace(/"/g, "&quot;")}">`).join("")}<button>Allow</button></form>`);
  }
  if (url.pathname === "/allow") {
    const code = randomBytes(12).toString("hex");
    stand.codes.set(code, { challenge: url.searchParams.get("code_challenge"), redirect: url.searchParams.get("redirect_uri"), resource: url.searchParams.get("resource") });
    const back = new URL(url.searchParams.get("redirect_uri")); back.searchParams.set("code", code); back.searchParams.set("state", url.searchParams.get("state"));
    response.writeHead(302, { location: back.toString() }); return response.end();
  }
  if (url.pathname === "/token") {
    const form = new URLSearchParams(raw); stand.grants.push(Object.fromEntries(form));
    const issue = () => { const access = `at-${randomBytes(6).toString("hex")}`, refresh = `rt-${randomBytes(6).toString("hex")}`; stand.live.add(access); stand.refresh.set(refresh, true); return send(200, { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 120 }); };
    if (form.get("grant_type") === "authorization_code") {
      const held = stand.codes.get(form.get("code")); stand.codes.delete(form.get("code"));
      if (held === undefined || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== held.challenge || form.get("redirect_uri") !== held.redirect || form.get("resource") !== `${standBase}/mcp`) return send(400, { error: "invalid_grant" });
      return issue();
    }
    if (form.get("grant_type") === "refresh_token" && stand.refresh.has(form.get("refresh_token"))) return issue();
    return send(400, { error: "invalid_grant" });
  }
  send(404, {});
});
await new Promise(done => standIn.listen(stand.port, "127.0.0.1", done));

// A stand-in identity provider on this computer (OpenID Connect): discovery, its keys, a sign-in page with
// one button per person, and an ID token signed with its key for the nonce the console asked with.
const idp = { port: await freePort(), keys: generateKeyPairSync("rsa", { modulusLength: 2048 }), codes: new Map() };
const idpBase = `http://127.0.0.1:${idp.port}`;
const idpPeople = { priya: { sub: "idp-priya", email: "priya@acme.example", groups: ["eng-leads"] }, sam: { sub: "idp-sales", email: "sales@acme.example", groups: ["sales"] } };
const idpServer = createHttpServer(async (request, response) => {
  const url = new URL(request.url, idpBase);
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const send = (status, body, type = "application/json") => { response.writeHead(status, { "content-type": type }); response.end(typeof body === "string" ? body : JSON.stringify(body)); };
  if (url.pathname === "/.well-known/openid-configuration") return send(200, { issuer: idpBase, authorization_endpoint: `${idpBase}/authorize`, token_endpoint: `${idpBase}/token`, jwks_uri: `${idpBase}/keys` });
  if (url.pathname === "/keys") return send(200, { keys: [{ ...idp.keys.publicKey.export({ format: "jwk" }), kid: "e2e", use: "sig" }] });
  if (url.pathname === "/authorize") {
    const buttons = Object.keys(idpPeople).map(who => `<a href="/choose?who=${who}&${url.searchParams.toString().replace(/"/g, "&quot;")}">Sign in as ${who}</a>`).join(" ");
    return send(200, `<!doctype html><title>Acme SSO</title><h1>Acme SSO</h1>${buttons}`, "text/html; charset=utf-8");
  }
  if (url.pathname === "/choose") {
    const code = randomBytes(12).toString("hex");
    idp.codes.set(code, { who: url.searchParams.get("who"), nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge") });
    const back = new URL(url.searchParams.get("redirect_uri")); back.searchParams.set("code", code); back.searchParams.set("state", url.searchParams.get("state"));
    response.writeHead(302, { location: back.toString() }); return response.end();
  }
  if (url.pathname === "/token") {
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const held = idp.codes.get(form.get("code")); idp.codes.delete(form.get("code"));
    if (held === undefined || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== held.challenge) return send(400, { error: "invalid_grant" });
    const person = idpPeople[held.who], now = Math.floor(Date.now() / 1000);
    const part = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const data = `${part({ alg: "RS256", kid: "e2e" })}.${part({ iss: idpBase, aud: "so-e2e", sub: person.sub, email: person.email, groups: person.groups, nonce: held.nonce, iat: now, exp: now + 300, auth_time: now })}`;
    return send(200, { id_token: `${data}.${signWith("sha256", Buffer.from(data), idp.keys.privateKey).toString("base64url")}`, token_type: "Bearer" });
  }
  send(404, {});
});
await new Promise(done => idpServer.listen(idp.port, "127.0.0.1", done));

const w = await world(group === null ? "app" : `app-${group}`, {
  groups: GROUPS,
  env: { TOOLROLL_TEST_CONNECT: `stripe|Stripe|${standBase}/mcp`, ...(mailCert === null ? {} : { NODE_EXTRA_CA_CERTS: mailCert }) },
  seed: repo => {
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts", "size.py"), "import json, sys\ncard = json.load(sys.stdin)['card']\nprint(f\"{card['title']} looks {'big' if 'Acme' in card['title'] else 'small'}\")\nprint('goto: Big' if 'Acme' in card['title'] else 'goto: Small')\n");
    writeFileSync(join(repo, "README.md"), "# Shop\n\nA tiny shop library. `add` lives in src/math.js.\n");
  },
});
const { base, page, cli, rows, check, shot, json, signIn, askLead, pendingCard, confirmCard, auth, repo, script } = w;
/** A wait on a condition. In a scripted run it looks at least every half second: the scripted model answers at once and
 * the worker wakes on every change, so a look every 3 or 5 seconds only adds its own delay. A real-model run keeps each
 * wait's own pace. */
const until = (what, test, options = {}) => w.until(what, test, w.scripted ? { ...options, everyMs: Math.min(options.everyMs ?? 1500, 500) } : options);
/** A page that has settled: laid out (two frames), and any finite animation it started finished (never mid-fade). The
 * no-script fallback's delayed reveal (so-fallback-in, workspace.css) isn't one: once the workspace renders it only holds
 * back the toasts' empty region for 1.2 s. */
const settle = on => on.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  .then(() => Promise.race([
    Promise.all(document.getAnimations().filter(one => one.effect?.getComputedTiming().iterations !== Infinity && one.animationName !== "so-fallback-in").map(one => one.finished.catch(() => undefined))),
    new Promise(done => setTimeout(done, 2000)),
  ]))).catch(() => undefined);
/**
 * alex on a phone (390 × 844), signed in once per group and kept: each journey that looks at a page on a phone takes it in
 * the colour scheme it asks for, and leaves it on a blank page (no live page left streaming behind the next journey).
 */
let phonePage = null;
async function alexPhone(colorScheme = "light") {
  if (phonePage === null || phonePage.isClosed()) phonePage = await signIn("alex", { width: 390, height: 844 }, colorScheme);
  await phonePage.emulateMedia({ colorScheme });
  return phonePage;
}
const putPhoneDown = async () => { await phonePage?.goto("about:blank").catch(() => undefined); };
/** A journey in its group (or groups), scripted or real-model: it runs when one of them (or every group) runs and the run
 * takes its mode, and what it needs is in each of them (e2e-kit.mjs checks the catalogue against GROUPS). */
function journey(name, mode, title, needs, body) {
  return check(title, needs, body, { mode, groups: [name].flat() });
}
const flowView = id => json(`/flows/${id}?format=json`);
const csrfOf = async on => on.locator('input[name="csrf"]').first().inputValue();
const post = async (path, form, on = page) => {
  const answer = await on.request.post(`${base}${path}`, { form: { csrf: await csrfOf(on), ...form }, headers: { accept: "application/json", origin: base }, maxRedirects: 0 });
  return { status: answer.status(), body: await answer.text() };
};
/** A flow drawn from steps the way the canvas saves one. */
async function newFlow(name, stages, start) {
  // Flows → New → a template's page: name it, then create what it previews.
  await page.goto(`${base}/flows/new/blank`);
  await page.fill('form[data-gallery-use] input[name="name"]', name);
  await Promise.all([page.waitForNavigation(), page.click('form[data-gallery-use] button[value="create"]')]);
  const id = Number(/\/flows\/(\d+)/.exec(page.url())[1]);
  const view = await flowView(id);
  const saved = await post(`/flows/${id}/save`, { name, owner: "alex", revision: String(view.flow.revision), definition: JSON.stringify({ version: 1, start, stages }) });
  if (saved.status !== 200) throw new Error(`the drawing wasn't saved: ${saved.body}`);
  await page.goto(`${base}/flows/${id}`); await page.waitForSelector("[data-zone]");
  return id;
}
const zone = (x, y = 0) => ({ x, y, w: 260, h: 300, color: "blue" });
const none = { instructions: null, planning: null, approver: null, message: null, close: null, script: null, sort: null };
async function addCard(title, details) {
  await page.click('button:has-text("New card")');
  await page.fill('input[aria-label="Title"]', title);
  if (details) await page.fill('textarea[aria-label="Details"]', details);
  await page.click('button:has-text("Add card")');
  // The card is on the canvas before anything else happens: the canvas re-renders live as a teammate moves cards, and a
  // click in the middle of that re-render can miss (gate run 2059: the second of three cards in a row).
  await page.locator("[data-card]", { hasText: title }).first().waitFor({ timeout: 30_000 });
}

// ------------------------------------------------------------------ the console itself

await journey("console", SCRIPTED, "A wrong password is refused, and a signed-out visitor is sent to sign in", [], async () => {
  const wrong = await w.browser.newContext();
  const stranger = await wrong.newPage();
  await stranger.goto(`${base}/login`);
  await stranger.fill('input[name="name"]', "alex"); await stranger.fill('input[name="token"]', "not-the-password");
  await Promise.all([stranger.waitForLoadState("load"), stranger.press('input[name="token"]', "Enter")]);
  if (!stranger.url().includes("/login")) throw new Error(`a wrong password got in: ${stranger.url()}`);
  if ((await stranger.locator(".login-brand .so-brand-mark").count()) !== 1) throw new Error("the sign-in page doesn't carry the brand");
  const text = (await stranger.locator("body").innerText()).toLowerCase();
  if (!/password|sign in|didn't|not/.test(text)) throw new Error(`no refusal shown: ${text.slice(0, 200)}`);
  const locked = await stranger.request.get(`${base}/flows`, { maxRedirects: 0 });
  if (locked.status() !== 303 && locked.status() !== 302 && locked.status() !== 401) throw new Error(`a signed-out visitor got ${locked.status()} for /flows`);
  await wrong.close();
});

await journey("pages", SCRIPTED, "Every main page opens without an error, in the one workspace look, on desktop and on a phone", [], async () => {
  const paths = ["/chat", "/work", "/tasks", "/tasks/new", "/projects", "/flows", `/settings/knowledge?repo=${encodeURIComponent(repo)}`, "/settings", "/settings/models", "/settings/skills", `/settings/tools?repo=${encodeURIComponent(repo)}`, "/routines", "/recipes",
    "/inbox", "/board", "/next", "/done", "/system", "/workbench", "/code", "/kits", "/teammates", "/fleet", "/people"];
  const broken = [];
  const phone = await signIn("sam", { width: 390, height: 844 }, "dark");
  for (const path of paths) {
    for (const [who, on] of [["desktop", page], ["phone", phone]]) {
      const answer = await on.goto(`${base}${path}`);
      if (answer === null || answer.status() >= 400) { broken.push(`${who} ${path}: ${answer?.status()}`); continue; }
      // Live pages keep a stream open, so the network never goes quiet: wait for the workspace to render and settle instead.
      await on.waitForLoadState("load");
      await on.locator("[data-workspace-shell]").waitFor({ state: "attached", timeout: 5_000 }).catch(() => undefined);
      await settle(on);
      // Every signed-in page is inside the workspace: one navigation, one look.
      if (!(await on.evaluate(() => document.querySelector("[data-workspace-shell]") !== null))) { broken.push(`${who} ${path}: not in the workspace look`); continue; }
      // No page scrolls sideways on a phone.
      if (who === "phone") {
        const wide = await on.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (wide > 2) broken.push(`phone ${path}: scrolls sideways by ${wide}px`);
      }
    }
  }
  // A page that doesn't exist is still a page in the workspace, not bare text.
  const missing = await page.goto(`${base}/no-such-page`);
  await page.locator("[data-workspace-shell]").waitFor({ state: "attached", timeout: 5_000 }).catch(() => undefined);
  await settle(page);
  if (missing?.status() !== 404 || !(await page.evaluate(() => document.querySelector("[data-workspace-shell]") !== null)) || !/Not found/.test(await page.locator("h1").last().innerText())) broken.push("a missing page isn't a workspace page saying Not found");
  await phone.context().close();
  w.openPages.splice(w.openPages.indexOf(phone), 1);
  if (broken.length > 0) throw new Error(broken.join("; "));
  return { pages: paths.length * 2 + 1 };
});

await journey("console", SCRIPTED, "Sign-in hardening and the audit trail: five wrong passwords lock a name, and its sign-ins and a policy change (with what changed) are in the action ledger and its CSV; /healthz answers", [], async () => {
  // A throwaway account, so the lock touches no one else's checks.
  const casey = `casey-${randomBytes(3).toString("hex")}`, secret = `casey-${randomBytes(8).toString("hex")}`;
  cli(["approver", "add", casey, "--password", secret, ...auth]);
  const context = await w.browser.newContext();
  const guest = await context.newPage();
  const tryPassword = async attempt => {
    await guest.goto(`${base}/login`);
    await guest.fill('input[name="name"]', casey); await guest.fill('input[name="token"]', attempt);
    await Promise.all([guest.waitForLoadState("load"), guest.press('input[name="token"]', "Enter")]);
    return (await guest.locator("body").innerText()).replace(/\s+/g, " ");
  };
  for (let i = 0; i < 5; i++) await tryPassword("not-the-password");
  const locked = await tryPassword(secret);
  if (!/Too many wrong passwords\. Try again in 15 minutes\./.test(locked) || !guest.url().includes("/login")) throw new Error(`the right password after five wrong ones: ${locked.slice(0, 200)}`);
  await context.close();
  // A policy change, the way Settings makes it, and back.
  await page.goto(`${base}/settings`);
  for (const mode of ["bypassPermissions", "auto"]) {
    const changed = await page.request.post(`${base}/settings/permission-default`, { form: { csrf: await csrfOf(page), "permission-mode": mode }, headers: { origin: base }, maxRedirects: 0 });
    if (changed.status() !== 303) throw new Error(`the permission default refused ${mode}: ${changed.status()}`);
  }
  await page.goto(`${base}/ledger?source=sign-in`); await page.waitForSelector("[data-ledger-id]");
  const signIns = (await page.locator(".ledger-list").innerText()).replace(/\s+/g, " ");
  if (!signIns.includes(casey) || !/account locked/.test(signIns) || !/5 wrong passwords in a row; locked for 15 minutes/.test(signIns)) throw new Error(`the sign-in events: ${signIns.slice(0, 300)}`);
  await page.goto(`${base}/ledger?source=policy`); await page.waitForSelector("[data-ledger-id]");
  const policy = (await page.locator(".ledger-list").innerText()).replace(/\s+/g, " ");
  if (!/permission default changed/.test(policy) || !policy.includes("Auto → Full access") || !policy.includes("Full access → Auto")) throw new Error(`the policy events: ${policy.slice(0, 300)}`);
  await shot("ledger-policy");
  const csv = await (await page.request.get(`${base}/ledger?format=csv&source=policy`)).text();
  if (!csv.split("\r\n")[0].includes('"Detail"') || !csv.includes("Auto → Full access")) throw new Error(`the CSV: ${csv.slice(0, 300)}`);
  const health = await page.request.get(`${base}/healthz`);
  if (health.status() !== 200 || (await health.json()).status !== "ok") throw new Error(`/healthz: ${health.status()}`);
  return { locked: casey };
});

await journey("console", SCRIPTED, "Sessions and API tokens: a read token made in Settings is shown once on a page with no script, a script reads with it but can't file work, and once revoked it names no one; this browser is in the sessions list", [], async () => {
  await page.goto(`${base}/settings/sessions`);
  await page.waitForSelector("[data-session]");
  if (!/This browser/.test(await page.locator(".credentials").innerText())) throw new Error("the sessions list doesn't mark this browser");
  await page.evaluate(() => document.querySelectorAll(".credentials details").forEach(one => { one.open = true; }));
  await page.fill('.create input[name="name"]', "e2e-dashboard");
  await page.selectOption('.create select[name="access"]', "read");
  await page.fill('.create input[name="password"]', w.passwords.alex);
  await Promise.all([page.waitForNavigation(), page.click('.create button:has-text("Make the token")')]);
  if ((await page.locator("script").count()) !== 0) throw new Error("the page showing the token carries a script");
  const token = (await page.locator(".secret-value").innerText()).trim();
  if (!/^so_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error(`the token: ${token.slice(0, 12)}…`);
  await shot("api-token-shown");
  const headers = { authorization: `Bearer ${token}` };
  const reads = await fetch(`${base}/ledger?format=json`, { headers, redirect: "manual" });
  if (reads.status !== 200) throw new Error(`a read with the token: ${reads.status}`);
  const writes = await fetch(`${base}/tasks/add`, { method: "POST", headers, body: new URLSearchParams({ title: "from a read token", repo }), redirect: "manual" });
  if (writes.status !== 403) throw new Error(`a read token filed work: ${writes.status}`);
  await page.goto(`${base}/settings/sessions`);
  await Promise.all([page.waitForNavigation(), page.locator('[data-token] button:has-text("Revoke")').first().click()]);
  const after = await fetch(`${base}/ledger?format=json`, { headers, redirect: "manual" });
  if (after.status !== 303) throw new Error(`the revoked token still answers: ${after.status}`);
  if (rows("SELECT 1 FROM action_ledger WHERE action = 'API token revoked: e2e-dashboard'").length !== 1) throw new Error("the revocation isn't in the ledger");
  await shot("sessions-and-tokens");
  return { token: "revoked" };
});

const APPROVAL_RULES = "Approval rules: with 'someone other than the requester' on, the task alex filed can't be approved by alex; sam approves it, and the task says who filed it";
await journey("console", SCRIPTED, APPROVAL_RULES, [], async () => {
  await page.goto(`${base}/settings/approval?repo=${encodeURIComponent(repo)}`);
  await page.locator('.approval-rules input[name="not_requester"]').check();
  await page.locator('.approval-rules input[name="password"]').fill(w.passwords.alex);
  await Promise.all([page.waitForNavigation(), page.locator('.approval-rules button[type="submit"]').click()]);
  if (!/Saved\./.test(await page.locator(".approval-rules").innerText())) throw new Error(`the rules weren't saved: ${(await page.locator("body").innerText()).slice(0, 300)}`);
  const id = "e2e-rules";
  try {
    const filed = await post("/tasks/add", { id, title: "Rename the helper in src/math.js", repo, "planning-policy": "choice" });
    if (filed.status >= 400) throw new Error(`filing: ${filed.status} ${filed.body.slice(0, 200)}`);
    if (rows(`SELECT filed_by FROM task_ref WHERE external_id = '${id}'`)[0]?.filed_by !== "alex") throw new Error("the task doesn't record who filed it");
    cli(["task", "hold", id, "--reason", "e2e: approval rules only", ...auth]);
    cli(["task", "scope", id, "--goal", "Rename the helper in src/math.js.", "--acceptance", "the helper is renamed|check", ...auth]);
    await page.goto(`${base}/t/${id}`);
    const review = page.locator("summary", { hasText: /Approve plan|Review plan|Updated approval terms/ }).first();
    if (await review.count() > 0) await review.click();
    const form = page.locator("form#approve");
    await form.waitFor({ timeout: 15_000 });
    await form.locator('input[name="token"]').fill(w.passwords.alex);
    await Promise.all([page.waitForNavigation(), form.locator("button").first().click()]);
    if (!/You filed this task/.test(await page.locator("body").innerText())) throw new Error(`alex's own approval wasn't refused: ${(await page.locator("body").innerText()).slice(0, 300)}`);
    if (rows(`SELECT approved_by FROM task_scope WHERE task_id = '${id}'`)[0]?.approved_by) throw new Error("alex approved their own task");
    await shot("approval-rules-refused");
    const digest = cli(["task", "show", id]).scope.digest;
    cli(["task", "approve", id, "--yes", "--digest", digest, "--as", "sam", "--token", w.passwords.sam]);
    if (rows(`SELECT approved_by FROM task_scope WHERE task_id = '${id}'`)[0]?.approved_by !== "sam") throw new Error("sam's approval didn't seal it");
    return { filedBy: "alex", approvedBy: "sam" };
  } finally {
    cli(["task", "state", id, "cancelled", "--reason", "e2e: approval rules only"]);
    cli(["project", "rules", "--repo", repo, "--not-requester", "off", ...auth]);
  }
});

// The evidence pack it reads is of the task the approval rules journey filed.
await journey("console", SCRIPTED, "Audit: the ledger chain verifies, a checkpoint made on the ledger page verifies from the command line, and the task's evidence pack names who filed and who approved it", [APPROVAL_RULES], async () => {
  await page.goto(`${base}/ledger`);
  if (await page.locator('[data-ledger-chain="ok"]').count() !== 1) throw new Error(`the chain: ${(await page.locator(".ledger-chain-panel").innerText()).slice(0, 200)}`);
  await Promise.all([page.waitForNavigation(), page.locator('.ledger-checkpoint-form button').click()]);
  const checkpoint = (await page.locator(".ledger-checkpoint-value").innerText()).trim();
  if (!/^\d+:[0-9a-f]{64}$/.test(checkpoint)) throw new Error(`the checkpoint: ${checkpoint.slice(0, 80)}`);
  const verified = cli(["ledger", "verify", "--checkpoint", checkpoint]);
  if (verified.ok !== true || verified.outside?.ok !== true) throw new Error(`ledger verify: ${JSON.stringify(verified).slice(0, 300)}`);
  await shot("ledger-chain");
  const id = "e2e-rules";
  await page.goto(`${base}/t/${id}`);
  await Promise.all([page.waitForNavigation(), page.locator(`a[href="/t/${id}/evidence"]`).first().click()]);
  const pack = page.locator(`[data-evidence-pack="${id}"]`);
  await pack.waitFor({ timeout: 15_000 });
  if (await pack.locator("script").count() !== 0) throw new Error("the evidence pack carries a script");
  const text = await pack.innerText();
  if (!/Filed[\s\S]*alex/.test(text) || !/Approved[\s\S]*sam/.test(text)) throw new Error(`the pack page: ${text.slice(0, 400)}`);
  await shot("evidence-pack");
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error("the evidence pack scrolls sideways on a phone");
  await shot("evidence-pack-phone");
  await page.setViewportSize({ width: 1440, height: 900 });
  const download = await page.request.get(`${base}/t/${id}/evidence?format=json`);
  const json = await download.json();
  if (json.versions?.[0]?.filedBy?.name !== "alex" || json.versions?.[0]?.scope?.approved?.by !== "sam" || json.ledger?.chain?.ok !== true) throw new Error(`the pack JSON: ${JSON.stringify(json).slice(0, 300)}`);
  if (!json.ledger.entries.every(one => one.seal !== null)) throw new Error("an entry in the pack isn't sealed");
  const fromCli = cli(["task", "evidence", id]);
  if (fromCli.pack?.versions?.[0]?.scope?.approved?.by !== "sam") throw new Error("task evidence on the command line");
  return { checkpoint: checkpoint.split(":")[0], entries: json.ledger.entries.length };
});

await journey("console", SCRIPTED, "Monitoring: a webhook set in Settings gets the audit stream, signed with the secret shown once; /metrics answers an operator", [], async () => {
  const got = [];
  const receiver = createHttpServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => { got.push({ signature: String(request.headers["x-standing-orders-signature"] ?? ""), body }); response.end(); });
  });
  const port = await freePort();
  await new Promise(resolve => receiver.listen(port, "127.0.0.1", resolve));
  try {
    await page.goto(`${base}/settings/monitoring`);
    await page.fill('.monitoring input[name="webhook"]', `http://127.0.0.1:${port}/audit`);
    await page.fill('.monitoring input[name="password"]', w.passwords.alex);
    await Promise.all([page.waitForNavigation(), page.locator('.monitoring button[type="submit"]').click()]);
    if ((await page.locator("script").count()) !== 0) throw new Error("the page showing the signing secret carries a script");
    const secret = (await page.locator(".secret-value").innerText()).trim();
    if (!/^whsec_[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error(`the signing secret: ${secret.slice(0, 12)}…`);
    await until("the webhook to receive the audit stream", () => got.length > 0, { timeoutMs: 30_000 });
    const [first] = got;
    const [t, v1] = first.signature.split(",").map(part => part.split("=")[1]);
    const expected = (await import("node:crypto")).createHmac("sha256", secret).update(`${t}.${first.body}`).digest("hex");
    if (v1 !== expected) throw new Error("the delivery's signature doesn't match the secret shown");
    const events = JSON.parse(first.body).events;
    if (!Array.isArray(events) || events.length === 0 || !events.every(one => one.seal?.hash?.length === 64)) throw new Error(`the events: ${first.body.slice(0, 200)}`);
    await page.goto(`${base}/settings/monitoring`);
    await page.locator('[data-monitoring="webhook"][data-state="ok"]').waitFor({ timeout: 15_000 });
    await shot("monitoring");
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error("the Monitoring page scrolls sideways on a phone");
    await shot("monitoring-phone");
    await page.setViewportSize({ width: 1440, height: 900 });
    const metrics = await page.request.get(`${base}/metrics`);
    const text = await metrics.text();
    if (metrics.status() !== 200 || !/toolroll_ledger_chain_ok 1/.test(text) || !/toolroll_monitoring_lag_entries\{destination="webhook"\}/.test(text)) throw new Error(`/metrics: ${metrics.status()} ${text.slice(0, 300)}`);
    if (rows("SELECT 1 FROM action_ledger WHERE action = 'monitoring changed'").length !== 1) throw new Error("the change isn't in the ledger");
    return { events: events.length };
  } finally {
    // Turn it off again, so later checks don't stream.
    await page.goto(`${base}/settings/monitoring`);
    await page.fill('.monitoring input[name="webhook"]', "");
    await page.fill('.monitoring input[name="password"]', w.passwords.alex);
    await Promise.all([page.waitForNavigation(), page.locator('.monitoring button[type="submit"]').click()]);
    await new Promise(resolve => receiver.close(resolve));
  }
});

await journey("console", SCRIPTED, "Spend: the month's cost shows by project and person; a budget set on the Spend page is listed, and the month downloads as CSV", [], async () => {
  await page.goto(`${base}/spend`);
  await page.locator(".spend-total").waitFor({ timeout: 15_000 });
  const add = page.locator("details", { hasText: "Add a budget" });
  if (!(await add.evaluate(one => one.open))) await add.locator("summary").click();
  await add.locator('select[name="target"]').selectOption({ label: "Everything" });
  await add.locator('input[name="usd"]').fill("500");
  await add.locator('input[name="password"]').fill(w.passwords.alex);
  await Promise.all([page.waitForNavigation(), add.locator('button[type="submit"]').click()]);
  const budget = page.locator(".budget").first();
  if (!/Everything|whole installation/i.test(await budget.innerText()) || !/\$500/.test(await budget.innerText())) throw new Error(`the budget: ${(await page.locator(".spend").innerText()).slice(0, 400)}`);
  if (rows("SELECT 1 FROM budget WHERE scope_kind = 'installation' AND removed_at IS NULL").length !== 1) throw new Error("the budget isn't kept");
  await shot("spend");
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error("the Spend page scrolls sideways on a phone");
  await shot("spend-phone");
  await page.setViewportSize({ width: 1440, height: 900 });
  const csv = await page.request.get(`${base}/spend?format=csv`);
  if (csv.status() !== 200 || !(await csv.text()).includes("time_utc,kind,project,person")) throw new Error(`the CSV: ${csv.status()}`);
  // Tasks folds usage to one line on a desk; a click shows the budget as a tile, and, once Claude has run here, the plan's windows as Claude said them.
  await page.goto(`${base}/work`);
  await page.locator('[data-usage-summary]').click({ timeout: 15_000 });
  await page.locator('[data-limit^="budget:"]').first().waitFor({ timeout: 15_000 });
  const claudeRan = rows("SELECT 1 FROM run WHERE provider = 'claude' AND tokens_in IS NOT NULL LIMIT 1").length > 0;
  if (claudeRan && await page.locator('[data-limit^="claude:"]').count() === 0) throw new Error(`Claude ran but Tasks shows no Claude window: ${JSON.stringify(rows("SELECT * FROM provider_limit"))}`);
  await shot("limits");
  // Leave nothing that could hold later checks' work back.
  cli(["budget", "remove", "--all", ...auth]);
  return { budget: "$500 a month" };
});

await journey("console", SCRIPTED, "The command line answers: the task list, the approvers, the project's check, and help", [], async () => {
  const list = cli(["task", "list"]);
  const people = cli(["approver", "list"]);
  const verify = cli(["verify", "show", "--repo", repo], { json: false });
  const help = execFileSync(process.execPath, [w.bin, "--help"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  if (list === null || typeof list !== "object") throw new Error("task list didn't answer as JSON");
  if (!JSON.stringify(people).includes("sam")) throw new Error(`the approvers: ${JSON.stringify(people).slice(0, 200)}`);
  if (!/npm test/.test(verify)) throw new Error(`the project's check: ${verify.slice(0, 200)}`);
  if (!/task/.test(help)) throw new Error("help doesn't mention tasks");
  if (!/^toolroll — /.test(help) || !/toolroll task add/.test(help)) throw new Error(`help doesn't name the toolroll command: ${help.slice(0, 200)}`);
});

// ------------------------------------------------------------------ a task, from an idea to an accepted result

const refOf = id => rows(`SELECT id, plan FROM task_ref WHERE external_id = '${id}'`)[0];
const latestBuild = id => rows(`SELECT r.id, r.outcome, r.finished_at FROM run r JOIN task_ref t ON t.id = r.task_ref WHERE t.external_id = '${id}' AND r.role = 'builder' ORDER BY r.id DESC LIMIT 1`)[0];
const taskState = id => rows(`SELECT state FROM task WHERE id = '${id}'`)[0]?.state;
/** The planner's attempts on a task so far, in words: "run 3 failed (repair agent exit 1), run 4 …". */
const plannerRuns = id => rows(`SELECT r.id, r.outcome, r.reason FROM run r JOIN task_ref t ON t.id = r.task_ref WHERE t.external_id = '${id}' AND r.role = 'planner' ORDER BY r.id`)
  .map(one => `run ${one.id} ${one.outcome ?? "running"}${one.reason ? ` (${one.reason})` : ""}`).join(", ") || "none yet";
// The worker gives a failed planning attempt two more tries, 1 then 2 minutes apart (claim.ts PLAN_BACKOFF_MS), and one
// attempt can take a few minutes with its structured repair: the wait fits all three, and ends early once planning is held
// for a person (every attempt failed, or an answer failed validation), since nothing more comes then.
const PLANNER_MS = 3 * REAL_TURN_MS;
async function plannerDrafted(id, what, ready = ref => ref?.plan === "drafted") {
  return until(what, async () => {
    const ref = refOf(id);
    if (ready(ref)) return ref;
    const held = rows(`SELECT i.kind FROM incident i JOIN run r ON r.id = i.run JOIN task_ref t ON t.id = r.task_ref WHERE t.external_id = '${id}' AND r.role = 'planner' AND i.resolved_at IS NULL`)[0];
    if (held !== undefined) throw new GiveUp(`planning is held for a person (${held.kind}); planner attempts: ${plannerRuns(id)}`);
    return null;
  }, { timeoutMs: PLANNER_MS, everyMs: 5000, seen: () => `plan ${refOf(id)?.plan ?? "missing"}; planner attempts: ${plannerRuns(id)}` });
}
/** Approve a task's scope on its page: open the plan, type the password again, approve. */
async function approveOnPage(id) {
  await page.goto(`${base}/t/${id}`);
  const review = page.locator("summary", { hasText: /Approve plan|Review plan|Updated approval terms/ }).first();
  if (await review.count() > 0) await review.click();
  const form = page.locator("form#approve");
  await form.waitFor({ timeout: 15_000 });
  await form.locator('input[name="token"]').fill(w.passwords.alex);
  await Promise.all([page.waitForNavigation(), form.locator("button").first().click()]);
  const approved = rows(`SELECT approved_by FROM task_scope WHERE task_id = '${id}'`)[0];
  if (approved?.approved_by !== "alex") throw new Error(`${id} wasn't approved: ${(await page.locator("body").innerText()).slice(0, 300)}`);
}
/** Wait for a task's build to finish with its checks passed; returns the run. */
async function builtAndChecked(id, timeoutMs = 600_000) {
  const run = await until(`${id} to be built`, async () => { const one = latestBuild(id); return one?.finished_at ? one : null; }, { timeoutMs, everyMs: 5000 });
  if (run.outcome !== "built") throw new Error(`${id}'s build ended ${run.outcome}`);
  await until(`${id} to be done`, async () => taskState(id) === "done", { timeoutMs: 180_000, everyMs: 3000 });
  return run;
}

/** What a scripted build of the math tasks writes: subtract, then its negative case, then multiply. */
function mathFiles({ negative = false, multiply = false } = {}) {
  return {
    "src/math.js": ["export const add = (a, b) => a + b;", "export const subtract = (a, b) => a - b;", ...(multiply ? ["export const multiply = (a, b) => a * b;"] : []), ""].join("\n"),
    "test/math.test.js": ["import test from 'node:test';", "import assert from 'node:assert/strict';", `import { add, subtract${multiply ? ", multiply" : ""} } from '../src/math.js';`, "",
      "test('adds', () => assert.equal(add(2, 3), 5));", "test('subtracts', () => {", "  assert.equal(subtract(5, 2), 3);", ...(negative ? ["  assert.equal(subtract(2, 5), -3);"] : []), "});",
      ...(multiply ? ["test('multiplies', () => assert.equal(multiply(3, 4), 12));"] : []), ""].join("\n"),
  };
}

let firstTask = null;
await journey("task", SCRIPTED, "File a task in the console; the planner (Claude) drafts its scope; approve it with your password", [], async () => {
  // The planner's scope comes from the title (the scripted provider's default plan); the build adds subtract. Briefs
  // carry random names (worktrees, digests), so each answer matches the exact words of its note.
  script({ role: "builder", when: [/subtract/], unless: [/subtract\(2, 5\) is -3/, /multiply\(a, b\)/], answer: { files: mathFiles(), conclusion: "Added subtract(a, b) to src/math.js, with a test." } });
  await page.goto(`${base}/chat`);
  await page.click("a.so-new-task");
  await page.waitForSelector('form[action="/tasks/add"]');
  // Just the words, as a person types them; "plan first" (on by default) has the planner write the scope.
  await page.fill('form[action="/tasks/add"] textarea[name="title"]', "Add a subtract function to src/math.js, with a test");
  await Promise.all([page.waitForNavigation(), page.click('form[action="/tasks/add"] button.task-submit')]);
  firstTask = /\/t\/([^/?#]+)/.exec(page.url())?.[1];
  if (!firstTask) throw new Error(`filing didn't open the task: ${page.url()}`);
  const planned = await plannerDrafted(firstTask, "the planner's scope", ref => ref?.plan === "drafted" && rows(`SELECT 1 FROM task_scope WHERE task_id = '${firstTask}'`).length > 0);
  const scope = rows(`SELECT goal FROM task_scope WHERE task_id = '${firstTask}'`)[0];
  if (!/subtract/i.test(scope.goal)) throw new Error(`the planner's goal: ${scope.goal}`);
  await approveOnPage(firstTask);
  await shot("task-approved");
  return { task: firstTask, plan: planned.plan, goal: scope.goal.slice(0, 160) };
});

await journey("task", SCRIPTED, "Claude builds it, the project's checks pass, and the result shows what changed; mark it complete", ["File a task in the console; the planner (Claude) drafts its scope; approve it with your password"], async () => {
  const run = await builtAndChecked(firstTask);
  const diff = execFileSync("git", ["-C", repo, "diff", "main", `refs/heads/${rows(`SELECT branch FROM run WHERE id = ${run.id}`)[0].branch}`, "--", "src/math.js"], { encoding: "utf8" });
  if (!/subtract/.test(diff)) throw new Error(`the build's branch doesn't add subtract: ${diff.slice(0, 300)}`);
  await page.goto(`${base}/review?result=${encodeURIComponent(firstTask)}&run=${run.id}`);
  const panel = page.locator("[data-result-panel]").first();
  await panel.waitFor({ timeout: 20_000 });
  // What a person sees: checks passed on the result, and the decision after the evidence says what accepting does
  // (plain Accept when every requirement is met; the planner may have left one for a person to check).
  const status = await page.locator('[data-result-status] [data-status-detail="checks"]').first().innerText();
  if (!/Passed/.test(status)) throw new Error(`the result's checks say: ${status.slice(0, 200)}`);
  const checks = "passed";
  // A requirement the planner left for a person: each Looks right counts at once, and Accept waits on them.
  for (const looks of await page.locator("[data-check-item] button[data-looks-right]").all()) await looks.click();
  const decision = await page.locator("[data-result-decision]").first().innerText();
  if (!/^Accept (and finish|without checks)$/m.test(decision) || !/Finishes the task/.test(decision)) throw new Error(`the decision says: ${decision.slice(0, 200)}`);
  await page.locator('a[data-result-tab="changes"]').click();
  await until("the changed files", async () => /src\/math\.js/.test(await page.locator("body").innerText()), { timeoutMs: 10_000, everyMs: 500 });
  await shot("result-changes");
  // Accept and finish: one request accepts and completes it; no Mark complete follows.
  const posts = [];
  const counted = request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); };
  page.on("request", counted);
  await Promise.all([page.waitForNavigation(), page.locator(`[data-result-decision] form[action="/t/${firstTask}/complete"] button[data-accept-result]`).click()]);
  page.off("request", counted);
  if (posts.length !== 1 || posts[0] !== `/t/${firstTask}/complete`) throw new Error(`accepting took ${posts.length} requests: ${posts.join(", ")}`);
  await until("the result to read complete", async () => (await page.locator('[data-result-status="assignment-complete"]').count()) > 0, { timeoutMs: 15_000, everyMs: 500 });
  const ledger = rows(`SELECT action, source FROM action_ledger WHERE task_id = '${firstTask}' AND action = 'assignment handoff checked'`);
  if (ledger.length !== 1) throw new Error(`the ledger has ${ledger.length} completion rows`);
  return { run: run.id, checks };
});

/** On a result page, send the work back with a note; returns the new revision's id once the planner has updated its plan. */
async function sendBack(id, note) {
  const run = latestBuild(id);
  await page.goto(`${base}/review?result=${encodeURIComponent(id)}&run=${run.id}`);
  await page.locator('a[href="#request-changes"]').first().click();
  const box = page.locator('#comment-form textarea[name="note"]');
  await box.waitFor({ timeout: 10_000 });
  await box.fill(note);
  await Promise.all([page.waitForNavigation(), page.locator("button[data-request-changes]").click()]);
  const child = new URL(page.url()).searchParams.get("version") ?? rows(`SELECT t.external_id AS id FROM task_ref t WHERE t.revision_of IS NOT NULL ORDER BY t.id DESC LIMIT 1`)[0]?.id;
  if (!child || child === id) throw new Error(`no revision was made: ${page.url()}`);
  if (refOf(child)?.plan !== "requested" && refOf(child)?.plan !== "drafted") throw new Error(`the revision wasn't sent to the planner: plan ${refOf(child)?.plan}`);
  if (!/Updating the plan/.test(await page.locator("body").innerText())) throw new Error("the task page doesn't say the plan is being updated");
  await plannerDrafted(child, "the planner's updated plan");
  return child;
}
const branchFile = (runId, file) => execFileSync("git", ["-C", repo, "show", `refs/heads/${rows(`SELECT branch FROM run WHERE id = ${runId}`)[0].branch}:${file}`], { encoding: "utf8" });

await journey("task", SCRIPTED, "Send it back with a note: the revision is approved again and rebuilt with the fix", ["Claude builds it, the project's checks pass, and the result shows what changed; mark it complete"], async () => {
  script(
    { role: "planner", when: [/subtract\(2, 5\) is -3/], unless: [/Also add multiply/], answer: { plan: { goal: "Add a subtract function to src/math.js, with a test that also checks a negative result: subtract(2, 5) is -3.", amendment: "The note asks the test to check a negative result." } } },
    { role: "builder", when: [/subtract\(2, 5\) is -3/], unless: [/multiply\(a, b\)/], answer: { files: mathFiles({ negative: true }), conclusion: "The subtract test also checks subtract(2, 5) is -3." } },
  );
  const revision = await sendBack(firstTask, "The subtract test should also check a negative result: subtract(2, 5) is -3.");
  await approveOnPage(revision);
  const built = await builtAndChecked(revision);
  const test = branchFile(built.id, "test/math.test.js");
  if (!/-3/.test(test)) throw new Error(`the revision's test doesn't check -3: ${test.slice(0, 400)}`);
  return { revision, run: built.id };
});

await journey("task", SCRIPTED, "Send it back asking for more than the plan allows: the planner adds it, you approve the change, and it's built", ["Send it back with a note: the revision is approved again and rebuilt with the fix"], async () => {
  script(
    { role: "planner", when: [/Also add multiply/], answer: { plan: {
      goal: "Add subtract to src/math.js, with a test that also checks subtract(2, 5) is -3, and add multiply(a, b) with its own test.",
      acceptance: [{ id: "c1", statement: "subtract(a, b) works, and its test checks subtract(2, 5) is -3", evidence: ["check"], how: null }, { id: "c2", statement: "multiply(a, b) returns a times b, with its own test", evidence: ["check"], how: null }],
      amendment: "The note asks for multiply(a, b) as well, which the earlier contract left out: added it with a criterion of its own." } } },
    { role: "builder", when: [/multiply\(a, b\)/], answer: { files: mathFiles({ negative: true, multiply: true }), conclusion: "Added multiply(a, b) with its own test; subtract stays." } },
  );
  const done = rows(`SELECT t.external_id AS id FROM task_ref t WHERE t.revision_of = '${firstTask}' ORDER BY t.id DESC LIMIT 1`)[0]?.id;
  const child = await sendBack(done, "Also add multiply(a, b), with its own test.");
  const scope = rows(`SELECT goal, acceptance_json FROM task_scope WHERE task_id = '${child}'`)[0];
  if (!/multiply/i.test(`${scope.goal}\n${scope.acceptance_json}`)) throw new Error(`the updated plan leaves multiply out: ${scope.goal.slice(0, 300)}`);
  // What a person reviews: the change to the plan and why, on desktop and on a phone.
  await page.goto(`${base}/t/${child}`);
  const review = page.locator("summary", { hasText: /Approve plan|Review plan|Updated approval terms/ }).first();
  if (await review.count() > 0) await review.click();
  const amended = page.locator("#contract-amendment");
  await amended.waitFor({ timeout: 15_000 });
  const reason = await amended.innerText();
  await amended.scrollIntoViewIfNeeded();
  await shot("plan-amended");
  const onPhone = await alexPhone("dark");
  await onPhone.goto(`${base}/t/${child}`);
  const phoneReview = onPhone.locator("summary", { hasText: /Approve plan|Review plan|Updated approval terms/ }).first();
  if (await phoneReview.count() > 0) await phoneReview.click();
  await onPhone.locator("#contract-amendment").scrollIntoViewIfNeeded();
  await onPhone.screenshot({ path: join(w.out, "plan-amended-phone.png") });
  const wide = await onPhone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await putPhoneDown();
  if (wide) throw new Error("the phone page scrolls sideways");
  await approveOnPage(child);
  const built = await builtAndChecked(child);
  const source = branchFile(built.id, "src/math.js");
  if (!/multiply/.test(source) || !/subtract/.test(source)) throw new Error(`the build doesn't keep subtract and add multiply: ${source.slice(0, 300)}`);
  return { revision: child, change: reason.replace(/\s+/g, " ").slice(0, 240), run: built.id };
});

await journey("builds", REAL_MODEL, "A build stops to ask a question the plan leaves open; you answer on the decision page and it carries on", [], async () => {
  const id = "round";
  cli(["task", "add", "Add a round2 function", "--id", id, "--repo", repo, ...auth]);
  cli(["task", "scope", id, "--goal", "Add round2(x) to src/math.js (round to 2 decimal places) with a test in test/math.test.js. Whether an exact half rounds up or to the nearest even digit is the operator's call and is not decided yet: before writing any code, stop and ask the operator with two options (half up, half to even), then build what they choose.", "--acceptance", "round2 follows the operator's answer, with a test|check", ...auth]);
  const digest = cli(["task", "show", id]).scope.digest;
  cli(["task", "approve", id, "--yes", "--digest", digest, ...auth]);
  const asked = await until("the builder's question", async () => rows(`SELECT d.id, d.question, d.run FROM decision d JOIN run r ON r.id = d.run JOIN task_ref t ON t.id = r.task_ref WHERE t.external_id = '${id}' AND d.state = 'open'`)[0], { timeoutMs: 600_000, everyMs: 5000 });
  await page.goto(`${base}/d/${asked.id}`);
  const options = page.locator(`form.option[action="/d/${asked.id}/answer"]`);
  await options.first().waitFor({ timeout: 15_000 });
  const labels = await options.locator('button[type="submit"]').allInnerTexts();
  const pick = labels.findIndex(one => /even/i.test(one));
  if (pick < 0) throw new Error(`no half-to-even option: ${labels.join(" | ")}`);
  await shot("decision");
  await Promise.all([page.waitForNavigation(), options.nth(pick).locator('button[type="submit"]').click()]);
  const answered = rows(`SELECT state, answered_by, answered_via FROM decision WHERE id = ${asked.id}`)[0];
  if (answered?.state !== "answered" || answered.answered_by !== "alex" || answered.answered_via !== "web") throw new Error(`the answer wasn't recorded: ${JSON.stringify(answered)}`);
  // The answer admits a fresh build; the parked one stays in the history.
  await until("the build after the answer", async () => (latestBuild(id)?.id ?? 0) > asked.run, { timeoutMs: 180_000, everyMs: 3000 });
  const built = await builtAndChecked(id);
  const source = branchFile(built.id, "src/math.js");
  if (!/round2/.test(source)) throw new Error(`the build doesn't add round2: ${source.slice(0, 300)}`);
  return { question: asked.question.slice(0, 160), answer: labels[pick].trim(), run: built.id };
});

await journey("stop", SCRIPTED, "Stop a build while it runs, then resume it with your password; it finishes", [], async () => {
  const id = "divide";
  // The first build runs until it is stopped; the resumed one finishes.
  script(
    { role: "builder", when: [/divide/], times: 1, answer: { delayMs: 15 * 60_000 } },
    { role: "builder", when: [/divide/], answer: { files: {
      "src/math.js": "export const add = (a, b) => a + b;\nexport const divide = (a, b) => { if (b === 0) throw new Error('division by zero'); return a / b; };\n",
      "test/math.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, divide } from '../src/math.js';\n\ntest('adds', () => assert.equal(add(2, 3), 5));\ntest('divides', () => assert.equal(divide(6, 3), 2));\ntest('refuses zero', () => assert.throws(() => divide(1, 0)));\n",
    }, conclusion: "Added divide(a, b), which throws on zero, with tests for both." } },
  );
  cli(["task", "add", "Add a divide function", "--id", id, "--repo", repo, ...auth]);
  cli(["task", "scope", id, "--goal", "Add divide(a, b) to src/math.js, throwing on division by zero, with tests for both in test/math.test.js.", "--acceptance", "divide works and refuses zero|check", ...auth]);
  const digest = cli(["task", "show", id]).scope.digest;
  cli(["task", "approve", id, "--yes", "--digest", digest, ...auth]);
  const running = await until("the build to start", async () => { const one = latestBuild(id); return one && !one.finished_at ? one : null; }, { timeoutMs: 180_000, everyMs: 1000 });
  await page.goto(`${base}/t/${id}`);
  const stop = page.locator("form.task-stop-form button");
  await stop.waitFor({ timeout: 15_000 });
  await Promise.all([page.waitForNavigation(), stop.click()]);
  await until("the task to be paused", async () => { await page.reload(); return (await page.locator('[data-task-control="paused"]').count()) > 0; }, { timeoutMs: 180_000, everyMs: 3000 });
  const stopped = rows(`SELECT requested_via, settlement FROM run_stop WHERE run = ${running.id}`)[0];
  if (stopped?.requested_via !== "web") throw new Error(`the stop: ${JSON.stringify(stopped)}`);
  await shot("task-paused");
  await page.evaluate(() => { for (const one of document.querySelectorAll("details")) one.open = true; });
  await Promise.all([page.waitForNavigation(), page.locator("form.task-resume-form button").click()]);
  const confirm = page.locator("form.resume-form");
  await confirm.waitFor({ timeout: 15_000 });
  await confirm.locator('input[name="token"]').fill(w.passwords.alex);
  await Promise.all([page.waitForNavigation(), confirm.locator("button").first().click()]);
  const resumed = rows(`SELECT resumed_by, resumed_via FROM run_stop WHERE run = ${running.id}`)[0];
  if (resumed?.resumed_by !== "alex") throw new Error(`the resume: ${JSON.stringify(resumed)}`);
  const built = await builtAndChecked(id);
  return { stopped: running.id, finished: built.id, settlement: stopped.settlement };
});

// ------------------------------------------------------------------ the lead

let leadChatOn = false;
async function turnLeadChatOn() {
  // Onboarding turned the lead on by itself and moved its form to Settings → Lead → Advanced.
  await page.goto(`${base}/settings/lead`);
  await page.locator("details[data-lead-advanced]").evaluate(el => { el.open = true; }).catch(() => undefined);
  await page.selectOption('form[action="/chat/config"] select[name="provider"]', "claude-subscription");
  await page.fill('form[action="/chat/config"] input[name="model"]', "sonnet");
  await page.fill('form[action="/chat/config"] input[name="token"]', w.passwords.alex);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/chat/config"] button[type="submit"]')]);
  await page.goto(`${base}/chat`);
  await page.waitForSelector("[data-workspace-composer] textarea", { timeout: 15_000 });
  leadChatOn = true;
}
await journey(["lead", "maya"], SCRIPTED, "Turn the lead chat on (first-run setup, with your password)", [], turnLeadChatOn);

await journey("lead", REAL_MODEL, "The lead answers a question about the project from its files (real Claude turn)", ["Turn the lead chat on (first-run setup, with your password)"], async () => {
  // The project's code index, refreshed the way Settings → Knowledge does, so the lead's project search reads a current one.
  await page.goto(`${base}/settings/knowledge?repo=${encodeURIComponent(repo)}`);
  const refreshed = await post("/settings/knowledge/refresh", { repo });
  if (refreshed.status !== 200) throw new Error(`refreshing the project's code index answered ${refreshed.status}: ${refreshed.body.slice(0, 200)}`);
  // Asked in the project's own chat: the lead is told which project its tools read.
  const { text, calls } = await askLead("What does src/math.js export? One line.", page, { project: repo });
  // What the lead's project search returned is the proof it read the file; its words must then name the export.
  const searched = calls.filter(one => one.tool === "get_project_context");
  if (searched.length === 0) throw new Error(`the lead didn't search the project (it called ${JSON.stringify(calls.map(one => one.tool))}); it said: ${text.slice(0, 300)}`);
  const found = searched.find(one => one.ok && /src\/math\.js/.test(one.result ?? "") && /export const add/.test(one.result ?? ""));
  if (found === undefined) throw new Error(`the project search didn't return src/math.js's export: ${JSON.stringify(searched.map(one => ({ args: one.args, ok: one.ok, message: one.message, result: one.result?.slice(0, 200) })))}`);
  if (!/\badd\b/i.test(text)) throw new Error(`the search returned add, but the answer doesn't mention it: ${text.slice(0, 300)}`);
  return { searched: found.args, answer: text.slice(0, 200) };
});

await journey("lead", REAL_MODEL, "The lead files a task from plain words, as a card you confirm (real Claude turn)", ["The lead answers a question about the project from its files (real Claude turn)"], async () => {
  const { reply } = await askLead("File a task in this project to add a short usage section about add() to README.md. Just file it, no need to ask.");
  const card = reply.locator('[data-view="chat-card"][data-card-kind="task"][data-card-state="pending"]').first();
  await waitFor(card, "a task card to confirm in the lead's reply", { timeoutMs: 20_000, seen: async () => `the reply “${(await reply.innerText()).replace(/\s+/g, " ").slice(0, 300)}”` });
  await card.locator("[data-card-confirm]").click();
  await until("the task card to be confirmed", async () => (await reply.locator('[data-view="chat-card"][data-card-kind="task"][data-card-state="confirmed"]').count()) > 0, { timeoutMs: 30_000 });
  const filed = rows("SELECT external_id AS id FROM task_ref WHERE filed_via = 'mate' ORDER BY id DESC LIMIT 1")[0];
  if (!filed) throw new Error("no task was filed from chat");
  return { task: filed.id };
});

// ------------------------------------------------------------------ projects, knowledge, skills, tools, models

await journey("lead", REAL_MODEL, "The lead draws a follow-up flow from plain words: it emails, waits for a reply, and nudges when none comes (real Claude turn)", ["The lead answers a question about the project from its files (real Claude turn)"], async () => {
  const before = rows("SELECT COALESCE(MAX(id), 0) AS id FROM flow")[0].id;
  const { reply } = await askLead("Make a flow called Quote follow-up in this project: email the customer our quote, wait 3 days for them to reply, and if they don't, send them a short reminder. Replies go to a holding step called Replied. Just draft it, no need to ask.");
  const card = await pendingCard(reply, "the flow card to confirm in the lead's reply");
  await card.locator("[data-card-confirm]").click();
  const flow = await until("the flow", async () => rows(`SELECT id, definition_json FROM flow WHERE id > ${before} ORDER BY id DESC LIMIT 1`)[0], { timeoutMs: 30_000 });
  const stages = JSON.parse(flow.definition_json).stages;
  const wait = stages.find(one => one.kind === "wait");
  if (wait === undefined || wait.wait?.for !== "reply" || wait.wait.minutes !== 3 * 24 * 60) throw new Error(`the wait step: ${JSON.stringify(wait ?? stages.map(one => one.kind))}`);
  const nudge = stages.find(one => one.id === wait.onFail);
  if (nudge?.kind !== "email") throw new Error(`with no reply it goes to: ${JSON.stringify(nudge)}`);
  if (stages.find(one => one.id === wait.next)?.kind !== "inbox") throw new Error(`a reply goes to: ${wait.next}`);
  return { steps: stages.map(one => `${one.title} (${one.kind})`).join(" → ") };
});

await journey("console", SCRIPTED, "Projects: the project is listed and opens", [], async () => {
  await page.goto(`${base}/projects`);
  const row = page.locator(`li[data-project="${repo}"]`);
  await row.waitFor({ timeout: 10_000 });
  // The project a person works in reads "Open now"; any other has an Open button.
  if (!/Open now/.test(await row.innerText())) await Promise.all([page.waitForNavigation(), row.locator('form[action="/projects/open"] button').click()]);
  await page.goto(`${base}/projects`);
  if (!/Open now/.test(await page.locator(`li[data-project="${repo}"]`).innerText())) throw new Error("the project isn't the open one");
});

await journey("console", SCRIPTED, "Knowledge: instructions saved for a project are kept for future tasks", [], async () => {
  await page.goto(`${base}/settings/knowledge?repo=${encodeURIComponent(repo)}`);
  await page.evaluate(() => { for (const one of document.querySelectorAll("details")) one.open = true; });
  await page.fill('textarea[name="instructions"]', "Use plain ES modules. Every function gets a test.");
  await Promise.all([page.waitForNavigation(), page.click('button:has-text("Save instructions")')]);
  const said = await page.locator('p[role="status"]').first().innerText().catch(() => "");
  if (!/Saved for future tasks/.test(said)) throw new Error(`saving said: ${said}`);
  if (!/Every function gets a test/.test(await page.locator("body").innerText())) throw new Error("the instructions aren't shown back");
});

await journey("console", SCRIPTED, "Skills: a pasted skill joins the library and can be turned on", [], async () => {
  await page.goto(`${base}/settings/skills?repo=${encodeURIComponent(repo)}`);
  await page.getByText("Add skill", { exact: true }).first().click();
  const form = page.locator("form[data-skill-import]");
  await form.waitFor({ timeout: 10_000 });
  await form.locator('select[name="method"]').selectOption("paste").catch(() => undefined);
  await form.locator('textarea[name="content"]').fill("---\nname: small-commits\ndescription: Keep each commit small and focused on one change.\n---\n\n# Small commits\n\nMake one small commit per change, with a clear message.\n");
  await Promise.all([page.waitForNavigation(), form.locator("button").first().click()]);
  const skill = page.locator("article[id^='skill-']").first();
  await skill.waitFor({ timeout: 10_000 });
  if (!/In library/.test(await skill.innerText())) throw new Error(`the skill reads: ${(await skill.innerText()).slice(0, 200)}`);
  await page.evaluate(() => { for (const one of document.querySelectorAll("details")) one.open = true; });
  await Promise.all([page.waitForNavigation(), page.locator('form[action="/settings/skills/change"] button:has-text("Enable skill")').first().click()]);
  if (!/Enabled/.test(await page.locator("article[id^='skill-']").first().innerText())) throw new Error("the skill didn't turn on");
});

await journey("console", SCRIPTED, "Tools: a project's own MCP tool is added (with your password) and tested", [], async () => {
  const echo = join(w.root, "echo-mcp.mjs");
  writeFileSync(echo, `import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: [{ name: "say", inputSchema: { type: "object" } }] });
});
`);
  await page.goto(`${base}/settings/tools?repo=${encodeURIComponent(repo)}`);
  await page.evaluate(() => { for (const one of document.querySelectorAll("details")) one.open = true; });
  const custom = page.locator('form:has(input[name="target"])').first();
  await custom.locator('input[name="name"]').fill("echo");
  await custom.locator('select[name="transport"]').selectOption("stdio");
  await custom.locator('input[name="target"]').fill(`${process.execPath} ${echo}`);
  await custom.locator('input[name="password"]').fill(w.passwords.alex);
  await Promise.all([page.waitForNavigation(), custom.locator("button").last().click()]);
  const added = await page.locator('p[role="status"], p.problem').first().innerText().catch(() => "");
  if (!/Added/.test(added)) throw new Error(`adding said: ${added}`);
  await Promise.all([page.waitForNavigation(), page.locator('#tool-echo form button:has-text("Test")').click()]);
  const tested = await page.locator('p[role="status"], p.problem').first().innerText().catch(() => "");
  if (!/echo works: 1 tool/.test(tested)) throw new Error(`testing said: ${tested}`);
});

await journey("console", SCRIPTED, "Models: Check now reads the live model lists", [], async () => {
  await page.goto(`${base}/settings/models`);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/settings/models/check"] button')]);
  const said = await page.locator('p[role="status"]').first().innerText().catch(() => "");
  if (!/^Checked\./.test(said)) throw new Error(`checking said: ${said}`);
  return { said };
});

// ------------------------------------------------------------------ routines, settings, search, signing out

await journey("console", SCRIPTED, "Routines: a standing order is filed, approved with your password, and run now files its task", [], async () => {
  await page.goto(`${base}/routines`);
  const form = page.locator('form[action="/routines/add"]');
  await form.waitFor({ timeout: 10_000 });
  await form.locator('input[name="name"]').fill("weekly-deps");
  await form.locator('textarea[name="goal"]').fill("Check the project's dependencies and report any that are out of date.");
  await form.locator('textarea[name="acceptance"]').fill("A short report lists outdated dependencies | manual-review");
  await form.locator('select[name="repeat"]').selectOption("weekly").catch(() => undefined);
  await Promise.all([page.waitForNavigation(), form.locator("button").last().click()]);
  const approve = page.locator('form[action$="/approve"]').first();
  await approve.waitFor({ timeout: 10_000 });
  await approve.locator('input[name="token"]').fill(w.passwords.alex);
  await Promise.all([page.waitForNavigation(), approve.locator("button").first().click()]);
  const routine = rows("SELECT id, approved_at FROM routine WHERE name = 'weekly-deps'")[0];
  if (!routine?.approved_at) throw new Error(`the routine wasn't approved: ${(await page.locator("body").innerText()).slice(0, 300)}`);
  const now = page.locator('form[action$="/run-now"]').first();
  await now.locator('input[name="token"]').fill(w.passwords.alex);
  await Promise.all([page.waitForNavigation(), now.locator("button").first().click()]);
  const fired = await until("the routine's task", async () => rows(`SELECT t.external_id AS id FROM task_ref t WHERE t.routine_id = ${routine.id}`)[0], { timeoutMs: 60_000, everyMs: 2000 });
  return { routine: routine.id, task: fired.id };
});

await journey("pages", SCRIPTED, "Settings: the theme switches to dark and the accent to Emerald, and both stay", [], async () => {
  await page.goto(`${base}/settings`);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/settings/appearance"] button[value="dark"]')]);
  await page.click('[data-accent-picker] button[data-preset="emerald"]');
  await page.locator("[data-accent-status]", { hasText: "Saved" }).waitFor({ timeout: 10_000 });
  await page.goto(`${base}/chat`);
  if ((await page.locator("html").getAttribute("data-theme")) !== "dark") throw new Error("the theme didn't stay dark");
  if ((await page.locator('style[data-accent="#009473"]').count()) !== 1) throw new Error("the accent didn't stay Emerald");
  await page.goto(`${base}/settings`);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/settings/appearance"] button[value="system"]')]);
  await page.click('[data-accent-picker] button[data-preset="chart-magenta"]');
  await page.locator("[data-accent-status]", { hasText: "Saved" }).waitFor({ timeout: 10_000 });
});

await journey("pages", SCRIPTED, "Search finds the project and a task", [], async () => {
  // Search is left off pages that show a password field; Flows has none.
  await page.goto(`${base}/flows`);
  await page.click("button.so-command-trigger");
  const box = page.locator('[data-workspace-command] input[type="search"]');
  await box.waitFor({ timeout: 5000 });
  await box.fill("shop");
  await until("a result", async () => (await page.locator(".so-command-results li a").count()) > 0, { timeoutMs: 5000, everyMs: 300 });
  await page.keyboard.press("Escape");
});

// ------------------------------------------------------------------ code in flows

let codeFlow = null;
await journey("flows", SCRIPTED, "Code steps: a Python file and a Node script get the card, pass on what they print, pick the next zone, and get a secret", [], async () => {
  codeFlow = await newFlow("Leads", [
    { ...none, id: "size", title: "Size it up", kind: "check", script: "size", runIn: "folder", routes: [{ answer: "Big", to: "call" }, { answer: "Small", to: "note" }], zone: zone(0), next: null, onFail: "inbox" },
    { ...none, id: "call", title: "Call them", kind: "inbox", zone: zone(360), next: null, onFail: null },
    { ...none, id: "note", title: "Write it down", kind: "check", script: "note", runIn: "folder", secrets: ["CRM_KEY"], zone: zone(360, 380), next: "done", onFail: "inbox" },
    { ...none, id: "inbox", title: "Inbox", kind: "inbox", zone: zone(0, 380), next: null, onFail: null },
    { ...none, id: "done", title: "Done", kind: "done", zone: zone(720, 380), next: null, onFail: null },
  ], "size");
  // The two scripts, made on the Scripts panel: a Python file already in the project, and a Node script written there.
  const saveScript = async ({ name, about, language, file, body }) => {
    await page.click("[data-open-scripts]");
    // With no scripts yet the panel opens on a new one; otherwise "New script" does.
    if (!(await page.locator("[data-script-form]").isVisible())) await page.click('[data-flow-scripts] button:has-text("New script")');
    const form = page.locator("[data-script-form]");
    await form.locator("label").filter({ hasText: /^Name/ }).locator("input").fill(name);
    await form.locator("label").filter({ hasText: "What it checks or does" }).locator("input").fill(about);
    await form.locator('select[aria-label="Language"]').selectOption(language);
    if (file !== undefined) {
      await form.locator('select[aria-label="Runs"]').selectOption("file");
      await form.locator("label").filter({ hasText: /^File/ }).locator("input").fill(file);
    } else {
      await form.locator('select[aria-label="Runs"]').selectOption("here");
      await form.locator("label").filter({ hasText: /^Script/ }).locator("textarea").fill(body);
    }
    await form.locator('button:has-text("Save script")').click();
    await until(`the ${name} script to be saved`, async () => (await flowView(codeFlow)).scripts.some(one => one.name === name), { timeoutMs: 15_000, everyMs: 500 });
  };
  await saveScript({ name: "size", about: "Sizes up a lead", language: "python", file: "scripts/size.py" });
  await saveScript({ name: "note", about: "Writes the lead down", language: "node", body: "import { readFileSync } from 'node:fs';\nconst { card, outputs } = JSON.parse(readFileSync(0, 'utf8'));\nconsole.log(`Noted ${card.title} (${outputs.size.text}) with ${process.env.CRM_KEY}`);" });
  // A card before the secret is saved: it waits, saying which.
  await addCard("Bakery down the road", "Two people");
  const waiting = await until("the card to wait for its secret", async () => (await flowView(codeFlow)).cards.find(one => one.title === "Bakery down the road" && one.stage === "note" && /CRM_KEY/.test(one.waiting ?? "")), { timeoutMs: 90_000, everyMs: 2000 });
  // The secret, saved on the zone's Secrets box (a value made now, never written out).
  const secret = `crm-${randomBytes(8).toString("hex")}`;
  const kept = await post(`/flows/${codeFlow}/secrets`, { name: "CRM_KEY", value: secret });
  if (kept.status !== 200) throw new Error(`the secret wasn't saved: ${kept.body}`);
  const small = await until("the small lead to be written down", async () => (await flowView(codeFlow)).cards.find(one => one.title === "Bakery down the road" && one.state === "done"), { timeoutMs: 90_000, everyMs: 2000 });
  // Text that would do something if it were ever part of a command.
  const marker = join(w.root, "pwned");
  await addCard(`Acme wants a demo $(touch ${marker})`, null);
  const big = await until("the big lead to reach Call them", async () => (await flowView(codeFlow)).cards.find(one => one.title.startsWith("Acme") && one.stage === "call"), { timeoutMs: 90_000, everyMs: 2000 });
  const problems = [];
  const said = id => small.outputs.find(one => one.stage === id)?.text ?? "";
  if (said("size") !== "Bakery down the road looks small") problems.push(`size printed ${said("size")}`);
  if (said("note") !== "Noted Bakery down the road (Bakery down the road looks small) with [secret]") problems.push(`note printed ${said("note")}`);
  if (big.outputs.find(one => one.stage === "size")?.text !== `Acme wants a demo $(touch ${marker}) looks big`) problems.push("the big lead's size wasn't passed on");
  if (existsSync(marker)) problems.push("card text ran as a command");
  const logs = rows(`SELECT log FROM flow_step_run r JOIN flow_card c ON c.id = r.card WHERE c.flow = ${codeFlow}`).map(one => one.log ?? "").join("\n");
  if (logs.includes(secret) || JSON.stringify(await flowView(codeFlow)).includes(secret)) problems.push("the secret reached a log or the page");
  if (problems.length > 0) throw new Error(problems.join("; "));
  await page.reload(); await page.waitForSelector("[data-zone]");
  await shot("code-steps");
  return { waited: waiting.waiting, small: said("note"), big: big.stage };
});

await journey("flows", SCRIPTED, "A schedule runs a script and makes a card of each item it prints, once (Run now)", ["Code steps: a Python file and a Node script get the card, pass on what they print, pick the next zone, and get a secret"], async () => {
  await page.click("[data-open-scripts]");
  if (!(await page.locator("[data-script-form]").isVisible())) await page.click('[data-flow-scripts] button:has-text("New script")');
  const form = page.locator("[data-script-form]");
  await form.locator("label").filter({ hasText: /^Name/ }).locator("input").fill("new-leads");
  await form.locator("label").filter({ hasText: "What it checks or does" }).locator("input").fill("Lists new leads");
  await form.locator('select[aria-label="Language"]').selectOption("python");
  await form.locator("label").filter({ hasText: /^Script/ }).locator("textarea").fill("import json\nfor n in (1, 2):\n    print(json.dumps({'title': f'Lead {n} from the CRM', 'key': n}))");
  await form.locator('button:has-text("Save script")').click();
  await until("the new-leads script", async () => (await flowView(codeFlow)).scripts.some(one => one.name === "new-leads"), { timeoutMs: 15_000, everyMs: 500 });
  // The trigger, through the Triggers panel: a schedule that makes a card for each item the script prints.
  await page.click("[data-open-triggers]");
  if (!(await page.locator("[data-add-trigger] select").first().isVisible())) await page.getByText("Add a trigger", { exact: true }).click();
  await page.locator("[data-add-trigger] select").first().selectOption("schedule");
  await page.locator("[data-add-trigger] label").filter({ hasText: /^When/ }).locator("input").fill("every 6 hours");
  await page.locator('select[aria-label="Makes"]').selectOption("script");
  await page.locator('[data-add-trigger] select[aria-label="Script"]').selectOption("new-leads");
  await page.locator('[data-add-trigger] button:has-text("Add trigger")').click();
  const trigger = await until("the trigger", async () => (await flowView(codeFlow)).triggers.find(one => one.kind === "schedule" && one.state === "active"), { timeoutMs: 15_000, everyMs: 500 });
  // Run now runs the script before it answers: each press is done when its answer comes back.
  for (let round = 0; round < 2; round++) {
    await Promise.all([
      page.waitForResponse(answer => answer.request().method() === "POST" && new URL(answer.url()).pathname === `/flows/${codeFlow}/triggers/${trigger.id}/check`, { timeout: 60_000 }),
      page.locator(`[data-flow-drawer] button:has-text("Run now")`).first().click(),
    ]);
  }
  const made = await until("two cards from the script", async () => { const cards = (await flowView(codeFlow)).cards.filter(one => /from the CRM/.test(one.title)); return cards.length >= 2 ? cards : null; }, { timeoutMs: 60_000, everyMs: 2000 });
  if (made.length !== 2) throw new Error(`the script made ${made.length} cards, not 2`);
  return { trigger: trigger.id, cards: made.map(one => one.title) };
});

// ------------------------------------------------------------------ email in, and a reply out

/** A real mail server (GreenMail in Docker) for one check: SMTP to write in with, IMAP to read anyone's inbox. support@shop.example is Settings → Email's. */
async function mailServer() {
  if (!docker) throw new Skip("Docker isn't running here, so there's no real mail server to read");
  const name = `so-e2e-greenmail-${randomBytes(3).toString("hex")}`;
  try {
    execFileSync("docker", ["run", "-d", "--name", name, "-p", "127.0.0.1:993:3993", "-p", "127.0.0.1:3025:3025", "-v", `${join(certDir, "keystore.p12")}:/keystore.p12:ro`, "-e",
      "GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=support:mail-pass@shop.example -Dgreenmail.users.login=email -Dgreenmail.tls.keystore.file=/keystore.p12 -Dgreenmail.tls.keystore.password=e2e-keystore",
      "greenmail/standalone:2.1.3"], { stdio: "ignore", timeout: 120_000 });
  } catch { throw new Skip("the mail server container couldn't start (is port 993 or 3025 taken?)"); }
  const nodemailer = (await import(join(w.bin, "../../node_modules/nodemailer/dist/cjs/nodemailer.js"))).default;
  const { ImapFlow } = await import(join(w.bin, "../../node_modules/imapflow/dist/cjs/imap-flow.js"));
  const { simpleParser } = await import(join(w.bin, "../../node_modules/mailparser/index.js"));
  const smtp = nodemailer.createTransport({ host: "127.0.0.1", port: 3025, secure: false, ignoreTLS: true });
  const stop = () => { smtp.close(); execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); };
  try { await until("the mail server", async () => { await smtp.verify(); return true; }, { timeoutMs: 60_000, everyMs: 2000 }); } catch (error) { stop(); throw error; }
  /** Everything in someone's inbox (GreenMail signs a person in with their address as the password). */
  const inbox = async user => {
    const box = new ImapFlow({ host: "127.0.0.1", port: 993, secure: true, auth: { user, pass: user }, logger: false, tls: { ca: readFileSync(mailCert) } });
    await box.connect();
    await box.mailboxOpen("INBOX");
    const got = [];
    for await (const message of box.fetch("1:*", { envelope: true, headers: ["in-reply-to", "references"], source: true })) {
      const parsed = await simpleParser(message.source);
      got.push({ subject: message.envelope.subject, headers: message.headers.toString(), body: parsed.text ?? "", messageId: parsed.messageId ?? null });
    }
    await box.logout();
    return got;
  };
  return { smtp, inbox, stop };
}

await journey("mail", SCRIPTED, "Email inbox: a real email becomes a card, Claude drafts a reply, the owner approves it, and it arrives in the sender's thread", [], async () => {
  const mail = await mailServer();
  const smtp = mail.smtp;
  script({ role: "draft", when: [/Refund for order 42\?/], answer: { text: "Hi Priya,\n\nSorry about the double charge on order 42. We've refunded the second charge to your card; it can take up to 5 days to show.\n\nBest,\nSupport" } });
  try {
    // Settings → Email: the mail server, and where to read mail; "Check the inbox" signs in.
    await page.goto(`${base}/settings#email`);
    await page.waitForSelector("[data-email-settings]");
    await page.fill("#email-host", "127.0.0.1"); await page.fill("#email-port", "3025"); await page.fill("#email-from", "support@shop.example");
    await page.fill("#email-password", "mail-pass"); await page.fill("#email-imap", "127.0.0.1"); await page.fill("#email-imap-port", "993");
    await Promise.all([page.waitForNavigation(), page.click('[data-email-settings] button:has-text("Save email")')]);
    await page.click('#email button:has-text("Change")');
    await Promise.all([page.waitForNavigation(), page.click('[data-email-settings] button:has-text("Check the inbox")')]);
    // What it said comes back on the page's address (and as a toast).
    const told = new URL(page.url()).searchParams.get("said") ?? "";
    if (told !== "Reading works: signed in to the inbox of support@shop.example.") throw new Error(`Check the inbox said: ${told}`);
    // A Customer replies flow (the template) with an Email inbox trigger added on its Triggers panel.
    // Flows → New → a template's page: name it, then create what it previews.
    await page.goto(`${base}/flows/new/email-replies`);
    await page.fill('form[data-gallery-use] input[name="name"]', "Support inbox");
    await Promise.all([page.waitForNavigation(), page.click('form[data-gallery-use] button[value="create"]')]);
    const id = Number(/\/flows\/(\d+)/.exec(page.url())[1]);
    await page.waitForSelector("[data-zone]");
    await page.click("[data-open-triggers]");
    if (!(await page.locator("[data-add-trigger] select").first().isVisible())) await page.getByText("Add a trigger", { exact: true }).click();
    await page.locator("[data-add-trigger] select").first().selectOption("email");
    await page.locator('[data-add-trigger] button:has-text("Add trigger")').click();
    await until("the email trigger", async () => (await flowView(id)).triggers.some(one => one.kind === "email"), { timeoutMs: 15_000, everyMs: 500 });
    const checkNow = () => page.locator('[data-flow-drawer] button:has-text("Check now")').first().click();
    await checkNow();
    await until("the trigger to note where the inbox stands", async () => /Watching the inbox/.test((await flowView(id)).triggers.find(one => one.kind === "email")?.status ?? ""), { timeoutMs: 30_000, everyMs: 1000 });
    // Priya writes in, and so does her out-of-office.
    await smtp.sendMail({ from: "Priya Shah <priya@example.com>", to: "support@shop.example", subject: "Refund for order 42?", messageId: "<m42@example.com>",
      text: "Hi,\n\nI was charged twice for order 42. Can you refund the second charge?\n\nThanks,\nPriya\n\nOn Tue, Support <support@shop.example> wrote:\n> Thanks for your order." });
    await smtp.sendMail({ from: "Priya Shah <priya@example.com>", to: "support@shop.example", subject: "Automatic reply: away", text: "Away until Monday.", headers: { "Auto-Submitted": "auto-replied" } });
    await checkNow();
    const card = await until("Priya's card", async () => (await flowView(id)).cards.find(one => one.title === "Refund for order 42?"), { timeoutMs: 60_000, everyMs: 2000 });
    if ((await flowView(id)).cards.some(one => /Automatic reply/.test(one.title))) throw new Error("the out-of-office became a card");
    if (!/^From: Priya Shah <priya@example.com>\n\nHi,/.test(card.description ?? "") || /Thanks for your order/.test(card.description ?? "")) throw new Error(`the card's details: ${card.description}`);
    // Claude drafts; the owner approves in the card's panel; the reply goes out.
    const drafted = await until("Claude's draft", async () => { const one = (await flowView(id)).cards.find(c => c.id === card.id); return one?.draft !== null && one?.draft !== undefined ? one : null; }, { timeoutMs: 300_000, everyMs: 3000 });
    await page.reload(); await page.waitForSelector("[data-zone]");
    await page.locator(`[data-card="${card.id}"]`).click();
    await page.click('[data-flow-card-panel] button:has-text("Approve")');
    await until("the card to be done", async () => (await flowView(id)).cards.find(one => one.id === card.id)?.state === "done", { timeoutMs: 120_000, everyMs: 2000 });
    // Read Priya's mailbox: the reply is there, in her thread.
    const got = await mail.inbox("priya@example.com");
    const reply = got.find(one => one.subject === "Re: Refund for order 42?");
    if (reply === undefined) throw new Error(`Priya's mailbox has: ${got.map(one => one.subject).join(", ")}`);
    if (!/In-Reply-To: <m42@example.com>/i.test(reply.headers)) throw new Error(`the reply isn't in her thread: ${reply.headers}`);
    const flat = text => text.replace(/\s+/g, " ").trim();
    if (!flat(reply.body).includes(flat(drafted.draft.text).slice(0, 60))) throw new Error(`the reply isn't the approved draft: ${flat(reply.body).slice(0, 120)} vs ${flat(drafted.draft.text).slice(0, 120)}`);
    await shot("email-inbox");
    return { draft: drafted.draft.text.slice(0, 160) };
  } finally {
    mail.stop();
  }
});

await journey("mail", SCRIPTED, "Follow-ups: a card emails someone and waits; their reply moves it on (a stranger's doesn't), one nobody answers gets a nudge in the same thread, and a stalled decision reminds its owner and moves on", ["Email inbox: a real email becomes a card, Claude drafts a reply, the owner approves it, and it arrives in the sender's thread"], async () => {
  const mail = await mailServer();
  try {
    // The mailbox is read for replies only about once a minute (flow-replies.ts): three minutes keep a reply that lands
    // just after a read safely inside the wait.
    const WAIT = 3;
    const at = (id, title, kind, x, y, rest) => ({ id, title, kind, zone: zone(x, y), ...none, next: null, onFail: null, ...rest });
    // A decision that stalls: after a minute its owner is reminded and it's anyone's to decide.
    const decisions = await newFlow("Decisions", [
      at("decide", "Owner decides", "approval", 0, 0, { toOwner: true, next: "done", limit: { minutes: 1, to: "anyone" } }),
      at("anyone", "Anyone decides", "approval", 360, 0, { next: "done" }),
      at("done", "Done", "done", 720, 0, {}),
    ], "decide");
    await addCard("Buy a second monitor", "For the design desk.");
    const id = await newFlow("Follow-ups", [
      at("ask", "Ask them", "email", 0, 0, { email: { to: "{{card.email}}", subject: "Question about {{card.title}}", body: "Hi, can we go ahead with {{card.title}}?" }, next: "wait", onFail: "stuck" }),
      at("wait", "Wait for an answer", "wait", 360, 0, { wait: { for: "reply", minutes: WAIT }, next: "answered", onFail: "nudge" }),
      at("answered", "They replied", "inbox", 720, 0, {}),
      at("nudge", "Nudge", "email", 360, 380, { email: { to: "{{card.email}}", subject: "Re: Question about {{card.title}}", body: "Just checking in about {{card.title}}." }, next: "gave-up", onFail: "stuck" }),
      at("gave-up", "Gave up", "done", 720, 380, {}),
      at("stuck", "Couldn't email", "inbox", 0, 380, {}),
    ], "ask");
    await addCard("order 42", "Priya <priya@example.com> asked about a refund.");
    await addCard("order 43", "Sam <sam@example.com> asked about a refund.");
    const cardOf = async title => (await flowView(id)).cards.find(one => one.title === title);
    await until("both emails out and both cards waiting", async () => (await cardOf("order 42"))?.stage === "wait" && (await cardOf("order 43"))?.stage === "wait", { timeoutMs: 120_000, everyMs: 2000 });
    // Each waiting card says until when, in the viewer's own time.
    await page.reload(); await page.waitForSelector("[data-zone]");
    const until42 = await page.locator("[data-card-deadline]").first().innerText();
    if (!/^No reply by /.test(until42)) throw new Error(`the card says: ${until42}`);
    await shot("follow-ups-waiting");
    const asked = await until("Priya's email", async () => (await mail.inbox("priya@example.com")).find(one => one.subject === "Question about order 42"), { timeoutMs: 60_000, everyMs: 2000 });
    const asked43 = await until("Sam's email", async () => (await mail.inbox("sam@example.com")).find(one => one.subject === "Question about order 43"), { timeoutMs: 60_000, everyMs: 2000 });
    // A stranger names Sam's email as if replying: it isn't Sam, so it isn't a reply.
    await mail.smtp.sendMail({ from: "Mallory <mallory@example.com>", to: "support@shop.example", subject: "Re: Question about order 43", inReplyTo: asked43.messageId, references: [asked43.messageId], text: "Yes, go ahead." });
    await mail.smtp.sendMail({ from: "Priya Shah <priya@example.com>", to: "support@shop.example", subject: "Re: Question about order 42", inReplyTo: asked.messageId, references: [asked.messageId],
      text: "Yes, please go ahead with order 42.\n\nOn Tue, Support <support@shop.example> wrote:\n> Hi, can we go ahead with order 42?" });
    const answered = await until("Priya's reply to move her card on", async () => { const one = await cardOf("order 42"); return one?.stage === "answered" ? one : null; }, { timeoutMs: 150_000, everyMs: 3000 });
    const kept = answered.outputs.find(one => one.stage === "wait")?.text ?? "";
    if (!/Yes, please go ahead with order 42/.test(kept) || /can we go ahead/.test(kept)) throw new Error(`the reply kept on the card: ${kept}`);
    if (!answered.comments.some(one => one.author === "priya@example.com")) throw new Error("the reply isn't in the card's discussion");
    // Nobody answers Sam: after the wait, a nudge goes out in the same thread and the card finishes.
    await page.reload(); await page.waitForSelector("[data-zone]");
    await page.click('button:has-text("Edit flow")');
    await page.locator('[data-zone="wait"]').click({ position: { x: 24, y: 14 } });
    await page.waitForSelector('[data-flow-zone-panel="wait"]');
    await shot("wait-zone-settings");
    await page.click('button:has-text("Discard")');
    const gave = await until("Sam's card to finish without a reply", async () => { const one = await cardOf("order 43"); return one?.state === "done" ? one : null; }, { timeoutMs: (WAIT + 3) * 60_000, everyMs: 5000 });
    if (gave.comments.length > 0) throw new Error("the stranger's message was taken as Sam's reply");
    if (!gave.history.some(one => one.text.includes(`No reply after ${WAIT} minutes`))) throw new Error(`its history: ${gave.history.map(one => one.text).join(" | ")}`);
    const nudge = (await mail.inbox("sam@example.com")).find(one => one.subject === "Re: Question about order 43");
    if (nudge === undefined) throw new Error("the nudge didn't reach Sam");
    if (!nudge.headers.toLowerCase().includes(`in-reply-to: ${asked43.messageId}`.toLowerCase())) throw new Error(`the nudge isn't in the thread: ${nudge.headers}`);
    // The decision nobody made: its owner was reminded once, and it's anyone's to decide now.
    const stalled = (await flowView(decisions)).cards.find(one => one.title === "Buy a second monitor");
    if (stalled?.stage !== "anyone") throw new Error(`the stalled decision is in ${stalled?.stage}`);
    const reminded = rows(`SELECT subject FROM notification WHERE recipient = 'alex' AND subject LIKE '%has waited 1 minute in Owner decides%'`);
    if (reminded.length !== 1) throw new Error(`the owner got ${reminded.length} reminders`);
    // On a phone: the flow's cards, with what they wait on.
    const phone = await alexPhone("dark");
    await phone.goto(`${base}/flows/${id}`); await phone.waitForLoadState("load"); await settle(phone);
    await phone.screenshot({ path: join(w.out, "follow-ups-phone.png") });
    const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    await putPhoneDown();
    if (wide) throw new Error("the flow scrolls sideways on a phone");
    return { reply: kept.slice(0, 120), nudge: nudge.subject, reminder: reminded[0].subject };
  } finally {
    mail.stop();
  }
});

// ------------------------------------------------------------------ two people on one flow

await journey("maya", SCRIPTED, "AI teammates: Maya (a support rep) answers a question card, approves a small refund on its own, brings the big one to you, and stops while paused (real Claude turns)", [], async () => {
  // What Maya decides, card by card: questions answered, the $30 refund approved, the $400 one handed to you.
  const reads = /WHERE YOU ARE: the zone “Maya reads it”/, decides = /WHERE YOU ARE: the zone “Refund\?”/;
  script(
    { role: "teammate", when: [reads, /Title: Where is/], answer: { action: "route", answer: "Just a question", text: "Hi! Your order shipped and is on its way; it should reach you within 2 days. — Maya", reason: "A question about delivery, not a refund." } },
    { role: "teammate", when: [reads, /Title: (Charged twice|Broken TV)/], answer: { action: "route", answer: "Refund request", text: "Sorry about that! I've passed your refund request on, and you'll hear back today. — Maya", reason: "The customer asks for their money back." } },
    { role: "teammate", when: [decides, /Title: Charged twice/], answer: { action: "approve", reason: "A $30 duplicate charge is within my $50 limit." } },
    { role: "teammate", when: [decides, /Title: Broken TV/], answer: { action: "hand_off", note: "A $400 refund is over my $50 limit. I'd approve it: the screen arrived cracked.", reason: "Over my limit." } },
  );
  // A teammate from the Support rep template, on the Teammates page; its soul file saves as a new version.
  await page.goto(`${base}/teammates`);
  await page.selectOption('form[data-new-teammate] select[name="template"]', "support");
  await Promise.all([page.waitForNavigation(), page.click('form[data-new-teammate] button')]);
  const mateId = Number(/\/teammates\/(\d+)/.exec(page.url())?.[1]);
  if (!mateId) throw new Error(`no teammate page: ${page.url()}`);
  const soul = await page.inputValue("#teammate-soul");
  if (!/name: Maya/.test(soul) || !/Refunds and replacements up to \$50/.test(soul)) throw new Error(`the template's soul file: ${soul.slice(0, 200)}`);
  await page.fill("#teammate-soul", soul.replace("## What you know\n", "## What you know\n- Order numbers look like #1234.\n"));
  await Promise.all([page.waitForNavigation(), page.click('form[data-soul-form] button')]);
  if (!/version 2/.test(new URL(page.url()).searchParams.get("said") ?? "")) throw new Error(`saving the soul file said: ${page.url()}`);
  // A flow Maya works: she reads each message and picks where it goes, then decides the refunds.
  const at = (id, title, kind, x, y, rest) => ({ id, title, kind, zone: zone(x, y), ...none, next: null, onFail: null, ...rest });
  // Not "Support desk": the starter kit of that name is set up later in this world.
  const id = await newFlow("Customer help", [
    at("read", "Maya reads it", "teammate", 0, 0, { teammate: "maya", instructions: "Read the customer's message. Write the short reply we'd send them, and pick where it goes: a refund request goes to the refund decision; anything else is just a question.",
      routes: [{ answer: "Just a question", to: "answered" }, { answer: "Refund request", to: "decide" }], onFail: "stuck" }),
    at("decide", "Refund?", "approval", 360, 0, { teammate: "maya", toOwner: true, next: "refunded", onFail: "declined" }),
    at("answered", "Answered", "inbox", 0, 380, {}), at("refunded", "Refunded", "inbox", 720, 0, {}), at("declined", "Declined", "inbox", 720, 380, {}), at("stuck", "For a person", "inbox", 360, 380, {}),
  ], "read");
  await addCard("Where is my order #1201?", "Hi, I ordered a lamp last week and it hasn't arrived yet. Any news? — Priya");
  await addCard("Charged twice for order #1202", "I was charged $30 twice for the same order. Can I get the extra $30 back? — Sam");
  await addCard("Broken TV, order #1203", "My $400 TV arrived with a cracked screen. I want my money back. — Lee");
  const cardOf = async title => (await flowView(id)).cards.find(one => one.title.startsWith(title));
  const question = await until("Maya to answer the question card", async () => { const one = await cardOf("Where is my order"); return one?.stage === "answered" ? one : null; }, { timeoutMs: 420_000, everyMs: 3000 });
  const reply = question.outputs.find(one => one.stage === "read")?.text ?? "";
  if (reply.length < 20) throw new Error(`her reply: ${reply}`);
  const small = await until("Maya to approve the $30 refund on her own", async () => { const one = await cardOf("Charged twice"); return one?.stage === "refunded" ? one : null; }, { timeoutMs: 420_000, everyMs: 3000 });
  if (!small.history.some(one => /Approved by Maya \(AI\)/.test(one.text))) throw new Error(`its history: ${small.history.map(one => one.text).join(" | ")}`);
  // The $400 one is over her limit: she brings it to the flow's owner (a decision, or a question first).
  const brought = await until("Maya to bring the $400 refund to you", async () => { const one = await cardOf("Broken TV"); return one?.canDecide || one?.question?.mine ? one : null; }, { timeoutMs: 420_000, everyMs: 3000 });
  await page.reload(); await page.waitForSelector("[data-zone]");
  await page.locator(`[data-card="${brought.id}"]`).click();
  await page.waitForSelector(`[data-flow-card-panel="${brought.id}"]`);
  await shot("teammate-brings-it");
  if (brought.question?.mine) {
    await page.locator(`[data-teammate-question] textarea`).fill("Yes, it's a refund request. Go ahead and send it to the refund decision.");
    await page.locator(`[data-teammate-question] button:has-text("Answer")`).click();
  }
  const handed = await until("the decision to be yours", async () => { const one = await cardOf("Broken TV"); return one?.canDecide ? one : one?.stage === "refunded" ? one : null; }, { timeoutMs: 420_000, everyMs: 3000 });
  if (handed.stage !== "refunded") {
    await page.reload(); await page.waitForSelector("[data-zone]");
    await page.locator(`[data-card="${handed.id}"]`).click();
    // What Maya said when she handed it over is in front of the person deciding.
    if (handed.handoff != null && !/^Maya · Support:/.test(await page.locator("[data-teammate-handoff]").innerText())) throw new Error("Maya's note isn't on the decision");
    await page.click('[data-flow-card-panel] button:has-text("Approve")');
    await until("the $400 refund to be approved by you", async () => (await cardOf("Broken TV"))?.stage === "refunded", { timeoutMs: 30_000, everyMs: 1000 });
  }
  const told = rows(`SELECT subject FROM notification WHERE recipient = 'alex' AND subject LIKE 'Maya · Support%'`);
  if (told.length === 0) throw new Error("you weren't told by Maya, under her name");
  if (rows(`SELECT 1 FROM flow_event WHERE actor = 'alex' AND outcome = 'approved'`).length === 0 && rows(`SELECT 1 FROM teammate_question WHERE answered_by = 'alex'`).length === 0) throw new Error("no person decided the $400 refund");
  // Paused, the zones she handles wait; resumed, she picks the card up.
  await page.goto(`${base}/teammates/${mateId}`);
  await Promise.all([page.waitForNavigation(), page.click('button:has-text("Pause Maya")')]);
  await page.goto(`${base}/flows/${id}`); await page.waitForSelector("[data-zone]");
  await addCard("Where is order #1204?", "Just checking on my order. — Ana");
  await until("the card to wait while Maya is paused", async () => /paused/.test((await cardOf("Where is order #1204"))?.waiting ?? ""), { timeoutMs: 60_000, everyMs: 2000 });
  await page.goto(`${base}/teammates/${mateId}`);
  await Promise.all([page.waitForNavigation(), page.click('button:has-text("Resume Maya")')]);
  await until("Maya to pick it up again", async () => (await cardOf("Where is order #1204"))?.stage !== "read", { timeoutMs: 300_000, everyMs: 3000 });
  // Her page: what she did and why, and today's summary sent to her manager.
  await page.goto(`${base}/teammates/${mateId}`);
  await Promise.all([page.waitForNavigation(), page.click('button:has-text("Send today\'s summary")')]);
  if (rows(`SELECT 1 FROM notification WHERE kind = 'teammate-summary' AND recipient = 'alex'`).length === 0) throw new Error("no summary was sent");
  await shot("teammate-page");
  const phone = await alexPhone("dark");
  await phone.goto(`${base}/teammates/${mateId}`); await phone.waitForLoadState("load"); await settle(phone);
  await phone.screenshot({ path: join(w.out, "teammate-phone.png") });
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await putPhoneDown();
  if (wide) throw new Error("the teammate page scrolls sideways on a phone");
  return { reply: reply.slice(0, 120), summary: (await page.locator(".teammate-summary").innerText()).slice(0, 200) };
});

await journey("maya", REAL_MODEL, "The lead adds a teammate and changes one's rules from plain words, as cards you confirm (real Claude turns)", ["Turn the lead chat on (first-run setup, with your password)", "AI teammates: Maya (a support rep) answers a question card, approves a small refund on its own, brings the big one to you, and stops while paused (real Claude turns)"], async () => {
  // The lead's own proposal is what's checked: the card it drafted (a reply without one fails quoting the reply and the
  // tools the lead called), then what confirming it saved.
  const confirm = async (asked, what) => {
    const card = await pendingCard(asked.reply, `${what} in the lead's reply (it called ${JSON.stringify(asked.calls.map(one => `${one.tool}${one.ok ? "" : " ✗"}`))})`);
    await card.locator("[data-card-confirm]").click();
    await until(`${what} to be confirmed`, async () => (await asked.reply.locator('[data-view="chat-card"][data-card-state="confirmed"]').count()) > 0, { timeoutMs: 30_000 });
  };
  await confirm(await askLead("Add a sales rep teammate called Leo to this project. Just draft it, no need to ask."), "the card adding Leo");
  if (rows("SELECT 1 FROM teammate WHERE handle = 'leo' AND state = 'active'").length !== 1) throw new Error("Leo isn't on the team");
  await confirm(await askLead("Maya can approve refunds and replacements up to $100 on her own now. Update her rules."), "the card changing Maya's rules");
  const soul = rows("SELECT soul FROM teammate WHERE handle = 'maya'")[0]?.soul ?? "";
  if (!/\$100/.test(soul) || !/name: Maya/.test(soul)) throw new Error(`Maya's soul file: ${soul.slice(0, 400)}`);
  return { maya: soul.split("## Decide on your own")[1]?.split("##")[0]?.trim().slice(0, 200) };
});

/** Rosa's turns on one refund card, scripted: look the order up, refund it, then route it as refunded. */
function rosaRefunds(title, order, amount, zone = "Rosa handles it") {
  const on = [new RegExp(`WHERE YOU ARE: the zone “${zone}”`), new RegExp(`Title: ${title}`)];
  return [
    { role: "teammate", when: on, unless: [/\d\. store\.lookup_order/], answer: { action: "use_tool", tool: "store.lookup_order", input: { order }, reason: "To see what the customer paid." } },
    { role: "teammate", when: [...on, /\d\. store\.lookup_order/], unless: [/\d\. store\.refund_order/], answer: { action: "use_tool", tool: "store.refund_order", input: { order, amount }, reason: `The customer is owed $${amount}.` } },
    { role: "teammate", when: [...on, /\d\. store\.refund_order/], answer: { action: "route", answer: "Refunded", text: `Hi! I've refunded $${amount} on order ${order} to your original payment method; it takes up to 5 days to show. — Rosa`, reason: "The refund is made." } },
  ];
}

const TOOL_CHECK = "Teammates that act: Rosa uses a real store tool under her rules — looks orders up and refunds $30 on her own, asks you before $400, and your Approve makes exactly that call (real Claude turns)";
await journey(["rosa", "memory"], SCRIPTED, TOOL_CHECK, [], async () => {
  // What Rosa does with each card: looks the order up, refunds it with the store (the $400 one waits for you), says where it goes.
  script(rosaRefunds("Charged twice for order 2201", "2201", 30), rosaRefunds("Broken TV, order 2202", "2202", 400));
  // A real MCP server over stdio (named store: the lead never sees this project's folder name, shop): it looks orders up and refunds them, and writes down every call it gets.
  const shop = join(w.root, "shop-mcp.mjs"), log = join(w.root, "shop-calls.log");
  writeFileSync(shop, `import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const orders = { "2201": "Order 2201: a desk lamp, $30. The card was charged twice: two $30 payments; one is a duplicate.", "2202": "Order 2202: a TV, $400. Delivered with a cracked screen; photo on file.",
  ...Object.fromEntries([120, 125, 130, 135, 140].map((amount, at) => [String(2204 + at), "Order " + (2204 + at) + ": a chair, $" + amount + ". Arrived broken; photo on file. The customer is owed a full refund."])) };
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "store", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: [
    { name: "lookup_order", description: "Look an order up by its number", inputSchema: { type: "object", properties: { order: { type: "string" } }, required: ["order"] }, annotations: { readOnlyHint: true } },
    { name: "refund_order", description: "Refund money on an order to the original payment method", inputSchema: { type: "object", properties: { order: { type: "string" }, amount: { type: "number", description: "dollars" } }, required: ["order", "amount"] } },
    { name: "delete_customer", description: "Delete a customer and their history", inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] } },
    { name: "cancel_refund", description: "Cancel a refund that hasn't settled yet", inputSchema: { type: "object", properties: { order: { type: "string" }, amount: { type: "number" } }, required: ["order"] } },
  ] });
  else if (message.method === "tools/call") {
    appendFileSync(${JSON.stringify(log)}, JSON.stringify(message.params) + "\\n");
    const args = message.params.arguments ?? {};
    const order = String(args.order ?? "").replace(/^#/, "");
    reply(message.id, { content: [{ type: "text", text: message.params.name === "lookup_order" ? orders[order] ?? "No order " + order : message.params.name === "refund_order" ? "Refunded $" + args.amount + " on order " + order + " (refund R-" + order + ")."
      : message.params.name === "cancel_refund" ? "Cancelled the refund on order " + order + "." : "Deleted." }] });
  }
});
`);
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const refunds = order => calls().filter(one => one.name === "refund_order" && String(one.arguments?.order ?? "").replace(/^#/, "") === order);
  // The project tool, the way the Tools page adds one (with your password), and tested.
  await page.goto(`${base}/settings/tools?repo=${encodeURIComponent(repo)}`);
  for (const form of [{ action: "add-custom", name: "store", transport: "stdio", target: `${process.execPath} ${shop}`, password: w.passwords.alex }, { action: "test", name: "store" }]) {
    const answered = await page.request.post(`${base}/settings/tools/change`, { form: { csrf: await csrfOf(page), repo, shown: repo, ...form }, headers: { origin: base }, maxRedirects: 0 });
    if (answered.status() >= 400) throw new Error(`the Tools page refused ${form.action}: ${answered.status()}`);
  }
  // Rosa, from the Support rep template; on her page she's let use the store.
  await page.goto(`${base}/teammates`);
  await page.evaluate(() => { for (const one of document.querySelectorAll("details")) one.open = true; });
  await page.selectOption('form[data-new-teammate] select[name="template"]', "support");
  await page.fill('form[data-new-teammate] input[name="name"]', "Rosa");
  await Promise.all([page.waitForNavigation(), page.click('form[data-new-teammate] button')]);
  const mateId = Number(/\/teammates\/(\d+)/.exec(page.url())?.[1]);
  await page.selectOption('form.tool-add select[name="tool"]', "store");
  await Promise.all([page.waitForNavigation(), page.click('form.tool-add button')]);
  const shopRules = page.locator('[data-tool-grant="store"]');
  const ruleOf = action => shopRules.locator(`select[name="use.${action}"]`).inputValue();
  if (await ruleOf("lookup_order") !== "free" || await ruleOf("refund_order") !== "ask") throw new Error(`the starting rules: lookup ${await ruleOf("lookup_order")}, refund ${await ruleOf("refund_order")}`);
  // Refunds up to $50 on her own, and never deleting customers.
  await shopRules.locator('select[name="use.refund_order"]').selectOption("limit");
  await shopRules.locator('select[name="field.refund_order"]').selectOption("amount");
  await shopRules.locator('input[name="over.refund_order"]').fill("50");
  await shopRules.locator('select[name="use.delete_customer"]').selectOption("never");
  await Promise.all([page.waitForNavigation(), shopRules.locator('button:has-text("Save rules")').click()]);
  const rules = JSON.parse(rows(`SELECT rules_json FROM teammate_tool WHERE teammate = ${mateId} AND tool = 'store'`)[0]?.rules_json ?? "{}");
  if (rules.refund_order?.limit?.over !== 50 || rules.delete_customer?.use !== "never") throw new Error(`the saved rules: ${JSON.stringify(rules)}`);
  await page.locator("#tools").scrollIntoViewIfNeeded(); await settle(page);
  await shot("teammate-tools");
  // A flow Rosa handles: she reads the refund request, uses the store, and says where it goes.
  const at = (id, title, kind, x, y, rest) => ({ id, title, kind, zone: zone(x, y), ...none, next: null, onFail: null, ...rest });
  const id = await newFlow("Refund desk", [
    at("rosa", "Rosa handles it", "teammate", 0, 0, { teammate: "rosa", instructions: "Look the order up in the store, then refund what the customer is owed with the store's refund. Write the short reply we'd send them.",
      routes: [{ answer: "Refunded", to: "refunded" }, { answer: "Nothing to refund", to: "answered" }], onFail: "stuck" }),
    at("refunded", "Refunded", "inbox", 360, 0, {}), at("answered", "Answered", "inbox", 360, 380, {}), at("stuck", "For a person", "inbox", 0, 380, {}),
  ], "rosa");
  await addCard("Charged twice for order 2201", "I was charged $30 twice for order 2201. Please refund the extra $30. — Sam");
  await addCard("Broken TV, order 2202", "My TV from order 2202 arrived with a cracked screen. Please refund the $400. — Lee");
  const cardOf = async title => (await flowView(id)).cards.find(one => one.title.startsWith(title));
  // $30: within her limit, so the store refunds it without asking anyone.
  const small = await until("Rosa to refund $30 on her own", async () => { const one = await cardOf("Charged twice"); return one !== undefined && one.stage !== "rosa" ? one : null; }, { timeoutMs: 420_000, everyMs: 3000 });
  if (small.stage !== "refunded" || refunds("2201").length !== 1 || Number(refunds("2201")[0].arguments.amount) !== 30) throw new Error(`the $30 card went to ${small.stage}; refund calls: ${JSON.stringify(refunds("2201"))}`);
  if (!small.calls.some(one => /refund_order/.test(one.words) && one.state === "done" && one.outcome === "Done")) throw new Error(`its receipts: ${JSON.stringify(small.calls)}`);
  // $400: over her limit. The call waits for you (she may ask a plain question first); nothing is refunded yet.
  const asking = await until("Rosa to ask you before refunding $400", async () => {
    const one = await cardOf("Broken TV");
    if (one?.question?.mine && one.question.call == null) {
      await post(`/teammates/questions/${one.question.id}/answer`, { text: "Yes, refund the full $400." });
      return null;
    }
    return one?.question?.mine && one.question.call != null ? one : one !== undefined && one.stage !== "rosa" ? one : null;
  }, { timeoutMs: 420_000, everyMs: 3000 });
  if (asking.question?.call == null) throw new Error(`the $400 card went to ${asking.stage} without asking: ${JSON.stringify(asking.calls)}`);
  if (refunds("2202").length !== 0) throw new Error("the $400 refund was made before anyone approved it");
  if (!/refund_order/.test(asking.question.question) || !/400/.test(asking.question.question)) throw new Error(`what you're asked: ${asking.question.question}`);
  if (rows(`SELECT 1 FROM notification WHERE recipient = 'alex' AND subject LIKE '%Rosa · Support asks to use refund_order%'`).length === 0) throw new Error("you weren't told in your chat app");
  await page.reload(); await page.waitForSelector("[data-zone]");
  await page.locator(`[data-card="${asking.id}"]`).click();
  await page.waitForSelector(`[data-teammate-question="${asking.question.id}"]`);
  await shot("teammate-asks-to-call");
  await page.locator(`[data-teammate-question="${asking.question.id}"] button:has-text("Approve")`).click();
  const approved = await until("the approved $400 refund to be made and Rosa to finish", async () => { const one = await cardOf("Broken TV"); return refunds("2202").length > 0 && one?.stage !== "rosa" ? one : null; }, { timeoutMs: 420_000, everyMs: 3000 });
  const made = refunds("2202");
  if (made.length !== 1 || Number(made[0].arguments.amount) !== 400) throw new Error(`the approved call: ${JSON.stringify(made)}`);
  if (!approved.calls.some(one => /refund_order/.test(one.words) && one.words.includes("amount 400") && one.outcome === "alex approved · done")) throw new Error(`its receipts: ${JSON.stringify(approved.calls)}`);
  if (calls().some(one => one.name === "delete_customer")) throw new Error("a never-allowed action was called");
  await page.reload(); await page.waitForSelector("[data-zone]");
  await page.locator(`[data-card="${approved.id}"]`).click();
  await page.waitForSelector("[data-teammate-calls]");
  await page.evaluate(() => { const one = document.querySelector("[data-teammate-calls]"); if (one) { one.open = true; one.scrollIntoView({ block: "center" }); } });
  await settle(page);
  await shot("teammate-receipts");
  // Her page lists the calls with what came of them; on a phone it fits.
  await page.goto(`${base}/teammates/${mateId}`);
  await page.evaluate(() => { for (const one of document.querySelectorAll("details")) one.open = true; });
  if (!/Used store → refund_order/.test(await page.locator(".teammate-activity").innerText())) throw new Error("her page doesn't list her tool calls");
  const phone = await alexPhone("light");
  await phone.goto(`${base}/teammates/${mateId}#tools`); await phone.waitForLoadState("load"); await settle(phone);
  await phone.screenshot({ path: join(w.out, "teammate-tools-phone.png") });
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await putPhoneDown();
  if (wide) throw new Error("the teammate page scrolls sideways on a phone");
  return { small: small.outputs.find(one => one.stage === "rosa")?.text?.slice(0, 120), big: approved.outputs.find(one => one.stage === "rosa")?.text?.slice(0, 120), calls: calls().map(one => `${one.name} ${JSON.stringify(one.arguments)}`) };
});

// In the rosa group's own world the lead chat isn't on yet: this journey turns it on the same way first.
await journey("rosa", REAL_MODEL, "The lead changes a teammate's tool rule from plain words, as a card you confirm (real Claude turn)", [TOOL_CHECK], async () => {
  if (!leadChatOn) await turnLeadChatOn();
  const { reply } = await askLead("Rosa can refund orders up to $100 in the store without asking me now. Just draft it.");
  const pending = reply.locator('[data-view="chat-card"][data-card-state="pending"]:has([data-card-confirm])');
  await waitFor(pending.first(), "a card changing Rosa's rule in the lead's reply", { seen: async () => `the reply “${(await reply.innerText()).replace(/\s+/g, " ").slice(0, 300)}”` });
  // The lead may draft her soul file's words too: confirm each card it drafted; the rule itself is what's checked.
  for (let left = 3; left > 0 && await pending.count() > 0; left--) {
    const before = await pending.count();
    await pending.first().locator("[data-card-confirm]").click();
    // Done with that card once it is no longer pending; one that never settles is left to the rule check below.
    await until("the confirmed card to settle", async () => (await pending.count()) < before, { timeoutMs: 10_000, everyMs: 250 }).catch(() => undefined);
  }
  const rules = await until("Rosa's refund rule to change", async () => {
    const saved = JSON.parse(rows("SELECT t.rules_json FROM teammate_tool t JOIN teammate m ON m.id = t.teammate WHERE m.handle = 'rosa' AND t.tool = 'store'")[0]?.rules_json ?? "{}");
    return saved.refund_order?.limit?.over === 100 ? saved : null;
  }, { timeoutMs: 30_000, everyMs: 1000 });
  if (rules.refund_order.use !== "free") throw new Error(`Rosa's refund rule: ${JSON.stringify(rules.refund_order)}`);
  return { rule: rules.refund_order };
});

await journey("memory", SCRIPTED, "Teammates remember and learn: Rosa keeps a customer's preference for later cards, you correct her memory, and after approving refunds in a row she suggests a looser rule you accept in one tap (real Claude turns)", [TOOL_CHECK], async () => {
  const mate = rows("SELECT id FROM teammate WHERE handle = 'rosa' AND state = 'active'")[0]?.id;
  const flowId = rows("SELECT id FROM flow WHERE name = 'Refund desk'")[0]?.id;
  if (!mate || !flowId) throw new Error("Rosa or her flow is missing");
  const cardOf = async title => (await flowView(flowId)).cards.find(one => one.title.startsWith(title));
  await page.goto(`${base}/flows/${flowId}`); await page.waitForSelector("[data-zone]");
  script({ role: "teammate", when: [/Title: Question from Priya Shah/], answer: { action: "route", answer: "Nothing to refund", text: "Hi Priya, order 2201 is all sorted: the duplicate $30 was refunded. I'll email you rather than call. — Rosa",
    reason: "A question; the refund was already made.", remember: "Priya Shah prefers store credit over refunds, and email over phone calls." } });
  for (const [at, amount] of [120, 125, 130, 135, 140].entries()) script(rosaRefunds(`Broken chair, order ${2204 + at}`, String(2204 + at), amount));
  // A customer says something worth keeping for later cards.
  await addCard("Question from Priya Shah", "Hi, it's Priya Shah. For anything in future: I always prefer store credit over a refund, and please email me rather than call. Is order 2201 all sorted now? — Priya");
  const kept = await until("Rosa to keep Priya's preference", async () => rows(`SELECT id, text FROM teammate_memory WHERE teammate = ${mate} AND source = 'teammate' AND state = 'active'`).find(one => /priya/i.test(one.text)) ?? null, { timeoutMs: 300_000, everyMs: 3000 });
  // On her page, the memory says where it came from; you correct it.
  await page.goto(`${base}/teammates/${mate}#memory`);
  const line = page.locator(`[data-memory="${kept.id}"]`);
  if (!/kept this from/.test(await line.innerText())) throw new Error(`the memory line: ${await line.innerText()}`);
  await line.locator("summary").click();
  await line.locator("textarea").fill("Priya Shah prefers store credit over refunds, and email over phone calls.");
  await Promise.all([page.waitForNavigation(), line.locator('button:has-text("Save")').click()]);
  if (rows(`SELECT text FROM teammate_memory WHERE id = ${kept.id}`)[0]?.text !== "Priya Shah prefers store credit over refunds, and email over phone calls.") throw new Error("the memory wasn't changed");
  await page.locator("#memory").scrollIntoViewIfNeeded(); await settle(page);
  await shot("teammate-memory");
  // Refunds over her limit, each approved: the approvals in a row teach her to suggest a looser rule.
  await page.goto(`${base}/flows/${flowId}`); await page.waitForSelector("[data-zone]");
  const amounts = [120, 125, 130, 135, 140];
  for (const [at, amount] of amounts.entries()) await addCard(`Broken chair, order ${2204 + at}`, `My chair from order ${2204 + at} arrived broken. Please refund the $${amount}. — Kim`);
  const suggestion = await until("Rosa to suggest a looser refund rule", async () => {
    for (const [at] of amounts.entries()) {
      const one = await cardOf(`Broken chair, order ${2204 + at}`);
      if (one?.question?.mine) await post(`/teammates/questions/${one.question.id}/answer`, one.question.call != null ? { choice: "approve" } : { text: "Yes, refund it in full." });
    }
    return rows(`SELECT id, said, rule_json FROM teammate_suggestion WHERE teammate = ${mate} AND state = 'open'`)[0] ?? null;
  }, { timeoutMs: 600_000, everyMs: 4000 });
  if (!/refund_order/.test(suggestion.said)) throw new Error(`the suggestion: ${suggestion.said}`);
  if (rows(`SELECT 1 FROM notification WHERE recipient = 'alex' AND subject LIKE '%Rosa · Support suggests a rule change%'`).length === 0) throw new Error("her manager wasn't told in their chat app");
  // One tap on her page accepts it: that one rule changes.
  await page.goto(`${base}/teammates/${mate}`);
  const offered = page.locator("[data-suggestion]");
  await offered.waitFor();
  await shot("teammate-suggests");
  const phone = await alexPhone("dark");
  await phone.goto(`${base}/teammates/${mate}`); await phone.waitForLoadState("load"); await settle(phone);
  await phone.screenshot({ path: join(w.out, "teammate-suggests-phone.png") });
  await phone.goto(`${base}/teammates/${mate}#memory`); await phone.waitForLoadState("load"); await settle(phone);
  await phone.screenshot({ path: join(w.out, "teammate-memory-phone.png") });
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await putPhoneDown();
  if (wide) throw new Error("the teammate page scrolls sideways on a phone");
  await Promise.all([page.waitForNavigation(), offered.locator('button:has-text("Yes, change it")').click()]);
  const rule = JSON.parse(rows(`SELECT rules_json FROM teammate_tool WHERE teammate = ${mate} AND tool = 'store'`)[0]?.rules_json ?? "{}").refund_order;
  if (JSON.stringify(rule) !== suggestion.rule_json) throw new Error(`her refund rule is ${JSON.stringify(rule)}, not the suggested ${suggestion.rule_json}`);
  // Let the rest of the refunds finish so nothing is left waiting.
  await until("the chair refunds to finish", async () => {
    let left = 0;
    for (const [at] of amounts.entries()) {
      const one = await cardOf(`Broken chair, order ${2204 + at}`);
      if (one?.question?.mine) await post(`/teammates/questions/${one.question.id}/answer`, one.question.call != null ? { choice: "approve" } : { text: "Yes, refund it in full." });
      if (one?.stage === "rosa") left++;
    }
    return left === 0;
  }, { timeoutMs: 600_000, everyMs: 4000 });
  return { memory: kept.text, suggestion: suggestion.said, rule };
});

await journey("rosa", SCRIPTED, "A teammate's routine: added on its page for weekdays, run now, it looks the order up with its tool and its answer reaches its manager (real Claude turn)", [TOOL_CHECK], async () => {
  const mate = rows("SELECT id FROM teammate WHERE handle = 'rosa' AND state = 'active'")[0]?.id;
  if (!mate) throw new Error("Rosa is missing");
  await page.goto(`${base}/teammates/${mate}#desk`);
  const form = page.locator("form.routine-add");
  await form.locator('input[name="schedule"]').fill("weekdays 09:00");
  const request = [/WHERE YOU ARE: the zone “Requests”/, /Title: Look up order 2201/];
  script(
    { role: "teammate", when: request, unless: [/\d\. store\.lookup_order/], answer: { action: "use_tool", tool: "store.lookup_order", input: { order: "2201" }, reason: "The routine asks for its status." } },
    { role: "teammate", when: [...request, /\d\. store\.lookup_order/], answer: { action: "route", answer: "Done", text: "Order 2201, a $30 desk lamp, was charged twice: one $30 payment is a duplicate, and it has been refunded.", reason: "Answered from the store." } },
  );
  await form.locator('input[name="text"]').fill("Look up order 2201 in the store and tell me its status in one sentence.");
  await Promise.all([page.waitForNavigation(), form.locator("button").click()]);
  const routine = page.locator("[data-routine]").first();
  if (!/weekdays at 09:00/.test(await routine.innerText())) throw new Error(`the routine reads: ${await routine.innerText()}`);
  const desk = rows(`SELECT desk_flow FROM teammate WHERE id = ${mate}`)[0]?.desk_flow;
  if (!desk) throw new Error("Rosa has no desk");
  await Promise.all([page.waitForNavigation(), routine.locator('button:has-text("Run now")').click()]);
  const answer = await until("Rosa's answer to reach her manager", async () => rows("SELECT subject, body FROM notification WHERE kind = 'teammate-reply' AND recipient = 'alex'")[0] ?? null, { timeoutMs: 300_000, everyMs: 3000 });
  if (!/^Rosa · Support: Look up order 2201/.test(answer.subject) || !/2201|lamp|refund/i.test(answer.body)) throw new Error(`the answer: ${answer.subject} — ${answer.body}`);
  const card = (await flowView(desk)).cards[0];
  if (card?.stage !== "done") throw new Error(`the routine's card is in ${card?.stage}`);
  await page.goto(`${base}/teammates/${mate}#desk`); await page.waitForLoadState("load");
  await page.locator("#desk").scrollIntoViewIfNeeded();
  await shot("teammate-desk");
  const phone = await alexPhone("light");
  await phone.goto(`${base}/teammates/${mate}#desk`); await phone.waitForLoadState("load"); await settle(phone);
  await phone.screenshot({ path: join(w.out, "teammate-desk-phone.png") });
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await putPhoneDown();
  if (wide) throw new Error("the teammate page scrolls sideways on a phone");
  return { answer: answer.body.slice(0, 160) };
});

await journey("rosa", SCRIPTED, "A teammate's week and undo: its page shows the week with what its turns cost and what you overrode; name an undo for refunds, undo Rosa's $30 refund from its card, and send the week's report", [TOOL_CHECK], async () => {
  const mate = rows("SELECT id FROM teammate WHERE handle = 'rosa' AND state = 'active'")[0]?.id;
  const flowId = rows("SELECT id FROM flow WHERE name = 'Refund desk'")[0]?.id;
  if (!mate || !flowId) throw new Error("Rosa or her flow is missing");
  if (rows(`SELECT COUNT(*) AS n FROM teammate_turn WHERE teammate = ${mate} AND cost_usd IS NOT NULL`)[0]?.n < 1) throw new Error("no turn kept what it cost");
  // Under Tools → Undo: cancel_refund undoes refund_order.
  await page.goto(`${base}/teammates/${mate}#tools`);
  const store = page.locator('[data-tool-grant="store"]');
  await store.locator("details.tool-undo summary").click();
  await store.locator('select[name="undo.refund_order"]').selectOption("cancel_refund");
  await Promise.all([page.waitForNavigation(), store.locator('button:has-text("Save rules")').click()]);
  if (JSON.parse(rows(`SELECT rules_json FROM teammate_tool WHERE teammate = ${mate} AND tool = 'store'`)[0]?.rules_json ?? "{}").refund_order?.undo !== "cancel_refund") throw new Error("the undo wasn't saved");
  // On the $30 card's receipts: Undo with cancel_refund, made as you with the same input.
  const cardId = (await flowView(flowId)).cards.find(one => one.title.startsWith("Charged twice"))?.id;
  await page.goto(`${base}/flows/${flowId}?card=${cardId}`); await page.waitForSelector(`[data-flow-card-panel="${cardId}"]`);
  await page.evaluate(() => { const one = document.querySelector("[data-teammate-calls]"); if (one) one.open = true; });
  await page.locator("[data-teammate-undo]").first().click();
  const log = join(w.root, "shop-calls.log");
  await until("the refund to be cancelled", async () => readFileSync(log, "utf8").includes('"cancel_refund"'), { timeoutMs: 30_000, everyMs: 500 });
  const cancelled = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(one => one.name === "cancel_refund");
  if (String(cancelled.arguments.order).replace(/^#/, "") !== "2201" || Number(cancelled.arguments.amount) !== 30) throw new Error(`the undo call: ${JSON.stringify(cancelled)}`);
  if (rows("SELECT undone_by FROM teammate_call WHERE action = 'refund_order' AND undone_by IS NOT NULL").length !== 1) throw new Error("the refund isn't marked undone");
  await page.reload(); await page.waitForSelector(`[data-flow-card-panel="${cardId}"]`);
  await page.evaluate(() => { const one = document.querySelector("[data-teammate-calls]"); if (one) { one.open = true; one.scrollIntoView({ block: "center" }); } });
  await settle(page);
  await shot("teammate-undone");
  // Its page: the week, and the report sent now.
  await page.goto(`${base}/teammates/${mate}#week`);
  const week = await page.locator("#week").innerText();
  if (!/Tool calls: \d+ made/.test(week) || !/at API prices/.test(week) || !/undone/.test(week)) throw new Error(`the week reads: ${week.slice(0, 400)}`);
  await Promise.all([page.waitForNavigation(), page.click('#week button:has-text("Send the week\'s report")')]);
  const report = rows("SELECT subject, body FROM notification WHERE kind = 'teammate-weekly' AND recipient = 'alex'")[0];
  if (report?.subject !== "Rosa · Support: the week") throw new Error(`the report: ${JSON.stringify(report)}`);
  await page.locator("#week").scrollIntoViewIfNeeded(); await settle(page);
  await shot("teammate-week");
  return { report: report.body.slice(0, 300) };
});

await journey("flows", SCRIPTED, "Starter kits: the Support desk kit sets up Maya and its flow in one click, its checklist says what's left, and Try it has Maya draft a reply for you to check (real Claude turn)", [], async () => {
  script({ role: "teammate", when: [/WHERE YOU ARE: the zone “Maya answers”/, /Title: Where's my order/], answer: { action: "route", answer: "Reply", text: "Hi Priya, good news: order #1042 shipped on the 15th with UPS and is out for delivery tomorrow. Thanks for your patience! — Maya", reason: "The order's status is in the message." } });
  await page.goto(`${base}/kits`);
  await page.waitForSelector('[data-kit="support-desk"]');
  if ((await page.locator("[data-kit]").count()) !== 4) throw new Error("the gallery doesn't show the four kits");
  await shot("kits-gallery");
  const phone = await alexPhone("dark");
  await phone.goto(`${base}/kits`); await phone.waitForSelector("[data-kit]"); await settle(phone);
  await phone.screenshot({ path: join(w.out, "kits-gallery-phone.png") });
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await putPhoneDown();
  if (wide) throw new Error("the kits gallery scrolls sideways on a phone");
  // One click sets it up; its page is the checklist.
  await Promise.all([page.waitForNavigation(), page.locator('[data-kit="support-desk"] button:has-text("Set it up")').click()]);
  if (!/\/kits\/support-desk/.test(page.url())) throw new Error(`setting it up went to ${page.url()}`);
  const done = async id => (await page.locator(`[data-step="${id}"]`).getAttribute("data-done")) === "true";
  if (!(await done("teammate")) || !(await done("flow")) || await done("sample")) throw new Error("the checklist doesn't read teammate and flow done, sample to try");
  if ((await page.locator('[data-step="tool-stripe"] a:has-text("Connect")').count()) !== 1) throw new Error("the checklist doesn't offer to connect Stripe");
  await shot("kit-checklist");
  const flow = rows("SELECT id FROM flow WHERE name = 'Support desk' AND state = 'active'")[0]?.id;
  if (!flow || rows("SELECT 1 FROM teammate WHERE handle = 'maya' AND state = 'active'").length !== 1) throw new Error("the kit didn't make Maya and the Support desk flow");
  // Try it: a sample customer email, and Maya drafts the reply you check.
  await Promise.all([page.waitForNavigation(), page.locator('[data-step="sample"] button:has-text("Try it")').click()]);
  if (!new RegExp(`/flows/${flow}`).test(page.url())) throw new Error(`Try it went to ${page.url()}`);
  const worked = await until("Maya to draft a reply to the sample", async () => {
    const card = (await flowView(flow)).cards.find(one => one.title.startsWith("Where's my order"));
    return card !== undefined && card.stage !== "answer" ? card : null;
  }, { timeoutMs: 300_000, everyMs: 3000 });
  const draft = worked.outputs.find(one => one.stage === "answer")?.text ?? "";
  if (draft.length < 20) throw new Error(`Maya's draft: ${draft}`);
  // The sample carries the order's status, so Maya can answer it without a tool connected.
  if (worked.stage !== "check") throw new Error(`Maya sent the sample to "${worked.stage}" instead of a reply to check: ${draft.slice(0, 200)}`);
  if (worked.draft?.text !== draft || !worked.canDecide) throw new Error("the reply isn't in front of you to check");
  await page.goto(`${base}/flows/${flow}`); await page.waitForSelector("[data-zone]");
  await shot("kit-flow");
  await page.locator(`[data-card="${worked.id}"]`).click();
  await page.waitForSelector("[data-flow-draft-edit]");
  await shot("kit-sample-draft");
  await page.goto(`${base}/kits/support-desk?repo=${encodeURIComponent(repo)}`);
  if (!(await done("sample"))) throw new Error("the checklist doesn't mark the sample tried");
  return { stage: worked.stage, draft: draft.slice(0, 160) };
});

await journey("flows", SCRIPTED, "One-click connections: Connect Stripe on the kit's checklist, allow it on Stripe's page, and Maya can use it; the sign-in stays out of the database and the worker renews it", ["Starter kits: the Support desk kit sets up Maya and its flow in one click, its checklist says what's left, and Try it has Maya draft a reply for you to check (real Claude turn)"], async () => {
  const { namedPath } = await import(new URL("../dist/names.js", import.meta.url).href);
  const secrets = join(namedPath(homedir(), ["tool-secrets"], { dot: true }), createHash("sha256").update(repo).digest("hex").slice(0, 16), "stripe.json");
  try {
    await page.goto(`${base}/kits/support-desk?repo=${encodeURIComponent(repo)}`);
    await Promise.all([page.waitForNavigation(), page.locator('[data-step="tool-stripe"] a:has-text("Connect")').click()]);
    if (!/\/settings\/tools\?.*kit=support-desk&connect=stripe#connect$/.test(page.url())) throw new Error(`Connect went to ${page.url()}`);
    if ((await page.locator('#connect-stripe[data-state="open"]').count()) !== 1 || (await page.locator(".connect-tile").count()) < 15) throw new Error("the one-click services aren't offered");
    if (!(await page.locator("#connect-heading").isVisible()) || (await page.locator("button.connect-wanted").innerText()) !== `Connect Stripe to ${basename(repo)}`) throw new Error("the page doesn't open on Connect and a Connect Stripe button naming the project");
    if ((await page.locator('select[name="catalog"] option[value="sentry"]').count()) !== 0) throw new Error("Sentry is still offered with a key as well as by signing in");
    await shot("connect-tiles");
    const phone = await alexPhone("light");
    await phone.goto(`${base}/settings/tools?repo=${encodeURIComponent(repo)}&kit=support-desk&connect=stripe#connect`); await phone.waitForSelector("#connect-stripe"); await settle(phone);
    await phone.screenshot({ path: join(w.out, "connect-tiles-phone.png") });
    const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    await putPhoneDown();
    if (wide) throw new Error("the connect tiles scroll sideways on a phone");
    // One click (with the password every new tool takes), then Stripe's own page.
    await page.fill('.tool-connect input[name="password"]', w.passwords.alex);
    await page.click("button.connect-wanted");
    await page.waitForURL(url => url.port === String(stand.port) && url.pathname === "/authorize", { timeout: 30_000 });
    if (stand.registered.at(-1)?.redirect_uris?.[0] !== `${base}/settings/tools/connected`) throw new Error(`registered with ${JSON.stringify(stand.registered.at(-1))}`);
    // Someone else finishing this sign-in (the link sent to them) lands nowhere: the return must come to this browser.
    const elsewhere = await (await fetch(`${base}/settings/tools/connected?state=${new URL(page.url()).searchParams.get("state")}&code=someone-elses`)).text();
    if (!/started in another browser/.test(elsewhere)) throw new Error(`a return from another browser: ${elsewhere.slice(0, 200)}`);
    await Promise.all([page.waitForURL(/\/kits\/support-desk/, { timeout: 30_000 }), page.click('button:has-text("Allow")')]);
    const said = await page.locator('[role="status"]').first().innerText();
    if (!new RegExp(`Stripe is connected to ${basename(repo)}, and Maya can use it`).test(said)) throw new Error(`back on the kit: ${said}`);
    if ((await page.locator('[data-step="tool-stripe"]').getAttribute("data-done")) !== "true") throw new Error("the checklist doesn't say Maya can use Stripe");
    await shot("kit-connected");
    const tool = rows("SELECT spec_json FROM project_tool WHERE name = 'stripe'")[0];
    if (!tool || JSON.parse(tool.spec_json).url !== `${standBase}/mcp`) throw new Error(`the tool: ${JSON.stringify(tool)}`);
    if (rows("SELECT 1 FROM teammate_tool t JOIN teammate m ON m.id = t.teammate WHERE m.handle = 'maya' AND t.tool = 'stripe'").length !== 1) throw new Error("Maya wasn't given Stripe");
    const first = JSON.parse(readFileSync(secrets, "utf8"));
    if (!stand.live.has(first.OAUTH_ACCESS_TOKEN) || !first.OAUTH_REFRESH_TOKEN) throw new Error("the sign-in isn't in the tool's secrets file");
    for (const file of [w.db, `${w.db}-wal`].filter(existsSync)) if (readFileSync(file).includes(first.OAUTH_REFRESH_TOKEN)) throw new Error(`the sign-in reached ${file}`);
    // Two minutes left on it: the worker renews it, and the tool works with the new one.
    await until("the worker to renew the sign-in", async () => stand.grants.some(one => one.grant_type === "refresh_token" && one.refresh_token === first.OAUTH_REFRESH_TOKEN) ? true : null, { timeoutMs: 90_000, everyMs: 1000 });
    const renewed = JSON.parse(readFileSync(secrets, "utf8"));
    if (renewed.OAUTH_ACCESS_TOKEN === first.OAUTH_ACCESS_TOKEN) throw new Error("the renewed sign-in wasn't kept");
    stand.live.delete(first.OAUTH_ACCESS_TOKEN);
    await page.goto(`${base}/settings/tools?repo=${encodeURIComponent(repo)}`);
    await Promise.all([page.waitForNavigation(), page.locator('#tool-stripe button:has-text("Test")').click()]);
    const tested = await page.locator('[role="status"]').first().innerText();
    if (!/stripe works: 2 tools/.test(tested)) throw new Error(`the test after renewal: ${tested}`);
    return { grants: stand.grants.map(one => one.grant_type) };
  } finally {
    rmSync(secrets, { force: true });
  }
});

await journey("pages", SCRIPTED, "Sign-in with an identity provider: turned on in Settings, a person signs in there and gets an account from their groups, their approvals are that sign-in (no password), and a group that may not enter is refused", [], async () => {
  await page.goto(`${base}/settings/sign-in`);
  if (!(await page.locator(".redirect code").innerText()).endsWith("/login/sso/callback")) throw new Error("the page doesn't say which address to register");
  await page.fill('input[name="issuer"]', idpBase); await page.fill('input[name="client-id"]', "so-e2e"); await page.fill('input[name="client-secret"]', `idp-${randomBytes(6).toString("hex")}`);
  await page.locator("details:has(input[name=\"label\"]) > summary").click(); await page.fill('input[name="label"]', "Acme SSO");
  await page.fill('input[name="group-0"]', "eng-leads"); await page.selectOption('select[name="role-0"]', "operator"); await page.selectOption('select[name="projects-0"]', ["all"]);
  await page.fill('.sign-in form input[name="password"]', w.passwords.alex);
  await Promise.all([page.waitForNavigation(), page.click('.sign-in form button:has-text("Turn on sign-in with the provider")')]);
  const said = await page.locator('[role="status"]').first().innerText();
  if (!/People can sign in with Acme SSO/.test(said)) throw new Error(`turning it on: ${said}`);
  await shot("sign-in-settings");
  const context = await w.browser.newContext();
  try {
    const priya = await context.newPage();
    await priya.goto(`${base}/login`);
    await settle(priya); await priya.screenshot({ path: join(w.out, "sign-in-with-provider.png") });
    await Promise.all([priya.waitForURL(/127\.0\.0\.1:\d+\/authorize/), priya.click('a.login-sso:has-text("Sign in with Acme SSO")')]);
    await Promise.all([priya.waitForURL(url => url.port === new URL(base).port && !url.pathname.startsWith("/login"), { timeout: 30_000 }), priya.click('a:has-text("Sign in as priya")')]);
    await priya.waitForSelector("[data-workspace-shell]");
    if (rows("SELECT role FROM approver WHERE name = 'priya'")[0]?.role !== "approver") throw new Error("priya didn't get an operator account from the eng-leads group");
    // A step-up is that sign-in: no password field, and adding a tool goes through.
    await priya.goto(`${base}/settings/tools?repo=${encodeURIComponent(repo)}`);
    await priya.evaluate(() => document.querySelectorAll("details").forEach(one => { if (one.querySelector('select[name="catalog"]')) one.open = true; }));
    if ((await priya.locator('form:has(select[name="catalog"]) [data-sso-step-up="confirmed"]').count()) !== 1 || (await priya.locator('form:has(select[name="catalog"]) input[type="password"]').count()) !== 0) throw new Error("the step-up still asks priya for a password");
    await priya.selectOption('select[name="catalog"]', "chrome-devtools");
    await Promise.all([priya.waitForNavigation(), priya.click('form:has(select[name="catalog"]) button:has-text("Add")')]);
    if (!/Added Chrome DevTools/.test(await priya.locator('[role="status"]').first().innerText())) throw new Error("priya's tool wasn't added");
    await settle(priya); await priya.screenshot({ path: join(w.out, "sign-in-step-up.png") });
    // A group that may not enter.
    await priya.context().clearCookies();
    await priya.goto(`${base}/login`);
    await Promise.all([priya.waitForURL(/\/authorize/), priya.click("a.login-sso")]);
    await Promise.all([priya.waitForLoadState("load"), priya.click('a:has-text("Sign in as sam")')]);
    await priya.waitForSelector(".problem");
    if (!/isn.t in a group that may use Toolroll/.test(await priya.locator(".problem").innerText())) throw new Error("the sales group got in");
  } finally {
    await context.close();
    // Off again: the other checks sign in with passwords on the plain sign-in page.
    await page.goto(`${base}/settings/sign-in`);
    await page.locator("details.card:has(button.danger) > summary").click();
    await page.fill('details.card:has(button.danger) input[name="password"]', w.passwords.alex);
    await Promise.all([page.waitForNavigation(), page.click("button.danger")]);
  }
  const history = rows("SELECT actor, action, outcome, detail FROM action_ledger WHERE source IN ('sign-in','access','policy') ORDER BY id").map(row => `${row.actor}|${row.action}|${row.outcome}`);
  for (const expected of ["alex|sign-in with a provider turned on|changed", "priya|joined|operator", "priya|signed in|Acme SSO", "unknown account|sign-in refused|no matching group", "alex|sign-in with a provider turned off|changed"]) {
    if (!history.includes(expected)) throw new Error(`the ledger lacks ${expected}: ${history.slice(-12).join("; ")}`);
  }
  return { account: "priya" };
});

await journey("flows", SCRIPTED, "Live canvas: a teammate sees who's here and a card move without reloading", ["Code steps: a Python file and a Node script get the card, pass on what they print, pick the next zone, and get a secret"], async () => {
  const sam = await signIn("sam");
  try {
    await sam.goto(`${base}/flows/${codeFlow}`); await sam.waitForSelector("[data-zone]");
    const lead = (await flowView(codeFlow)).cards.find(one => one.stage === "call");
    await page.goto(`${base}/flows/${codeFlow}?card=${lead.id}`); await page.waitForSelector("[data-zone]");
    await until("sam to see alex", async () => /alex is looking at/.test(await sam.locator("[data-also-here]").getAttribute("aria-label") ?? ""), { timeoutMs: 15_000, everyMs: 500 });
    await until("alex's face on the card", async () => (await sam.locator(`[data-card="${lead.id}"] [data-card-lookers]`).count()) === 1, { timeoutMs: 10_000, everyMs: 500 });
    // alex moves the card; sam's canvas follows by itself.
    await page.selectOption("#flow-move", "inbox");
    await until("the card to move on sam's screen", async () => (await sam.locator(`[data-zone="inbox"] [data-card="${lead.id}"]`).count()) === 1, { timeoutMs: 15_000, everyMs: 500 });
    await sam.screenshot({ path: join(w.out, "live-canvas.png") });
  } finally {
    w.openPages.splice(w.openPages.indexOf(sam), 1);
    await sam.context().close();
  }
});

// ------------------------------------------------------------------ the demo

await journey("pages", SCRIPTED, "The demo starts with flows already moving, and opens in a browser", [], async () => {
  const demo = spawnOwned("demo", process.execPath, [w.bin, "demo", "--json"], { env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const started = await new Promise((done, fail) => {
      let text = "";
      const timer = setTimeout(() => fail(new Error(`the demo didn't start: ${text.slice(0, 300)}`)), 60_000);
      demo.stdout.on("data", chunk => { text += chunk; try { const value = JSON.parse(text.slice(text.indexOf("{"))); clearTimeout(timer); done(value.url === undefined ? value.result ?? value : value); } catch { /* more to come */ } });
    });
    const password = /password: (.*)/.exec(readFileSync(started.login.passwordFile, "utf8"))[1].trim();
    const context = await w.browser.newContext({ viewport: { width: 1440, height: 900 } });
    const visitor = await context.newPage();
    await visitor.goto(`${started.url}/login`);
    await visitor.fill('input[name="name"]', started.login.name); await visitor.fill('input[name="token"]', password);
    await Promise.all([visitor.waitForNavigation(), visitor.press('input[name="token"]', "Enter")]);
    await visitor.goto(`${started.url}/flows`);
    const text = await visitor.locator("body").innerText();
    await context.close();
    if (!/Customer replies/.test(text) || !/Support desk/.test(text)) throw new Error(`the demo's flows: ${text.slice(0, 300)}`);
  } finally { await stopGroups([demo.pid]); }
});

await journey("pages", SCRIPTED, "The demo lead: type a request, approve, see it build to Ready, complete, at desktop and phone", [], async () => {
  const demo = spawnOwned("demo", process.execPath, [w.bin, "demo", "--json"], { env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const started = await new Promise((done, fail) => {
      let text = "";
      const timer = setTimeout(() => fail(new Error(`the demo didn't start: ${text.slice(0, 300)}`)), 60_000);
      demo.stdout.on("data", chunk => { text += chunk; try { const value = JSON.parse(text.slice(text.indexOf("{"))); clearTimeout(timer); done(value.url === undefined ? value.result ?? value : value); } catch { /* more to come */ } });
    });
    if (!/[\\/]toolroll-demo-[^\\/]+$/.test(started.sandbox)) throw new Error(`the sandbox folder is ${started.sandbox}`);
    const password = /password: (.*)/.exec(readFileSync(started.login.passwordFile, "utf8"))[1].trim();
    for (const [width, height, asked] of [[1440, 900, "fix the flaky refund test"], [390, 844, "The payouts page copy is confusing"]]) {
      const context = await w.browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      context.setDefaultTimeout(30_000);
      const visitor = await context.newPage();
      const errors = [];
      visitor.on("pageerror", error => errors.push(String(error)));
      visitor.on("console", message => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
      try {
        await visitor.goto(`${started.url}/login`);
        await visitor.fill('input[name="name"]', started.login.name); await visitor.fill('input[name="token"]', password);
        await Promise.all([visitor.waitForNavigation(), visitor.press('input[name="token"]', "Enter")]);
        await visitor.goto(`${started.url}/chat`);
        const banner = await visitor.locator("body").innerText();
        // A phone gets the one-line banner (a terminal command is no use there); a desk gets the full one, which hands off.
        if (!(width === 1440 ? /Nothing calls a model, reaches outside or spends\./ : /Nothing calls a model or spends\./).test(banner)) throw new Error(`the demo banner: ${banner.slice(0, 300)}`);
        if (width === 1440 && !/For your own project, run npx toolroll up in its folder\./.test(banner)) throw new Error(`the demo banner doesn't hand off: ${banner.slice(0, 300)}`);
        if (width === 1440) {
          await visitor.locator(".demo-hint").waitFor();
          if (await visitor.locator(".demo-suggestions button").count() < 2) throw new Error("the first visit shows no suggestions");
          await settle(visitor); await visitor.screenshot({ path: join(w.out, `demo-hint-${width}.png`) });
        }
        await visitor.fill("#demo-message", asked);
        await Promise.all([visitor.waitForNavigation(), visitor.press("#demo-message", "Enter")]);
        const turn = visitor.locator(".demo-turn").last();
        await turn.locator(".demo-plan").getByText("Boundaries").waitFor();
        await settle(visitor); await visitor.screenshot({ path: join(w.out, `demo-plan-${width}.png`) });
        await Promise.all([visitor.waitForNavigation(), turn.getByRole("button", { name: "Approve" }).click()]);
        // The build moves on its own, live, with no reload: planning, building, checks, Ready.
        await turn.locator(".demo-build").waitFor({ timeout: 5_000 });
        await turn.locator(".demo-result").getByText("Ready for review", { exact: true }).waitFor({ timeout: 30_000 });
        const result = await turn.locator(".demo-result").innerText();
        if (!/Checks passed\./.test(result) || !/\+\d+ −\d+/.test(result)) throw new Error(`the Ready result: ${result.slice(0, 400)}`);
        if (await turn.locator(".demo-diff-add").count() === 0) throw new Error("the Ready result shows no diff");
        await turn.getByText("Screenshot", { exact: true }).click();
        const loaded = await turn.locator(".demo-evidence img").evaluate(img => img.complete && img.naturalWidth > 0 ? img.naturalWidth
          : new Promise(done => { img.onload = () => done(img.naturalWidth); img.onerror = () => done(0); setTimeout(() => done(img.naturalWidth), 10_000); }));
        if (loaded < 320) throw new Error("the result's screenshot didn't load");
        await turn.getByText("Screenshot", { exact: true }).click();
        const overflow = await visitor.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1) throw new Error(`the page scrolls sideways by ${overflow}px at ${width} wide`);
        await turn.locator(".demo-result").scrollIntoViewIfNeeded();
        await settle(visitor); await visitor.screenshot({ path: join(w.out, `demo-ready-${width}.png`) });
        await Promise.all([visitor.waitForNavigation(), turn.getByRole("button", { name: "Complete" }).click()]);
        await turn.locator(".demo-result").getByText("Complete", { exact: true }).waitFor();
        await turn.getByText("That's the whole loop").waitFor();
        // ...and so does its last step.
        const handoff = await turn.locator("[data-demo-handoff]").innerText();
        if (!handoff.includes("npx toolroll up")) throw new Error(`the demo's last step: ${handoff}`);
        await turn.locator("[data-demo-handoff]").scrollIntoViewIfNeeded();
        await settle(visitor); await visitor.screenshot({ path: join(w.out, `demo-complete-${width}.png`) });
        if (errors.length > 0) throw new Error(`browser errors at ${width} wide: ${errors.join(" | ").slice(0, 400)}`);
      } finally { await context.close(); }
    }
  } finally { await stopGroups([demo.pid]); }
});

await journey("pages", SCRIPTED, "Signing out ends the session: pages ask to sign in again", [], async () => {
  const sam = await signIn("sam");
  await sam.goto(`${base}/chat`);
  await Promise.all([sam.waitForNavigation(), sam.locator('.so-account form[action="/logout"] button').click()]);
  if (!sam.url().includes("/login")) throw new Error(`signing out went to ${sam.url()}`);
  const answer = await sam.request.get(`${base}/flows`, { maxRedirects: 0 });
  w.openPages.splice(w.openPages.indexOf(sam), 1);
  await sam.context().close();
  if (answer.status() < 300 || answer.status() >= 400) throw new Error(`after signing out, /flows answered ${answer.status()}`);
});

// ------------------------------------------------------------------ onboarding (docs/design/onboarding.md)

/**
 * A stranger's first ten minutes, from an empty home folder: `toolroll up` run in a repository at a real terminal
 * (a pseudo-terminal, no coding agent above it), the browser it opens, and nothing typed but the request. The agent
 * CLIs on the PATH are only the ones a journey puts there: `claude` is this computer's own Claude Code, run with its
 * own home so its sign-in is the real one. Screenshots at 1440 and 390 of each step land in the output folder.
 */
const realClaude = (() => { try { return execFileSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim() || null; } catch { return null; } })();
const fresh = {};
/** Every fresh install started, so each one is stopped whichever journeys pass, fail or time out. */
const installs = [];
async function freshInstall(name, { claude, crewModels = false }) {
  const root = realpathSync(makeTempRoot(`toolroll-onboarding-${name}-`, { keep: flag("--keep") }));
  const home = join(root, "home"), shop = join(root, "shop"), bin = join(root, "bin"), opened = join(root, "opened.txt"), log = join(root, "terminal.log");
  for (const one of [home, shop, bin]) mkdirSync(one);
  // The PATH a stranger's shell might have, minus every agent CLI: node and npm, git, the system's own tools.
  symlinkSync(process.execPath, join(bin, "node"));
  const npm = join(dirname(process.execPath), "npm");
  if (existsSync(npm)) symlinkSync(realpathSync(npm), join(bin, "npm"));
  const signIn = () => {
    // This computer's Claude Code, with its own home and user (its sign-in lives in the user's keychain).
    const user = JSON.stringify(process.env.USER ?? "");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nHOME=${JSON.stringify(homedir())} USER=${user} LOGNAME=${user} exec ${JSON.stringify(realClaude)} "$@"\n`);
    chmodSync(join(bin, "claude"), 0o755);
  };
  if (claude) signIn();
  // The browser `up` opens: the one-time link is handed to this program, never printed. The journey's browser opens it.
  writeFileSync(join(bin, "open-browser"), `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(opened)}\n`);
  chmodSync(join(bin, "open-browser"), 0o755);
  // A small project with a test and one note to fix.
  writeFileSync(join(shop, "package.json"), JSON.stringify({ name: "shop", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  mkdirSync(join(shop, "src")); mkdirSync(join(shop, "test"));
  writeFileSync(join(shop, "src/math.js"), "// TODO: add a subtract(a, b) function next to add\nexport const add = (a, b) => a + b;\n");
  writeFileSync(join(shop, "test/math.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('adds', () => assert.equal(add(2, 3), 5));\n");
  writeFileSync(join(shop, "README.md"), "# Shop\n\nA tiny shop library.\n");
  const git = (...args) => execFileSync("git", ["-C", shop, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main"); git("add", "."); git("-c", "user.name=Sam Rivera", "-c", "user.email=sam@example.invalid", "commit", "-qm", "First version");
  const env = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, USER: "sam", LANG: "en_US.UTF-8", TERM: "xterm-256color", TMPDIR: join(root, "tmp"),
    TOOLROLL_BROWSER_COMMAND: join(bin, "open-browser"), TOOLROLL_NO_PLAN_PROBE: "1",
    GIT_AUTHOR_NAME: "Sam Rivera", GIT_AUTHOR_EMAIL: "sam@example.invalid", GIT_COMMITTER_NAME: "Sam Rivera", GIT_COMMITTER_EMAIL: "sam@example.invalid" };
  mkdirSync(env.TMPDIR);
  const terminal = () => existsSync(log) ? readFileSync(log, "utf8").replace(/\r/g, "").replace(/\^D\x08\x08/g, "") : "";
  const install = { root, home, shop, bin, terminal, signIn, groups: [], stopped: false };
  // Stops `script` and `up`, each with its whole process group; once is enough, and it is safe to ask again.
  install.stop = async () => { if (install.stopped) return; install.stopped = true; await stopGroups(install.groups); };
  installs.push(install);
  try {
    // A port that is taken by the time `up` binds it (something else got it first) is a refusal `up` prints at once:
    // the install starts again on another port.
    for (let attempt = 1; ; attempt += 1) {
      install.port = await freePort();
      install.base = `http://127.0.0.1:${install.port}`;
      const ended = await startUp(install, { name, env, log, opened, upPid: join(root, "up.pid"), go: join(root, "up.go") });
      if (ended === null) break;
      if (attempt >= 3 || !/port \d+ is taken/.test(ended)) throw new Error(`${name}: toolroll up ended before it opened the browser — ${ended}`);
      // Started again from an empty home folder, as the first try did.
      await stopGroups(install.groups.splice(0));
      rmSync(home, { recursive: true, force: true }); mkdirSync(home);
    }
    const state = (() => { for (const one of [join(home, ".config", "toolroll"), join(home, ".toolroll"), join(home, ".config", "standing-orders")]) if (existsSync(join(one, "orders.db"))) return one; throw new Error(`no database under ${home}`); })();
    Object.assign(install, { state, db: join(state, "orders.db"), link: readFileSync(opened, "utf8") });
    // Not yet automatic (see the onboarding handoff): a fresh install has no exact crew models (approvals bind exact
    // routing, so a first task would wait at Plan) and no project check (so a result could never be Ready). The setup a
    // person does once, from the terminal, before anything is filed.
    if (crewModels) {
      const [who, secret] = readFileSync(join(state, "up-login.txt"), "utf8").trim().split(" ");
      const toolroll = (...args) => execFileSync(process.execPath, [w.bin, ...args, "--as", who, "--token", secret, "--db", join(state, "orders.db")], { stdio: "ignore", env: { ...process.env, HOME: home } });
      for (const phase of ["plan", "build", "repair", "review"]) toolroll("config", "set", phase, "--provider", "claude", "--model", "sonnet");
      toolroll("verify", "set", "--repo", realpathSync(shop), "--command", "npm test", "--timeout-seconds", "120", "--yes");
    }
    return install;
  } catch (error) {
    await install.stop();
    throw error;
  }
}
const shellWord = text => `'${String(text).replace(/'/g, "'\\''")}'`;
/**
 * `toolroll up` at a real terminal, as a person starts it: `script` gives it one (a pseudo-terminal, and a session and
 * so a process group of its own). The shell that starts `script` exits at once, so nothing of this run is above `up`:
 * it walks the programs above it to tell whether a coding agent started it (then it opens no browser), and with this
 * run in between that would turn on whatever runs the run. `up` waits for the word to go until that shell has gone.
 * Both process groups (`script`'s and `up`'s) belong to the install. Resolves null once `up` has opened the browser,
 * or what it printed when it ended first.
 */
async function startUp(install, { name, env, log, opened, upPid, go }) {
  for (const one of [opened, upPid, go, log]) rmSync(one, { force: true });
  const up = [process.execPath, w.bin, "up", "--port", String(install.port), "--for", String(40 * 60_000)].map(shellWord).join(" ");
  const inner = `echo $$ > ${shellWord(upPid)}; while [ ! -e ${shellWord(go)} ]; do sleep 0.05; done; exec ${up}`;
  const shell = spawnOwned(`script for toolroll up (${name})`, "/bin/sh", ["-c", `cd ${shellWord(install.shop)} && exec script -q /dev/null /bin/sh -c ${shellWord(inner)} < /dev/null > ${shellWord(log)} 2>&1 &`], { stdio: "ignore", env });
  install.groups.push(shell.pid);
  await new Promise(done => { if (shell.exitCode !== null) done(); else shell.once("exit", done); });
  const running = () => groupAlive(shell.pid);
  await until(`${name}: the terminal to start toolroll up`, async () => { if (existsSync(upPid) && readFileSync(upPid, "utf8").endsWith("\n")) return true; if (!running()) throw new GiveUp(`script ended: ${install.terminal().slice(-300)}`); return false; }, { timeoutMs: 60_000, everyMs: 100 });
  install.groups.push(own(Number(readFileSync(upPid, "utf8")), `toolroll up (${name})`));
  writeFileSync(go, "");
  // The real signal is `up` opening the browser, or `up` ending; the time limit is only a backstop for a hung start.
  let ended = null;
  await until(`${name}: toolroll up to open the browser`, async () => {
    if (existsSync(opened) && readFileSync(opened, "utf8").startsWith(install.base)) return true;
    if (!running()) { ended = install.terminal().trim().slice(-400) || "it printed nothing"; return true; }
    return false;
  }, { timeoutMs: 10 * 60_000, everyMs: 250, seen: install.terminal });
  return ended;
}
/** A screenshot at 1440 and at 390 of the same page, settled. */
async function bothSizes(on, name) {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await on.setViewportSize({ width, height });
    // Laid out at the new size: two frames after the resize, then any animation it started.
    await settle(on);
    const overflow = await on.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) throw new Error(`${name} scrolls sideways by ${overflow}px at ${width} wide`);
    await on.screenshot({ path: join(w.out, `onboarding-${name}-${width}.png`) });
  }
  await on.setViewportSize({ width: 1440, height: 900 });
}
/** The terminal as the person saw it, drawn for the screenshots (the captured output, verbatim). */
async function terminalShot(text, name) {
  const context = await w.browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const on = await context.newPage();
  const lines = text.split("\n").map(one => one.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("\n");
  await on.setContent(`<!doctype html><meta name="viewport" content="width=device-width"><title>Terminal</title><body style="margin:0;background:#0b0b0b;color:#ededed;font:14px/1.6 ui-monospace,Menlo,monospace">` +
    `<p style="margin:0;padding:10px 16px;color:#a1a1a1;font:12px system-ui;border-bottom:1px solid #262626">Captured terminal output, toolroll up in ~/shop (onboarding journey)</p>` +
    `<pre style="margin:0;padding:16px;white-space:pre-wrap;overflow-wrap:anywhere">$ npx toolroll up\n${lines}</pre></body>`);
  await bothSizes(on, name);
  await context.close();
}
const freshRows = (db, query) => JSON.parse(execFileSync("sqlite3", ["-json", db, query], { encoding: "utf8" }).trim() || "[]");

await journey("onboarding", SCRIPTED, "A fresh install with Claude Code signed in reaches a filed first task without a password or a form", [], async () => {
  if (realClaude === null) throw new Skip("needs Claude Code installed and signed in on this computer");
  const install = fresh.claude = await freshInstall("claude", { claude: true, crewModels: true });
  // 1. Three lines: where it is, that it opens signed in, and what to do if it doesn't. No password, no link.
  await until("the three-line greeting", async () => /Opening it in your browser now/.test(install.terminal()), { timeoutMs: 30_000, seen: install.terminal });
  const said = install.terminal().split("\n").filter(one => one.trim() !== "");
  const [account, password] = readFileSync(join(install.state, "up-login.txt"), "utf8").trim().split(" ");
  const greeting = said.slice(said.findIndex(one => one.startsWith("Toolroll is on ")), said.findIndex(one => one.startsWith("Toolroll is on ")) + 3);
  if (greeting.length !== 3 || greeting[0] !== `Toolroll is on ${install.base}/` || greeting[1] !== "Opening it in your browser now, already signed in." || !greeting[2].startsWith(`If it doesn't open, go to that address and sign in as ${account}: the password is in ~/`)) throw new Error(`the greeting: ${said.join(" | ")}`);
  if (said.length > 4) throw new Error(`more than the greeting was printed: ${said.join(" | ")}`);
  if (install.terminal().includes(password) || install.terminal().includes("/login/once/")) throw new Error("the terminal shows the password or the sign-in link");
  await terminalShot(said.join("\n"), "1-terminal");
  // 2. The browser opens signed in, on Chat.
  const context = await w.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const on = await context.newPage();
  install.page = on;
  w.openPages.push(on);
  on.on("pageerror", error => { if (!SKIPPED_FADE.test(String(error))) w.problems.push(`fresh install on ${on.url()}: ${String(error)}`); });
  const visited = [];
  on.on("framenavigated", frame => { if (frame === on.mainFrame()) visited.push(new URL(frame.url()).pathname); });
  await on.goto(install.link);
  if (new URL(on.url()).pathname !== "/chat") throw new Error(`the link landed on ${on.url()}`);
  if (visited.includes("/login")) throw new Error(`a sign-in page came up: ${visited.join(" → ")}`);
  // 3. The lead is already on with the Claude Code sign-in; 4. how it works, once, above the composer, with first tasks.
  await waitFor(on.locator("[data-lead-line]"), "the line saying what runs the lead", { timeoutMs: 30_000, seen: async () => (await on.locator("main").innerText()).slice(0, 400) });
  const lead = await on.locator("[data-lead-line]").innerText();
  if (lead !== "The lead uses your Claude Code sign-in · Change") throw new Error(`the lead line: ${lead}`);
  if (await on.locator('a[href="/settings/lead"]', { hasText: "Change" }).count() !== 1) throw new Error("no Change link to Settings → Lead");
  const intro = await on.locator("[data-how-it-works]").innerText();
  if (!intro.startsWith("Ask for a change. The lead writes a short plan; you approve it;")) throw new Error(`how it works: ${intro}`);
  const firstTasks = on.locator("[data-first-tasks] button");
  if (await firstTasks.count() !== 3) throw new Error(`${await firstTasks.count()} first tasks`);
  if (await on.locator('input[type="password"], form[action="/chat/config"]').count() > 0) throw new Error("Chat asks for a password or shows the setup form");
  await bothSizes(on, "2-chat-signed-in");
  // The lead's answer to the first request: the task, as a card to confirm; then the plan and the build it leads to.
  script(
    { role: "lead", when: [/File it as a task\./], answer: { steps: [
      { text: "Checking what can run here.", calls: [{ name: "get_capabilities" }, { name: "list_repos" }] },
      { text: "I'll draft that as a task.", calls: [{ name: "propose_task", arguments: { repo: "r1", title: "Add subtract(a, b) next to add", goal: "Add subtract(a, b) to src/math.js next to add, as the TODO says, with a test.",
        acceptance: [{ id: "c1", statement: "subtract(a, b) returns a minus b, with a test", evidence: ["check"] }], planning: "auto" } }] },
      { text: "Here's the task: confirm it and the planner writes a short plan for you to approve.", calls: [] },
    ] } },
    { role: "builder", when: [/subtract/], answer: { files: mathFiles(), conclusion: "Added subtract(a, b) next to add, with a test." } },
  );
  // The first request: the note in the project, drafted by a tap and sent.
  const note = firstTasks.filter({ hasText: "subtract" });
  await (await note.count() > 0 ? note.first() : firstTasks.first()).click();
  const draft = await on.inputValue("[data-workspace-composer] textarea");
  if (draft.trim() === "") throw new Error("the tap drafted nothing");
  await on.fill("[data-workspace-composer] textarea", `${draft} File it as a task.`);
  const before = await on.locator("[data-workspace-chat] [data-message-id]").count();
  await on.click('[data-workspace-composer] button[type="submit"]');
  await until("the lead's reply to the first request", async () => (await on.locator("[data-workspace-chat] [data-message-id]").count()) >= before + 2, { timeoutMs: REAL_TURN_MS, everyMs: 2000 });
  const reply = on.locator("[data-workspace-chat] [data-message-id]").last();
  const card = reply.locator('[data-view="chat-card"][data-card-state="pending"]').first();
  await waitFor(card, "the task the lead proposes", { timeoutMs: 30_000, seen: async () => (await reply.innerText()).replace(/\s+/g, " ").slice(0, 400) });
  await card.locator("[data-card-confirm]").click();
  await until("the first task to be filed", async () => freshRows(install.db, "SELECT id, title FROM task").length > 0, { timeoutMs: 60_000 });
  const [task] = freshRows(install.db, "SELECT id, title FROM task ORDER BY rowid LIMIT 1");
  install.task = task;
  // Nothing was typed but the request: no password field was ever filled and no form submitted but Chat's.
  const signIns = freshRows(install.db, "SELECT actor, outcome FROM action_ledger WHERE source = 'sign-in'");
  if (!signIns.some(one => one.outcome === "one-time link") || signIns.some(one => one.outcome === "browser")) throw new Error(`sign-ins: ${JSON.stringify(signIns)}`);
  return { task: task.id, title: task.title };
});

await journey("onboarding", SCRIPTED, "The first task's timeline fills in as it moves, and after its first result the phone is offered", ["A fresh install with Claude Code signed in reaches a filed first task without a password or a form"], async () => {
  const install = fresh.claude, on = install.page;
  // The step it's on; "ready" once every step is done (none is current then).
  const stepNow = async () => on.evaluate(() => {
    const list = document.querySelector("[data-first-task-journey]");
    if (list === null) return null;
    return list.querySelector('[aria-current="step"]')?.getAttribute("data-step") ?? (list.querySelector('[data-step="ready"][data-state="done"]') ? "ready" : null);
  }).catch(() => null);
  await on.goto(`${install.base}/chat?task=${encodeURIComponent(install.task.id)}`);
  await waitFor(on.locator("[data-first-task-journey]").first(), "the first task's timeline", { timeoutMs: 30_000 });
  const shotAt = new Set();
  const capture = async step => { if (shotAt.has(step)) return; shotAt.add(step); await bothSizes(on, `3-task-${step}`); };
  await capture(await stepNow() ?? "plan");
  const [, secret] = readFileSync(join(install.state, "up-login.txt"), "utf8").trim().split(" ");
  await until("the plan to be ready to approve", async () => (await stepNow()) === "approve" || freshRows(install.db, "SELECT state FROM task WHERE state IN ('failed','cancelled')").length > 0, { timeoutMs: 6 * 60_000, everyMs: 3000, seen: stepNow });
  if (await stepNow() !== "approve") throw new Error(`the first task stopped at ${await stepNow()}`);
  await capture("approve");
  // You approve: the saved password, from the file `up` printed the place of.
  const password = secret;
  await on.goto(`${install.base}/t/${encodeURIComponent(install.task.id)}#approve`);
  const approve = on.locator("form.approve-form").first();
  await waitFor(approve, "the approval form");
  await on.evaluate(() => { for (const one of document.querySelectorAll("details:not(.approval-edit)")) one.open = true; });
  await approve.locator('input[name="token"]').fill(password);
  await Promise.all([on.waitForNavigation(), approve.locator('button[type="submit"]').first().click()]);
  const said = (await on.locator(".problem, [role=alert]").allInnerTexts().catch(() => [])).join(" | ");
  await on.goto(`${install.base}/chat?task=${encodeURIComponent(install.task.id)}`);
  await until("the approval to take", async () => (await stepNow()) !== "approve", { timeoutMs: 30_000, seen: async () => `step ${await stepNow()}; the approval page said: ${said.slice(0, 300)}` });
  for (const step of ["build", "checks"]) {
    await until(`the first task to reach ${step}`, async () => { const now = await stepNow(); return now === step || ["checks", "ready"].includes(now); }, { timeoutMs: 6 * 60_000, everyMs: 1000, seen: stepNow });
    const now = await stepNow();
    if (now === step) await capture(step);
  }
  // The build's result: Ready, or held with its reason. Either way the timeline says where, never further than it is.
  await until("the first build's result", async () => freshRows(install.db, "SELECT 1 FROM task WHERE state = 'done'").length > 0, { timeoutMs: 6 * 60_000, everyMs: 2000, seen: stepNow });
  await on.reload();
  await until("the timeline to show the result", async () => ["ready", "checks"].includes(await stepNow()), { timeoutMs: 30_000, seen: stepNow });
  const ended = await stepNow();
  if (ended === "checks" && await on.locator('[data-first-task-journey] [data-step="checks"][data-state="stuck"]').count() === 0) throw new Error("a held result isn't marked at Checks");
  await bothSizes(on, `3-task-result-${ended}`);
  // After the first Ready result: one card offers the phone.
  await on.goto(`${install.base}/chat`);
  await waitFor(on.locator("[data-phone-card]"), "the phone card after the first Ready result", { timeoutMs: 30_000 });
  const phone = await on.locator("[data-phone-card]").innerText();
  if (!/Pair Telegram/.test(phone) || !/Tailscale/.test(phone)) throw new Error(`the phone card: ${phone}`);
  await bothSizes(on, "4-phone");
  return { result: ended };
});

await journey("onboarding", SCRIPTED, "With no agent signed in, Chat shows the exact install and sign-in command and turns the lead on by itself", [], async () => {
  if (realClaude === null) throw new Skip("needs Claude Code installed and signed in on this computer (to sign in partway through)");
  const install = fresh.none = await freshInstall("none", { claude: false });
  const context = await w.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const on = await context.newPage();
  w.openPages.push(on);
  try {
    await on.goto(install.link);
    if (new URL(on.url()).pathname !== "/chat") throw new Error(`the link landed on ${on.url()}`);
    const command = process.platform === "win32" ? "npm install -g @anthropic-ai/claude-code; claude auth login" : "npm install -g @anthropic-ai/claude-code && claude auth login";
    await waitFor(on.locator("[data-sign-in-command] code", { hasText: command }), "the exact install and sign-in command", { timeoutMs: 30_000, seen: async () => (await on.locator("main").innerText()).slice(0, 400) });
    if (await on.locator('form[action="/chat/config"], input[type="password"]').count() > 0) throw new Error("Chat shows the setup form or asks for a password");
    await waitFor(on.locator("[data-first-run-recheck]"), "the note that it checks again on its own");
    await bothSizes(on, "5-no-agent");
    // The person runs the command in a terminal; nobody touches the page. It asks again on its own and the lead turns on.
    let loads = 0;
    on.on("load", () => { loads += 1; });
    install.signIn();
    await waitFor(on.locator("[data-lead-line]"), "the lead to turn on by itself", { timeoutMs: 60_000, seen: async () => (await on.locator("main").innerText()).slice(0, 400) });
    if (loads === 0) throw new Error("the page did not update itself");
    if (await on.locator("[data-workspace-composer] textarea").count() !== 1) throw new Error("no composer once the lead is on");
    await bothSizes(on, "6-no-agent-then-on");
  } finally { await context.close(); w.openPages.splice(w.openPages.indexOf(on), 1); }
});

await journey("onboarding", SCRIPTED, "Another address shows what it is, where Toolroll answers, and the exact command", [], async () => {
  const install = fresh.claude ?? fresh.none ?? await freshInstall("host", { claude: false });
  const other = await w.browser.browserType().launch({ args: [`--host-resolver-rules=MAP studio.lan 127.0.0.1`] });
  try {
    for (const [colorScheme, width, height] of [["light", 1440, 900], ["dark", 390, 844], ["dark", 1440, 900], ["light", 390, 844]]) {
      const context = await other.newContext({ viewport: { width, height }, colorScheme, deviceScaleFactor: 1 });
      const on = await context.newPage();
      const answer = await on.goto(`http://studio.lan:${install.port}/chat`);
      if (answer.status() !== 421) throw new Error(`studio.lan answered ${answer.status()}`);
      const text = await on.locator("main").innerText();
      const command = `toolroll up --port ${install.port} --allow-host studio.lan:${install.port}`;
      if (!text.includes(`You opened it at studio.lan:${install.port}`) || !text.includes(command)) throw new Error(`the page says: ${text}`);
      const overflow = await on.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) throw new Error(`the page scrolls sideways at ${width}`);
      await on.screenshot({ path: join(w.out, `onboarding-7-wrong-host-${colorScheme}-${width}.png`) });
      await context.close();
    }
    // localhost and 127.0.0.1 on the served port need nothing.
    for (const host of ["localhost", "127.0.0.1"]) {
      const answer = await fetch(`http://${host}:${install.port}/login`);
      if (answer.status !== 200) throw new Error(`${host} answered ${answer.status}`);
    }
  } finally {
    await other.close();
    // The last onboarding journey: every install stops here, the host one included, however the journeys went.
    for (const one of installs) await one.stop();
  }
});

standIn.close(); standIn.closeAllConnections(); idpServer.close(); idpServer.closeAllConnections();
// An install a selection of journeys left running (--only without the last one); finish stops anything else still owned.
for (const one of installs) await one.stop().catch(error => w.say(`couldn't stop a fresh install: ${error.message}`));
await w.finish(group === null ? "Toolroll end to end" : `Toolroll end to end: ${group}`);

