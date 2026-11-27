/**
 * Settings → Phone: turn phone access on or off, pair an iPhone (the Toolroll app), and remove paired phones.
 *
 * Every act is the signed-in approver's own, from a full browser session (route-table.ts: approver, self). Turning
 * access on or off and removing a phone take the password again (a step-up); pairing is a credential act — the typed
 * password, always (settings-proofs.ts phone-pair, as Telegram's pairing). The pairing QR carries one-time secrets, so
 * it is drawn only on that POST's answer (sensitive, never cached), never on a GET: after scanning, this page shows the
 * six-character code to compare and Confirm / Cancel. A pairing answers only to the session that started it.
 */

import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { CONSOLE_FORMS, readForm } from "../contracts/console-api.js";
import type { PhoneAccess } from "../companion/access.js";
import { encodeQr } from "../qr.js";
import { html, joinHtml, postForm, type Html } from "../html.js";
import { authenticateAccount } from "../scope.js";
import { settingsSubPage } from "../settings-groups-ui.js";
import { kitSectionForm } from "../settings-kit.js";
import { refuse, relativeAge, screen } from "./chrome.js";
import type { HandlerContext } from "./handler-context.js";
import { handlersOf } from "./handler-registry.js";
import { redirect } from "./http.js";
import { acts, btn, codeLine, infoLine, note, notice, settingsRecord, settingsSection } from "./kit.js";
import type { ServerRuntime } from "./runtime.js";
import { browserCaller, type Who } from "./session.js";

type CookieWho = Extract<Who, { via: "cookie" }>;

/** The session a pairing belongs to: the person, their account generation, and a hash of this session's form token
 * (never the token). Another tab of the same session shares it; another session doesn't. */
function bindingOf(who: CookieWho): string {
  return `${who.name}:${who.session.generation}:${createHash("sha256").update(who.session.csrf).digest("base64url").slice(0, 22)}`;
}

/** The QR as an inline SVG drawn through the escaping templates (path data is digits and h/v/M/z only). */
function qrFigure(text: string, label: string): Html {
  const code = encodeQr(text, "M");
  const border = 4, dim = code.size + border * 2;
  let path = "";
  for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) if (code.dark(x, y)) path += `M${x + border},${y + border}h1v1h-1z`;
  return html`<figure class="phone-qr" style="margin:0;max-width:280px"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="${label}" style="width:100%;height:auto;background:#fff;border-radius:8px"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#000"/></svg></figure>`;
}

export interface PhoneSettingsDeps {
  access: PhoneAccess;
}

