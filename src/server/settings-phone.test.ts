/**
 * Settings → Phone handlers (the companion perfect pass, contract §5): the page in every state it can be in — no
 * password, access off, each path's state, the pairing in progress and each outcome, the phones list — and its acts
 * (pair, confirm, cancel, rename, remove) and the pairing's JSON for the poller. The companion engine is the frozen §7
 * door (phone-engine-api.ts), mocked here, so these hold before and after stream B's engine replaces the adapters.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { PhoneAccess } from "../companion/access.js";
import { htmlString } from "../html.js";
import { addApprover } from "../scope.js";
import { openStore, type Store } from "../store.js";
import type { Screen } from "./chrome.js";
import type { HandlerContext } from "./handler-context.js";
import type { DirectPathState, HostedPathState, PairingView, PhoneRow } from "./phone-engine-api.js";
import { requestContext } from "./request-context.js";
import { ROUTES } from "./route-table.js";
import { createPhoneSettingsHandlers, PHONE_PAIRING_SCRIPT, spokenCode } from "./settings-phone.js";

const engine = vi.hoisted(() => ({
  paths: null as null | { direct: DirectPathState; hosted: HostedPathState },
  views: new Map<string, PairingView>(),
  bindings: new Map<string, string>(),
  phones: [] as PhoneRow[],
  started: null as null | { ok: true; qr: { pairSessionId: string; [key: string]: unknown }; expiresAtMs: number } | { ok: false; error: string },
  confirmed: { ok: true, deviceId: "dev-1" } as { ok: true; deviceId: string } | { ok: false; error: string },
  calls: [] as unknown[][],
}));
vi.mock("./phone-engine-api.js", () => ({
  pathStates: () => engine.paths!,
  pairingView: (_service: unknown, id: string, binding: string) => engine.bindings.get(id) === binding ? engine.views.get(id) ?? null : null,
  startPairing: (_service: unknown, account: string, binding: string, generation: number) => {
    engine.calls.push(["start", account, binding, generation]);
    if (engine.started?.ok === true) {
      const id = engine.started.qr.pairSessionId;
      engine.bindings.set(id, binding);
      engine.views.set(id, { pairSessionId: id, status: "awaiting_scan", expiresAtMs: engine.started.expiresAtMs, confirmCode: null, deviceName: null, deviceId: null, error: null });
    }
    return engine.started;
  },
  confirmPairing: async (_service: unknown, id: string) => { engine.calls.push(["confirm", id]); return engine.confirmed; },
  cancelPairing: (_service: unknown, id: string) => { engine.calls.push(["cancel", id]); return true; },
  listPhones: (_store: unknown, opts: { accountName?: string }) => engine.phones.filter(one => opts.accountName === undefined || one.accountName === opts.accountName),
  renamePhone: (_store: unknown, deviceId: string, name: string, account: string) => {
    engine.calls.push(["rename", deviceId, name, account]);
    return engine.phones.some(one => one.deviceId === deviceId && one.accountName === account && one.state !== "retired");
  },
  removePhone: (service: unknown, _store: unknown, deviceId: string, account: string) => {
    engine.calls.push(["remove", service === null ? "off" : "running", deviceId, account]);
    return engine.phones.some(one => one.deviceId === deviceId && one.accountName === account && one.state !== "retired");
  },
  listPasskeys: () => [],
  isPasskeyEnrollmentOpen: () => false,
  openPasskeyEnrollment: () => ({ expiresAtMs: Date.now() + 300_000 }),
  revokePasskey: () => false,
}));

let dir: string, store: Store, password = "", nopassPassword = "";
const NOW = new Date("2026-11-27T14:00:00Z");
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "so-phone-settings-"));
  store = openStore(join(dir, "toolroll.db"));
  const alex = addApprover(store, "alex", NOW); if (!alex.ok) throw new Error("bootstrap");
  password = alex.token;
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: alex.token }); if (!sam.ok) throw new Error("second");
  nopassPassword = sam.token;
  store.raw().prepare("UPDATE approver SET password_set = 0 WHERE name = 'sam'").run();
});
afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const LISTENING: DirectPathState = { state: "listening", port: 4199, error: null, tailscale: "found",
  addresses: [{ address: "192.168.1.20", kind: "lan", interface: "en0" }, { address: "100.101.102.103", kind: "tailnet", interface: "utun4" }] };
const HOSTED_OFF: HostedPathState = { state: "off" };
const SERVICE = { name: "service-1" };

type World = { on: boolean; service: object | null; hostedEnabled: boolean; hostedUrl: string | null };
let world: World;
const access: PhoneAccess = {
  service: () => world.service as never,
  enabled: () => world.on,
  hostedEnabled: () => world.hostedEnabled,
  hostedApprovalStale: () => false,
  hostedChoice: () => world.hostedUrl === null ? { ok: false, off: true } : { ok: true, url: world.hostedUrl },
  problems: () => [],
  change: async () => "ok",
  resume: async () => {},
  stop: async () => {},
};

beforeEach(() => {
  world = { on: true, service: SERVICE, hostedEnabled: false, hostedUrl: "wss://relay.toolroll.dev" };
  engine.paths = { direct: LISTENING, hosted: HOSTED_OFF };
  engine.views.clear(); engine.bindings.clear(); engine.phones = []; engine.calls = [];
  engine.started = { ok: true, qr: { pairSessionId: "pair_aaaaaaaaaaaaaaaa", macStaticPub: "k", pairPsk: "secret-psk" }, expiresAtMs: NOW.getTime() + 300_000 };
  engine.confirmed = { ok: true, deviceId: "dev-1" };
});

class FakeResponse {
  statusCode = 0; headers: Record<string, unknown> = {}; body = "";
  setHeader(name: string, value: unknown) { this.headers[name.toLowerCase()] = value; }
  getHeader(name: string) { return this.headers[name.toLowerCase()]; }
  writeHead(status: number, headers: Record<string, unknown> = {}) { this.statusCode = status; for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v; return this; }
  end(body?: string) { if (body !== undefined) this.body += body; }
}

type Answer = { status: number; screen: Screen | null; body: string; location: string | null; json: unknown };
function handlers(platform: NodeJS.Platform = "darwin") {
  let shown: { status: number; s: Screen } | null = null;
  const runtime = {
    store, clock: () => NOW,
    sendScreen: (_response: unknown, status: number, s: Screen) => { shown = { status, s }; },
    chromeFor: () => undefined,
  } as never;
  const made = createPhoneSettingsHandlers(runtime, { access, platform });
  const byId = new Map(made.registrations.map(one => [one.id, one.handle as (ctx: HandlerContext) => Promise<void>]));
  const session = (name: string) => ({ via: "cookie", name, session: { csrf: `csrf-${name}`, generation: store.accountOf(name)!.generation } });
  return async (id: string, path: string, options: { as?: string; form?: Record<string, string | string[]> } = {}): Promise<Answer> => {
    shown = null;
    const response = new FakeResponse();
    const posted = new URLSearchParams();
    for (const [key, value] of Object.entries(options.form ?? {})) for (const one of [value].flat()) posted.append(key, one);
    const who = session(options.as ?? "alex");
    const ctx = { url: new URL(path, "http://toolroll.local"), who, request: {}, response, route: ROUTES.find(one => one.id === id)!, now: NOW, project: null, chosenProject: null, posted } as unknown as HandlerContext;
    await requestContext.run({ csrf: who.session.csrf, returnTo: path, actor: who.name } as never, () => byId.get(id)!(ctx));
    const screen = shown as { status: number; s: Screen } | null;
    // Apostrophes read as typed (the templates escape every interpolated one).
    const body = (screen === null ? response.body : htmlString(screen.s.body)).replace(/&#39;/g, "'");
    const location = (response.getHeader("location") as string | undefined) ?? null;
    const json = String(response.getHeader("content-type") ?? "").startsWith("application/json") ? JSON.parse(response.body) : null;
    return { status: screen?.status ?? response.statusCode, screen: screen?.s ?? null, body, location, json };
  };
}

const primaries = (body: string) => (body.match(/k-btn-primary/g) ?? []).length;
const visible = (body: string, view: string) => new RegExp(`data-view="${view}"(?! hidden)>`).test(body);

describe("the page", () => {
  test("an account without a password gets one notice and the way to set one, and no act it can't finish (U1)", async () => {
    const get = handlers();
    const page = await get("settings.phone", "/settings/phone", { as: "sam" });
    expect(page.body).toContain("Set a password to pair a phone.");
    expect(page.body).toContain('href="/password/set?next=%2Fsettings%2Fphone"');
    expect(page.body).not.toContain("/settings/phone/pair");
    expect(page.body).not.toContain("/settings/phone/access");
    expect(page.body).not.toContain('id="phone-pair"');
    expect(primaries(page.body)).toBe(1);
    // The server still refuses the act itself.
    const tried = await get("settings.phone-pair", "/settings/phone/pair", { as: "sam", form: { password: nopassPassword } });
    expect(tried.status).toBe(403);
    expect(tried.body).toContain("Set a password to pair a phone.");
    expect(engine.calls).toEqual([]);
  });

  test("off: the operator's turn-on form names who runs the relay and what it sees; nothing to pair yet", async () => {
    world = { ...world, on: false, service: null };
    const page = await handlers()("settings.phone", "/settings/phone");
    expect(page.body).toContain("iPhone app");
    expect(page.body).toContain("Turn on phone access");
    expect(page.body).toContain("relay.toolroll.dev</code>, run by Toolroll. It's end-to-end encrypted: the relay sees when your phone and this Mac connect, never what they send, and it can't act for you.");
    expect(page.body).toContain("Turn on phone access first.");
    expect(page.body).toContain("The iPhone app isn't on the App Store yet.");
    expect(page.body).toContain("docs/companion-app.md");
    expect(primaries(page.body)).toBe(1);
  });

  test("on: each address labelled, the firewall and sleep line, and Pair as the one ink act (U7, U8, U13)", async () => {
    world.hostedEnabled = false;
    const page = await handlers()("settings.phone", "/settings/phone");
    expect(page.body).toMatch(/Wi-Fi \/ Ethernet<\/span><code class="k-mono">192\.168\.1\.20:4199<\/code>/);
    expect(page.body).toMatch(/Tailscale<\/span><code class="k-mono">100\.101\.102\.103:4199<\/code>/);
    expect(page.body).not.toContain("Tailscale: not found");
    expect(page.body).toContain("If macOS asks whether Toolroll may accept incoming connections, click Allow. Phones can't reach this Mac while it's asleep.");
    expect(page.body).toContain("Pair an iPhone");
    expect(page.body).toContain('action="/settings/phone/pair"');
    // The relay switch is an outline; Pair an iPhone is the page's one primary.
    expect(primaries(page.body)).toBe(1);
    expect(page.body).toMatch(/k-btn-primary[^>]*><span class="k-face">Pair an iPhone/);
    expect(page.body).not.toContain("this computer");
    expect(page.body).not.toContain("Simulator");
    expect(page.screen?.functional).toBeUndefined();
  });

  test("no address and no relay: Pair isn't offered, and the page says why; Tailscale not found is its own line", async () => {
    engine.paths = { direct: { ...LISTENING, addresses: [], tailscale: "not_found" }, hosted: HOSTED_OFF };
    const page = await handlers()("settings.phone", "/settings/phone");
    expect(page.body).not.toContain('action="/settings/phone/pair"');
    expect(page.body).toContain("This Mac isn't on a network a phone can reach right now. Join Wi-Fi.");
    expect(page.body).toContain("A phone has no way to reach this Mac yet. Join Wi-Fi, or connect from anywhere.");
    expect(page.body).toContain("Tailscale: not found on this Mac.");
  });

  test("the relay alone is a path: Pair is offered with no address", async () => {
    engine.paths = { direct: { ...LISTENING, addresses: [] }, hosted: { state: "connected", relay: "wss://relay.toolroll.dev/v1/connect", since: NOW.toISOString(), superseded: false } };
    world.hostedEnabled = true;
    const page = await handlers()("settings.phone", "/settings/phone");
    expect(page.body).toContain('action="/settings/phone/pair"');
    expect(page.body).toContain("Connected.");
  });

  test("a direct listener that failed says so with its error and port, and the pair section points at the relay (U6)", async () => {
    engine.paths = { direct: { state: "failed", port: 4199, error: "listen EADDRINUSE: address already in use 0.0.0.0:4199", addresses: [], tailscale: "not_found" }, hosted: HOSTED_OFF };
    const page = await handlers()("settings.phone", "/settings/phone");
    expect(page.body).toContain("Phones can't connect to this Mac directly. Toolroll couldn't open port 4199: listen EADDRINUSE: address already in use 0.0.0.0:4199.");
    expect(page.body).toContain("Direct connections aren't working (see above). Turn on connecting from anywhere to pair now.");
    expect(page.body).not.toContain('action="/settings/phone/pair"');
  });

  test("a superseded relay connection is said in plain words", async () => {
    engine.paths = { direct: LISTENING, hosted: { state: "connected", relay: "wss://relay.toolroll.dev/v1/connect", since: NOW.toISOString(), superseded: true } };
    world.hostedEnabled = true;
    const page = await handlers()("settings.phone", "/settings/phone");
    expect(page.body).toContain("Another Toolroll with this workspace's keys is connected to the relay.");
  });

  test("a self-hosted relay is named as this Toolroll's own setting", async () => {
    world = { ...world, on: false, service: null, hostedUrl: "wss://relay.example.com" };
    const page = await handlers()("settings.phone", "/settings/phone");
    expect(page.body).toContain("relay.example.com</code>, the relay this Toolroll is set up to use (TOOLROLL_RELAY_URL).");
  });

  test("off macOS the page says \"this computer\" and has no macOS line", async () => {
    const page = await handlers("linux")("settings.phone", "/settings/phone");
    expect(page.body).toContain("this computer");
    expect(page.body).not.toContain("this Mac");
    expect(page.body).not.toContain("macOS");
    expect(page.body).toContain("If a firewall asks whether Toolroll may accept incoming connections, allow it.");
  });
});

describe("pairing", () => {
  test("the pair POST answers with the QR on a sensitive page that follows the pairing by itself (no \"I've scanned it\")", async () => {
    const call = handlers();
    const wrong = await call("settings.phone-pair", "/settings/phone/pair", { form: { password: "nope" } });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toContain("Enter your Toolroll password.");
    const shown = await call("settings.phone-pair", "/settings/phone/pair", { form: { password } });
    expect(shown.status).toBe(200);
    expect(shown.screen?.forceSensitive).toBe(true);
    expect(shown.screen?.functional).toEqual({ script: PHONE_PAIRING_SCRIPT, fetches: true });
    expect(shown.body).toContain('id="phone-pairing" class="k-phone-pairing" data-pairing="pair_aaaaaaaaaaaaaaaa" data-left-ms="300000"');
    expect(visible(shown.body, "scan")).toBe(true);
    expect(shown.body).toContain('data-view="code" hidden');
    expect(shown.body).toContain('<figure class="k-phone-qr"><svg');
    expect(shown.body).toContain("Can't scan? Copy the pairing code and paste it in the app.");
    expect(shown.body).toContain("This code works once, for 5 minutes.");
    // Without JavaScript: a link back to this page to compare codes, never a button that loses the QR.
    expect(shown.body).toContain('<noscript><p class="k-note">After you scan it, <a class="k-link" href="/settings/phone#phone-pair">');
    expect(shown.body).not.toMatch(/scanned it/i);
    expect(shown.body).not.toContain("Simulator");
    // The focused answer: the pairing and nothing else to act on.
    expect(shown.body).not.toContain("/settings/phone/access");
    expect(primaries(shown.body)).toBe(1);
    expect(engine.calls[0]).toEqual(["start", "alex", expect.stringMatching(/^alex:\d+:/), store.accountOf("alex")!.generation]);
  });

  test("the 32-phone cap and other refusals are said on the page", async () => {
    engine.started = { ok: false, error: "This Mac already has 32 phones. Remove one first." };
    const refused = await handlers()("settings.phone-pair", "/settings/phone/pair", { form: { password } });
    expect(refused.status).toBe(409);
    expect(refused.body).toContain("This Mac already has 32 phones. Remove one first.");
  });

  test("the page swaps to the code to compare, spelled per character for a screen reader (U3, U17)", async () => {
    const call = handlers();
    await call("settings.phone-pair", "/settings/phone/pair", { form: { password } });
    engine.views.set("pair_aaaaaaaaaaaaaaaa", { pairSessionId: "pair_aaaaaaaaaaaaaaaa", status: "awaiting_confirm", expiresAtMs: NOW.getTime() + 120_000, confirmCode: "HFX-2B0", deviceName: "iPhone 16 Pro", deviceId: null, error: null });
    const page = await call("settings.phone", "/settings/phone");
    expect(visible(page.body, "code")).toBe(true);
    expect(page.body).toContain('<p class="k-phone-code"><span aria-hidden="true" data-phone-code>HFX-2B0</span><span class="k-sr" data-phone-code-spoken>H F X, 2 B 0</span></p>');
    expect(page.body).toContain("“iPhone 16 Pro” should be showing this code:");
    expect(page.body).toContain('data-left-ms="120000"');
    expect(page.body).toMatch(/k-btn-primary[^>]*><span class="k-face">Codes match — pair/);
    expect(primaries(page.body)).toBe(1);
    expect(page.screen?.functional?.script).toBe(PHONE_PAIRING_SCRIPT);
    // The QR is never drawn on a GET.
    expect(page.body).not.toContain("k-phone-qr");
    expect(page.body).not.toContain("secret-psk");
    // A phone named only "iPhone" isn't quoted.
    engine.views.set("pair_aaaaaaaaaaaaaaaa", { ...engine.views.get("pair_aaaaaaaaaaaaaaaa")!, deviceName: "iPhone" });
    expect((await call("settings.phone", "/settings/phone")).body).toContain("Your iPhone should be showing this code:");
  });

  test("waiting and finishing views reload on their own without JavaScript; the code view doesn't", async () => {
    const call = handlers();
    await call("settings.phone-pair", "/settings/phone/pair", { form: { password } });
    const base: PairingView = { pairSessionId: "pair_aaaaaaaaaaaaaaaa", status: "awaiting_scan", expiresAtMs: NOW.getTime() + 200_000, confirmCode: null, deviceName: null, deviceId: null, error: null };
    for (const [status, view, words] of [["awaiting_scan", "waiting", "Waiting for your iPhone to scan the code…"], ["awaiting_ready", "waiting", "Waiting for your iPhone"], ["confirming", "confirming", "Saving the pairing…"], ["finishing", "finishing", "Finishing on the iPhone…"]] as const) {
      engine.views.set(base.pairSessionId, { ...base, status });
      const page = await call("settings.phone", "/settings/phone");
      expect(visible(page.body, view), status).toBe(true);
      expect(page.body, status).toContain(words);
      expect(page.body, status).toContain('<noscript><meta http-equiv="refresh" content="5"></noscript>');
    }
    engine.views.set(base.pairSessionId, { ...base, status: "awaiting_confirm", confirmCode: "ABC-123" });
    expect((await call("settings.phone", "/settings/phone")).body).not.toContain('http-equiv="refresh"');
  });

  test("each outcome has its own words, said once; the owner's own cancel is neutral (M10)", async () => {
    const outcomes: [PairingView["status"], string, boolean][] = [
      ["paired", "Your iPhone is paired. Open the Toolroll app to see your work.", false],
      ["cancelled", "Pairing cancelled.", false],
      ["expired", "That pairing code expired. Pair again.", true],
      ["contested", "Another device used this code, so pairing stopped. Pair again and keep the code to yourself.", true],
      ["failed", "Pairing didn't finish. Pair again.", true],
    ];
    for (const [status, words, alarm] of outcomes) {
      const call = handlers();
      await call("settings.phone-pair", "/settings/phone/pair", { form: { password } });
      engine.views.set("pair_aaaaaaaaaaaaaaaa", { pairSessionId: "pair_aaaaaaaaaaaaaaaa", status, expiresAtMs: NOW.getTime(), confirmCode: null, deviceName: null, deviceId: null, error: null });
      const page = await call("settings.phone", "/settings/phone");
      expect(page.body, status).toContain(words);
      // A problem is an alert; a success or the owner's own cancel is a plain info line.
      expect(page.body.includes(alarm ? `<span>${words}</span></p>` : `<p class="k-notice info">${words}</p>`), status).toBe(true);
      expect(page.screen?.functional, status).toBeUndefined();
      expect(page.body, status).toContain('action="/settings/phone/pair"');
      expect((await call("settings.phone", "/settings/phone")).body, `${status} again`).not.toContain(words);
    }
  });

  test("confirm lands on the pairing (U18); a failed confirm says its problem once (M10.3)", async () => {
    const call = handlers();
    await call("settings.phone-pair", "/settings/phone/pair", { form: { password } });
    engine.views.set("pair_aaaaaaaaaaaaaaaa", { pairSessionId: "pair_aaaaaaaaaaaaaaaa", status: "awaiting_confirm", expiresAtMs: NOW.getTime() + 60_000, confirmCode: "ABC-123", deviceName: null, deviceId: null, error: null });
    const ok = await call("settings.phone-confirm", "/settings/phone/confirm", { form: { pairing: "pair_aaaaaaaaaaaaaaaa" } });
    expect([ok.status, ok.location]).toEqual([303, "/settings/phone#phone-pair"]);
    engine.confirmed = { ok: false, error: "The phone left before it was saved." };
    engine.views.set("pair_aaaaaaaaaaaaaaaa", { ...engine.views.get("pair_aaaaaaaaaaaaaaaa")!, status: "failed" });
    const failed = await call("settings.phone-confirm", "/settings/phone/confirm", { form: { pairing: "pair_aaaaaaaaaaaaaaaa" } });
    expect(failed.status).toBe(409);
    expect(failed.body).toContain("The phone left before it was saved.");
    expect(failed.body).not.toContain("Pairing didn't finish");
  });

  test("cancel lands on the pairing; another session's or an unknown pairing is refused", async () => {
    const call = handlers();
    await call("settings.phone-pair", "/settings/phone/pair", { form: { password } });
    const wrong = await call("settings.phone-cancel", "/settings/phone/cancel", { form: { pairing: "pair_bbbbbbbbbbbbbbbb" } });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toContain("That pairing isn't open any more. Pair again.");
    const cancelled = await call("settings.phone-cancel", "/settings/phone/cancel", { form: { pairing: "pair_aaaaaaaaaaaaaaaa" } });
    expect([cancelled.status, cancelled.location]).toEqual([303, "/settings/phone#phone-pair"]);
    expect(engine.calls).toContainEqual(["cancel", "pair_aaaaaaaaaaaaaaaa"]);
  });

  test("a pairing lost to a restart of phone access says so, once (M10.8)", async () => {
    const call = handlers();
    await call("settings.phone-pair", "/settings/phone/pair", { form: { password } });
    world.service = { name: "service-2" };
    const page = await call("settings.phone", "/settings/phone");
    expect(page.body).toContain("Pairing stopped because phone access restarted. Pair again.");
    expect((await call("settings.phone", "/settings/phone")).body).not.toContain("restarted");
  });
});

describe("the pairing's JSON for the poller", () => {
  test("this session's own pairing as a PairingView, and 404 for anything else", async () => {
    const call = handlers();
    await call("settings.phone-pair", "/settings/phone/pair", { form: { password } });
    const view: PairingView = { pairSessionId: "pair_aaaaaaaaaaaaaaaa", status: "awaiting_confirm", expiresAtMs: NOW.getTime() + 60_000, confirmCode: "ABC-123", deviceName: "iPhone", deviceId: null, error: null };
    engine.views.set(view.pairSessionId, view);
    const mine = await call("settings.phone-pairing", "/settings/phone/pairings/pair_aaaaaaaaaaaaaaaa");
    expect(mine.status).toBe(200);
    expect(mine.json).toEqual(view);
    expect(Object.keys(mine.json as object).sort()).toEqual(["confirmCode", "deviceId", "deviceName", "error", "expiresAtMs", "pairSessionId", "status"]);
    expect(String(mine.body)).not.toContain("psk");
    // Another person's session (another binding) and an unknown id read the same: not found.
    for (const [path, as] of [["/settings/phone/pairings/pair_aaaaaaaaaaaaaaaa", "sam"], ["/settings/phone/pairings/pair_cccccccccccccccc", "alex"]] as const) {
      const other = await call("settings.phone-pairing", path, { as });
      expect([other.status, other.json]).toEqual([404, { error: "not_found" }]);
    }
    world = { ...world, on: false, service: null };
    expect((await call("settings.phone-pairing", "/settings/phone/pairings/pair_aaaaaaaaaaaaaaaa")).status).toBe(404);
  });
});

describe("your phones", () => {
  const phone = (over: Partial<PhoneRow>): PhoneRow => ({ deviceId: "dev-1", name: "Work iPhone", accountName: "alex", pairedAt: "2026-11-20T09:05:00Z", lastSeenAt: null, state: "active", retiredReason: null, ...over });

  test("each phone with its name, paired date, last seen and state; retired ones with why, without acts", async () => {
    engine.phones = [
      phone({ lastSeenAt: "2026-11-27T13:58:00Z" }),
      phone({ deviceId: "dev-2", name: "Spare", state: "finishing" }),
      phone({ deviceId: "dev-3", name: "Old phone", state: "retired", retiredReason: "password_changed" }),
      phone({ deviceId: "dev-4", name: "Sam's", accountName: "sam" }),
    ];
    const page = await handlers()("settings.phone", "/settings/phone");
    expect(page.body).toContain("Your phones");
    expect(page.body).toContain(" · 2");
    expect(page.body).toMatch(/Paired Nov 2\d, \d\d:\d\d · last connected 2m ago/);
    expect(page.body).toContain("Finishing on the iPhone… · paired");
    expect(page.body).toContain("Removed or signed out in the last 30 days");
    expect(page.body).toContain("Signed out when your password changed · paired");
    expect(page.body).not.toContain("Sam's");
    const retired = /data-phone="dev-3"[\s\S]*?(?=data-phone=|$)/.exec(page.body)![0];
    expect(retired).not.toContain("/settings/phone/remove");
    expect(retired).not.toContain("/settings/phone/rename");
    const active = /data-phone="dev-1"[\s\S]*?(?=data-phone="dev-2")/.exec(page.body)![0];
    expect(active).toContain('action="/settings/phone/rename"');
    expect(active).toContain('action="/settings/phone/remove"');
    expect(active).toContain('maxlength="48"');
    // A phone that never connected says so.
    engine.phones = [phone({})];
    expect((await handlers()("settings.phone", "/settings/phone")).body).toMatch(/Paired Nov 2\d, \d\d:\d\d · never connected/);
  });

  test("rename: one name of 1 to 48 characters, only your own phone", async () => {
    engine.phones = [phone({}), phone({ deviceId: "dev-9", accountName: "sam" })];
    const call = handlers();
    expect((await call("settings.phone-rename", "/settings/phone/rename", { form: { device: "dev-1", name: "   " } })).status).toBe(400);
    expect((await call("settings.phone-rename", "/settings/phone/rename", { form: { device: "dev-1", name: "x".repeat(49) } })).status).toBe(400);
    expect((await call("settings.phone-rename", "/settings/phone/rename", { form: { device: ["dev-1", "dev-2"], name: "A" } })).status).toBe(400);
    const theirs = await call("settings.phone-rename", "/settings/phone/rename", { form: { device: "dev-9", name: "Mine now" } });
    expect(theirs.status).toBe(404);
    expect(theirs.body).toContain("That phone isn't paired.");
    const renamed = await call("settings.phone-rename", "/settings/phone/rename", { form: { device: "dev-1", name: "  Alex's iPhone  " } });
    expect([renamed.status, renamed.location]).toEqual([303, "/settings/phone#phone-devices"]);
    expect(engine.calls).toContainEqual(["rename", "dev-1", "Alex's iPhone", "alex"]);
  });

  test("remove: the password, only your own phone, at once — running or with phone access off", async () => {
    engine.phones = [phone({}), phone({ deviceId: "dev-9", accountName: "sam" })];
    const call = handlers();
    expect((await call("settings.phone-remove", "/settings/phone/remove", { form: { device: "dev-1", password: "nope" } })).status).toBe(403);
    expect((await call("settings.phone-remove", "/settings/phone/remove", { form: { device: "dev-9", password } })).status).toBe(404);
    const removed = await call("settings.phone-remove", "/settings/phone/remove", { form: { device: "dev-1", password } });
    expect([removed.status, removed.location]).toEqual([303, "/settings/phone#phone-devices"]);
    expect(engine.calls).toContainEqual(["remove", "running", "dev-1", "alex"]);
    world = { ...world, on: false, service: null };
    await call("settings.phone-remove", "/settings/phone/remove", { form: { device: "dev-1", password } });
    expect(engine.calls).toContainEqual(["remove", "off", "dev-1", "alex"]);
  });
});

describe("the routes", () => {
  test("the pairing JSON has the page's own policy; rename is an approver's own act from a browser", () => {
    const of = (id: string) => ROUTES.find(one => one.id === id)!;
    const policy = (id: string) => { const row = of(id); return { callers: row.callers, scope: row.scope, limited: row.limited, role: row.role, roleBrowser: row.roleBrowser, local: row.local, needsProject: row.needsProject }; };
    expect(policy("settings.phone-pairing")).toEqual(policy("settings.phone"));
    expect(of("settings.phone-pairing").method).toBe("GET");
    expect(policy("settings.phone-rename")).toEqual(policy("settings.phone-confirm"));
    expect(of("settings.phone-rename")).toMatchObject({ method: "POST", role: "approver", roleBrowser: true, limited: "self", local: "deny" });
  });

  test("spokenCode reads each character, the halves apart", () => {
    expect(spokenCode("HFX-2B0")).toBe("H F X, 2 B 0");
  });
});