export function createPhoneSettingsHandlers(runtime: Pick<ServerRuntime, "store" | "clock" | "sendScreen" | "chromeFor">, deps: PhoneSettingsDeps) {
  const { store } = runtime;
  /** The pairing each session has open (its id), so this page can show its code; the engine holds the pairing itself. */
  const openPairings = new Map<string, string>();

  const show = (response: ServerResponse, status: number, body: Html, options: { sensitive?: boolean; refresh?: boolean } = {}) =>
    runtime.sendScreen(response, status, screen("Phone", body, {
      chrome: runtime.chromeFor(null, "settings"),
      ...(options.sensitive === true ? { forceSensitive: true } : {}),
      ...(options.refresh === true ? { refreshSeconds: 5 } : {}),
    }));

  /** The typed password proves this very person and session (Telegram's rule): an approver, at this generation. */
  const passwordHolds = (who: CookieWho, password: string): boolean => {
    const proved = authenticateAccount(store, who.name, password);
    return proved.ok && proved.role === "approver" && proved.generation === who.session.generation;
  };
  const passwordProblem = (who: CookieWho): string =>
    store.accountOf(who.name)?.passwordSet === true
      ? "Enter your Toolroll password."
      : "Phone access needs a Toolroll password. Set one in Settings → General → Your password, then come back.";

  function page(who: CookieWho, options: { problem?: string; qr?: { payload: string; expiresAtMs: number } } = {}): { body: Html; refresh: boolean } {
    const access = deps.access, on = access.enabled(), service = access.service(), now = runtime.clock();
    const status = service?.status() ?? null;
    const problem = options.problem === undefined ? "" : notice(options.problem);

    // 1. Access: off or on, and how a phone reaches this Mac — directly on its network, through the hosted relay elsewhere.
    const operator = store.isInstanceOperator(who.name);
    const hostedChoice = access.hostedChoice();
    const hostedHost = hostedChoice.ok ? new URL(hostedChoice.url).host : null;
    const direct = status?.direct ?? { state: "off" as const };
    const hosted = status?.hosted ?? { state: "off" as const };
    const addresses = service?.directAddresses() ?? [];
    const directLine = direct.state === "listening"
      ? settingsRecord({ title: "On this Mac's network", sub: addresses.length > 0
        ? html`Direct, no relay: ${joinHtml(addresses.map(a => codeLine(a)), " ")}. Works on the same Wi-Fi, or anywhere over Tailscale if both have it.`
        : "Direct, no relay — but this Mac isn't on a network a phone can reach right now. Join Wi-Fi." })
      : direct.state === "failed" ? settingsRecord({ title: "On this Mac's network", sub: html`Not available: ${direct.error}` }) : "";
    const hostedLine = hosted.state === "off"
      ? settingsRecord({ title: "Anywhere else", sub: hostedChoice.ok ? "Off. Your phone connects only on this Mac's network." : "Off (TOOLROLL_RELAY_URL=off). Your phone connects only on this Mac's network." })
      : settingsRecord({ title: "Anywhere else", sub: html`Through ${codeLine(new URL(hosted.relay).host)}, end-to-end encrypted: the relay sees that your phone and Mac are connected, never your work. ${
        hosted.state === "connected" ? "Connected." : hosted.state === "unreachable" ? html`Can't reach it right now (${hosted.error}); Toolroll keeps trying.` : "Connecting…"}` });
    const hostedBox = (checked: boolean): Html => hostedHost === null ? html`` : html`<label class="k-note" style="display:flex;gap:8px;align-items:flex-start;margin:0 0 12px"><input type="checkbox" name="hosted" value="1"${checked ? html` checked` : ""}> <span>Also connect from anywhere through ${codeLine(hostedHost)}. End-to-end encrypted: the relay can't read your work or act for you.</span></label>`;
    const accessSection = settingsSection({
      id: "phone-access", title: "Phone access", state: on ? " · On" : " · Off",
      lead: on ? "Your paired iPhone can see what needs you, read plans, steps and changes, and watch agents work. Approving still happens here."
        : "Let the Toolroll iPhone app see your work. Nothing is shared until you pair a phone.",
      body: joinHtml([
        ...access.problems().map(text => notice(text)),
        on && access.hostedApprovalStale() ? notice(hostedHost === null
          ? "Connecting from anywhere is off on this computer now (TOOLROLL_RELAY_URL=off)."
          : html`This Toolroll's relay setting changed to ${codeLine(hostedHost)}. Phones connect only on this Mac's network until you approve the new relay below.`) : "",
        on ? joinHtml([directLine, hostedLine]) : "",
        !operator ? note(on ? "Whoever runs this Toolroll turned phone access on." : "Ask whoever runs this Toolroll to turn on phone access.")
          : on ? joinHtml([
            hostedHost === null ? "" : kitSectionForm({ proof: "phone-access", action: "/settings/phone/access", id: "phone-hosted-form", native: true,
              hidden: { act: access.hostedEnabled() ? "hosted-off" : "hosted-on" },
              save: access.hostedEnabled() ? { label: "Stop connecting from anywhere", variant: "outline" } : { label: `Connect from anywhere through ${hostedHost}` },
              confirm: access.hostedEnabled() ? "Stop connecting from anywhere" : "Connect from anywhere", body: "" }),
            kitSectionForm({ proof: "phone-access", action: "/settings/phone/access", id: "phone-access-form", native: true,
              hidden: { act: "off" }, save: { label: "Turn off phone access", variant: "danger" }, confirm: "Turn off phone access",
              body: note("Paired phones stay paired but can't connect until you turn it back on.") }),
          ])
          : kitSectionForm({ proof: "phone-access", action: "/settings/phone/access", id: "phone-access-form", native: true,
            hidden: { act: "on" }, save: { label: "Turn on phone access" }, confirm: "Turn on phone access",
            body: joinHtml([
              note("Your phone connects straight to this Mac on the same Wi-Fi (or over Tailscale)."),
              hostedHost === null ? note("Connecting from anywhere is off on this computer (TOOLROLL_RELAY_URL=off).") : hostedBox(true),
            ]) }),
      ]),
    });
    const reachable = on && (direct.state === "listening" || hosted.state === "connected");

    // 2. Pair: the QR (only on the pair POST's answer), the code to compare, or the button.
    let pairBody: Html;
    let refresh = false;
    const binding = bindingOf(who);
    const openId = openPairings.get(binding);
    const open = openId === undefined || service === null ? null : service.engine.getPairingStatus(openId, binding);
    if (options.qr !== undefined) {
      pairBody = joinHtml([
        html`<ol class="k-note" style="padding-left:1.2em;margin:0 0 12px"><li>Open the Toolroll app on your iPhone and tap <strong>Pair with your Mac</strong>.</li><li>Scan this code.</li><li>Come back here to compare a short code.</li></ol>`,
        qrFigure(options.qr.payload, "Pairing code for the Toolroll iPhone app"),
        html`<details style="margin-top:12px"><summary class="k-note">Can't scan? Copy the pairing code instead (Simulator)</summary><textarea readonly rows="5" style="width:100%;font:12px ui-monospace,monospace" aria-label="Pairing code">${options.qr.payload}</textarea></details>`,
        note(`This code works once, for 5 minutes. Treat it like your password: anyone who scans it before you can try to pair.`),
        acts(btn("I've scanned it", { sm: true, href: "/settings/phone#phone-pair" })),
      ]);
    } else if (open !== null && open.status === "awaiting_confirm") {
      pairBody = joinHtml([
        html`<p class="k-note">Your iPhone (“${open.deviceName ?? "iPhone"}”) should be showing this code:</p>`,
        html`<p style="font:600 32px/1.2 ui-monospace,monospace;letter-spacing:.08em;margin:8px 0 12px">${open.confirmCode ?? ""}</p>`,
        note("Only confirm if your iPhone shows exactly this code. If it doesn't, cancel — someone else may have scanned your QR."),
        html`<div class="k-acts">${postForm("/settings/phone/confirm", html`<button type="submit" class="k-btn k-btn-primary k-btn-sm"><span class="k-face">Codes match — pair</span></button>`, { hidden: { pairing: openId! } })}${postForm("/settings/phone/cancel", html`<button type="submit" class="k-btn k-btn-outline k-btn-sm"><span class="k-face">Cancel</span></button>`, { hidden: { pairing: openId! } })}</div>`,
      ]);
    } else if (open !== null && open.status === "awaiting_scan") {
      refresh = true;
      pairBody = joinHtml([
        note("Waiting for your iPhone to scan the code… This page checks every few seconds."),
        acts(postForm("/settings/phone/cancel", html`<button type="submit" class="k-btn k-btn-outline k-btn-sm"><span class="k-face">Cancel</span></button>`, { hidden: { pairing: openId! } })),
      ]);
    } else {
      const last = open === null ? "" : open.status === "confirmed" ? infoLine("Your iPhone is paired. Open the Toolroll app to see your work.") : open.status === "expired" ? notice("That pairing code expired. Pair again.")
        : open.status === "aborted_race" ? notice("Two phones tried the same code, so pairing stopped. Pair again and keep the code to yourself.") : open.status === "failed" || open.status.startsWith("aborted") ? notice("Pairing stopped. Pair again.") : "";
      pairBody = joinHtml([
        last,
        reachable
          ? kitSectionForm({ proof: "phone-pair", action: "/settings/phone/pair", id: "phone-pair-form", native: true, save: { label: "Pair an iPhone" },
            confirm: "Pair an iPhone with Toolroll", body: note("You'll get a code to scan with the Toolroll app.") })
          : note(on ? "A phone has no way to reach this Mac yet: join Wi-Fi, or connect from anywhere." : "Turn on phone access first."),
      ]);
    }
    const pairSection = settingsSection({ id: "phone-pair", title: "Pair an iPhone", body: pairBody });

    // 3. Paired phones: this person's own (an approver sees and removes only their own).
    const mine = (service?.devices() ?? []).filter(device => device.accountName === who.name);
    const devices = settingsSection({
      id: "phone-devices", title: "Your paired phones", state: mine.length === 0 ? " · None" : ` · ${mine.length}`,
      body: mine.length === 0 ? note("No phones are paired.") : joinHtml(mine.map(device => settingsRecord({
        title: device.deviceName,
        sub: `Paired ${relativeAge(device.createdAt, now)}${device.lastSeenAt === null ? "" : ` · last connected ${relativeAge(device.lastSeenAt, now)}`}`,
        more: kitSectionForm({ proof: "phone-remove", action: "/settings/phone/remove", id: `phone-remove-${device.deviceId}`, hidden: { device: device.deviceId },
          save: { label: "Remove", variant: "danger" }, confirm: `Remove ${device.deviceName}`, body: "" }),
      }))),
    });

    return { body: settingsSubPage("access", "Phone", joinHtml([problem, accessSection, pairSection, devices]), { lead: "The Toolroll iPhone app: what needs you, in your pocket." }), refresh };
  }

  async function phonePage(ctx: HandlerContext): Promise<void> {
    const who = browserCaller(ctx.who);
    const built = page(who);
    return show(ctx.response, 200, built.body, { refresh: built.refresh });
  }

  async function accessAct(ctx: HandlerContext): Promise<void> {
    const who = browserCaller(ctx.who);
    const body = readForm(ctx.posted, CONSOLE_FORMS.phoneAccess);
    if (body.getAll("password").length > 1 || body.getAll("act").length !== 1) return show(ctx.response, 400, page(who, { problem: "Submit one value for each field." }).body);
    const act = body.get("act");
    if (act !== "on" && act !== "off" && act !== "hosted-on" && act !== "hosted-off") return show(ctx.response, 400, page(who, { problem: "Choose on or off." }).body);
    if (body.getAll("hosted").length > 1) return show(ctx.response, 400, page(who, { problem: "Submit one value for each field." }).body);
    // An installation-wide switch: an instance operator's, proved again here (the route's role gate drew the form).
    if (!store.isInstanceOperator(who.name)) return show(ctx.response, 403, page(who, { problem: "An instance operator turns phone access on or off." }).body);
    if (!passwordHolds(who, body.get("password") ?? "")) return show(ctx.response, 403, page(who, { problem: passwordProblem(who) }).body);
    // "on" carries the hosted choice from its checkbox; hosted-on/off change only that, and only while access is on
    // (decided inside the access queue, after any change posted before this one).
    const change = act === "on" ? { act, hosted: body.get("hosted") === "1" } as const : { act } as const;
    const applied = await deps.access.change(change, who.name, runtime.clock(), () => store.isInstanceOperator(who.name) && store.accountOf(who.name)?.generation === who.session.generation);
    if (applied === "not_on") return show(ctx.response, 409, page(who, { problem: "Phone access is off now. Turn it on first." }).body);
    if (applied === "not_allowed") return show(ctx.response, 403, page(who, { problem: "An instance operator turns phone access on or off." }).body);
    return redirect(ctx.response, "/settings/phone");
  }

  async function pairAct(ctx: HandlerContext): Promise<void> {
    const who = browserCaller(ctx.who);
    const body = readForm(ctx.posted, CONSOLE_FORMS.phonePair);
    if (body.getAll("password").length > 1) return show(ctx.response, 400, page(who, { problem: "Submit one value for each field." }).body);
    // Pairing a phone is a credential act: the password, typed, every time.
    if (!passwordHolds(who, body.get("password") ?? "")) return show(ctx.response, 403, page(who, { problem: passwordProblem(who) }).body);
    const service = deps.access.service();
    if (service === null) return show(ctx.response, 409, page(who, { problem: "Turn on phone access first." }).body);
    const binding = bindingOf(who);
    const started = service.startPairing(who.name, binding, who.session.generation);
    if (!started.ok) return show(ctx.response, 409, page(who, { problem: started.error }).body);
    openPairings.set(binding, started.qr.pairSessionId);
    const built = page(who, { qr: { payload: JSON.stringify(started.qr), expiresAtMs: started.expiresAtMs } });
    return show(ctx.response, 200, built.body, { sensitive: true });
  }

  const pairingAct = (op: "confirm" | "cancel") => async (ctx: HandlerContext): Promise<void> => {
    const who = browserCaller(ctx.who);
    const body = readForm(ctx.posted, CONSOLE_FORMS.phonePairing);
    const pairing = body.getAll("pairing").length === 1 ? body.get("pairing") ?? "" : "";
    const binding = bindingOf(who);
    const service = deps.access.service();
    // Only this session's own open pairing, by its id.
    if (service === null || pairing === "" || openPairings.get(binding) !== pairing) return refuse(ctx.response, who, 409, "That pairing isn't open any more. Pair again.", "/settings/phone");
    if (op === "cancel") {
      service.engine.cancelPairing(pairing, binding);
      return redirect(ctx.response, "/settings/phone");
    }
    const confirmed = await service.engine.confirmPairing(pairing, binding);
    if (!confirmed.ok) return show(ctx.response, 409, page(who, { problem: confirmed.error }).body);
    return redirect(ctx.response, "/settings/phone#phone-devices");
  };

  async function removeAct(ctx: HandlerContext): Promise<void> {
    const who = browserCaller(ctx.who);
    const body = readForm(ctx.posted, CONSOLE_FORMS.phoneRemove);
    if (body.getAll("password").length > 1 || body.getAll("device").length !== 1) return show(ctx.response, 400, page(who, { problem: "Submit one value for each field." }).body);
    if (!passwordHolds(who, body.get("password") ?? "")) return show(ctx.response, 403, page(who, { problem: passwordProblem(who) }).body);
    const service = deps.access.service();
    const deviceId = body.get("device") ?? "";
    // Only the person's own phone (a teammate's is never named here, and an unknown one is the same answer).
    const device = service?.devices().find(one => one.deviceId === deviceId && one.accountName === who.name);
    if (service === null || device === undefined) return show(ctx.response, 404, page(who, { problem: "That phone isn't paired." }).body);
    await service.engine.revokeDevice(device.deviceId);
    return redirect(ctx.response, "/settings/phone#phone-devices");
  }

  return {
    registrations: handlersOf("settings", {
      "settings.phone": phonePage,
      "settings.phone-access": accessAct,
      "settings.phone-pair": pairAct,
      "settings.phone-confirm": pairingAct("confirm"),
      "settings.phone-cancel": pairingAct("cancel"),
      "settings.phone-remove": removeAct,
    }),
  };
}
