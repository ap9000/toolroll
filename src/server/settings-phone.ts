/**
 * Settings → Phone: turn phone access on or off, pair an iPhone (the Toolroll app), and rename or remove paired phones.
 *
 * Every act is the signed-in approver's own, from a full browser session (route-table.ts: approver, self). Turning
 * access on or off and removing a phone take the password again (a step-up); pairing is a credential act — the typed
 * password, always (settings-proofs.ts phone-pair, as Telegram's pairing). An account without a password is told to set
 * one and offered nothing it couldn't finish. The pairing QR carries one-time secrets, so it is drawn only on that
 * POST's answer (sensitive, never cached), never on a GET. That answer and this page follow the pairing on their own:
 * the page script reads GET /settings/phone/pairings/:id (the same session's own pairing, as JSON, no secrets) every
 * second, swaps the QR for the six-character code to compare, counts down, and reloads on the outcome. Without
 * JavaScript the page still works by reload. A pairing answers only to the session that started it.
 *
 * Everything this page asks of the companion engine goes through phone-engine-api.ts (the frozen §7 interfaces).
 */

import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { CONSOLE_FORMS, checkResponse, readForm } from "../contracts/console-api.js";
import type { PhoneAccess } from "../companion/access.js";
import { encodeQr } from "../qr.js";
import { html, joinHtml, postForm, type Html } from "../html.js";
import { authenticateAccount } from "../scope.js";
import { settingsSubPage } from "../settings-groups-ui.js";
import { kitSectionForm } from "../settings-kit.js";
import { refuse, relativeAge, screen } from "./chrome.js";
import type { HandlerContext } from "./handler-context.js";
import { handlersOf } from "./handler-registry.js";
import { redirect, respond } from "./http.js";
import { acts, btn, codeLine, infoLine, note, notice, settingsRecord, settingsSection } from "./kit.js";
import {
  cancelPairing, confirmPairing, listPhones, pairingView, pathStates, removePhone, renamePhone, startPairing,
  type DirectPathState, type HostedPathState, type PairingView, type PhoneRow, type PhoneService, type RetiredReason,
} from "./phone-engine-api.js";
import type { ServerRuntime } from "./runtime.js";
import { browserCaller, type Who } from "./session.js";

type CookieWho = Extract<Who, { via: "cookie" }>;

/** How to get the app while it isn't on the App Store (docs/companion-app.md). */
export const COMPANION_DOCS_URL = "https://github.com/ap9000/toolroll/blob/main/docs/companion-app.md";
const DEFAULT_RELAY_HOST = "relay.toolroll.dev";
/** The longest name a phone may have (the engine sanitizes to the same bound). */
const PHONE_NAME_MAX = 48;

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
  return html`<figure class="k-phone-qr"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#000"/></svg></figure>`;
}

/** A confirm code read aloud one character at a time, its two halves apart: "HFX-2B0" → "H F X, 2 B 0". */
export function spokenCode(code: string): string {
  return code.split("-").map(half => half.split("").join(" ")).join(", ");
}

/** The line above the code: the phone's own name when it sent one worth saying (every iPhone is "iPhone" by default). */
function codeLead(deviceName: string | null): string {
  return deviceName !== null && deviceName.trim() !== "" && deviceName !== "iPhone" ? `“${deviceName}” should be showing this code:` : "Your iPhone should be showing this code:";
}

/** "Nov 27, 14:02": two phones paired the same day can still be told apart. */
function pairedOn(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

const RETIRED_WORDS: Record<RetiredReason, string> = {
  removed: "Removed",
  password_changed: "Signed out when your password changed",
  access_changed: "Signed out when your access changed",
  restored: "Signed out when this workspace was restored",
  migration: "Signed out by a Toolroll update",
  contested: "Not paired: another device used the code",
  pairing_failed: "Pairing didn't finish",
};

/**
 * The page script that follows a pairing (the QR answer and this page alike): every second it reads the session's own
 * pairing as JSON and shows the matching view — the QR (or "waiting") until a phone proves the code, then the code to
 * compare, then "saving" and "finishing on the iPhone"; any outcome reloads this page, which says it once. The countdown
 * runs from the time left when the page was drawn, so a clock that's off on this browser doesn't shorten it. It writes
 * only text (textContent) and the views' hidden flags; it never sees a secret. Listed in settings-scripts.ts.
 */
export const PHONE_PAIRING_SCRIPT =
  `(function(){var first=document.getElementById("phone-pairing");if(!first)return;` +
  `var id=first.getAttribute("data-pairing")||"";var deadline=Date.now()+Number(first.getAttribute("data-left-ms")||0);var done=false,misses=0;` +
  `function root(){return document.getElementById("phone-pairing");}` +
  `function each(sel,fn){var r=root();if(r)Array.prototype.forEach.call(r.querySelectorAll(sel),fn);}` +
  `function show(name){var r=root();if(!r)return;if(name==="scan"&&!r.querySelector('[data-view="scan"]'))name="waiting";` +
  `each("[data-view]",function(v){v.hidden=v.getAttribute("data-view")!==name;});r.setAttribute("data-shown",name);}` +
  `function leave(){if(done)return;done=true;if(location.pathname==="/settings/phone"){history.replaceState(null,"","/settings/phone#phone-pair");location.reload();}else location.replace("/settings/phone#phone-pair");}` +
  `function clock(){if(done)return;var left=Math.max(0,Math.ceil((deadline-Date.now())/1000));var m=Math.floor(left/60),s=left%60;` +
  `var words=left>0?"Expires in "+m+":"+(s<10?"0":"")+s:"This code expired.";each("[data-phone-expires]",function(e){e.textContent=words;});setTimeout(clock,1000);}` +
  `function spell(c){return c.split("-").map(function(h){return h.split("").join(" ");}).join(", ");}` +
  `function lead(n){return n&&n.trim()!==""&&n!=="iPhone"?"\\u201c"+n+"\\u201d should be showing this code:":"Your iPhone should be showing this code:";}` +
  `function apply(v){var s=v&&v.status;` +
  `if(s==="awaiting_scan"||s==="awaiting_ready")return show("scan");` +
  `if(s==="awaiting_confirm"){var c=String(v.confirmCode||"");each("[data-phone-code]",function(e){e.textContent=c;});` +
  `each("[data-phone-code-spoken]",function(e){e.textContent=spell(c);});each("[data-phone-device]",function(e){e.textContent=lead(v.deviceName);});return show("code");}` +
  `if(s==="confirming")return show("confirming");if(s==="finishing")return show("finishing");leave();}` +
  `function poll(){if(done)return;if(document.hidden){setTimeout(poll,1000);return;}` +
  `fetch("/settings/phone/pairings/"+encodeURIComponent(id),{credentials:"same-origin",cache:"no-store",redirect:"manual",headers:{accept:"application/json"}})` +
  `.then(function(r){if(r.status===404||r.type==="opaqueredirect"){leave();return null;}if(!r.ok)throw 0;return r.json();})` +
  `.then(function(v){if(v===null)return;misses=0;apply(v);if(!done)setTimeout(poll,1000);})` +
  `.catch(function(){misses++;if(misses>20)return leave();setTimeout(poll,Math.min(10000,1000*misses));});}` +
  `clock();setTimeout(poll,1000);})();`;

export interface PhoneSettingsDeps {
  access: PhoneAccess;
  /** Which word this computer goes by ("this Mac" on macOS, "this computer" elsewhere); a test seam. */
  platform?: NodeJS.Platform;
}

/** What the page is drawing on: the QR (the pair POST's answer only), or a problem to say first. */
type PageOptions = { problem?: string; qr?: { payload: string; pairSessionId: string; expiresAtMs: number } };

export function createPhoneSettingsHandlers(runtime: Pick<ServerRuntime, "store" | "clock" | "sendScreen" | "chromeFor">, deps: PhoneSettingsDeps) {
  const { store } = runtime;
  const mac = (deps.platform ?? process.platform) === "darwin";
  const thisMac = mac ? "this Mac" : "this computer", ThisMac = mac ? "This Mac" : "This computer";
  /** The pairing each session has open (its id, and the service it started on — a restart of phone access ends it);
   * the engine holds the pairing itself. Entries the engine no longer knows are pruned when read (L10). */
  const openPairings = new Map<string, { id: string; service: PhoneService }>();

  const show = (response: ServerResponse, status: number, body: Html, options: { sensitive?: boolean; script?: boolean } = {}) =>
    runtime.sendScreen(response, status, screen("Phone", body, {
      chrome: runtime.chromeFor(null, "settings"),
      ...(options.sensitive === true ? { forceSensitive: true } : {}),
      ...(options.script === true ? { functional: { script: PHONE_PAIRING_SCRIPT, fetches: true } } : {}),
    }));

  /** The typed password proves this very person and session (Telegram's rule): an approver, at this generation. */
  const passwordHolds = (who: CookieWho, password: string): boolean => {
    const proved = authenticateAccount(store, who.name, password);
    return proved.ok && proved.role === "approver" && proved.generation === who.session.generation;
  };
  const hasPassword = (who: CookieWho): boolean => store.accountOf(who.name)?.passwordSet === true;
  const passwordProblem = (who: CookieWho): string => hasPassword(who) ? "Enter your Toolroll password." : "Set a password to pair a phone.";

  /** Who runs a relay, in words for the hosted copy. */
  const runBy = (host: string): string => host === DEFAULT_RELAY_HOST ? "run by Toolroll" : "the relay this Toolroll is set up to use (TOOLROLL_RELAY_URL)";

  /** The direct path: each address labelled, Tailscale found or not, and what stops a phone that the page can't see. */
  function directRecord(direct: DirectPathState, hostedWorks: boolean): Html {
    const title = `On ${thisMac}'s network`;
    if (direct.state === "off") return html``;
    if (direct.state === "failed") {
      const what = direct.port === null ? "Toolroll couldn't start listening for phones" : `Toolroll couldn't open port ${direct.port}`;
      const error = (direct.error ?? "unknown error").replace(/\.+$/, "");
      const command = html`<code class="k-mono">TOOLROLL_PHONE_PORT=4300 toolroll</code>`;
      return settingsRecord({ title, sub: joinHtml([
        notice(html`Phones can't connect to ${thisMac} directly. ${what}: ${error}.`),
        direct.port === null ? (hostedWorks ? note("Connecting from anywhere still works.") : "")
          : note(html`${hostedWorks ? "Connecting from anywhere still works. To connect directly, quit" : "Quit"} the app using that port, or start Toolroll with ${command}.`),
      ]) });
    }
    const label = (kind: "lan" | "tailnet") => kind === "tailnet" ? "Tailscale" : "Wi-Fi / Ethernet";
    const at = (address: string) => direct.port === null || address.includes(":") ? address : `${address}:${direct.port}`;
    const list = direct.addresses.length === 0
      ? note(`${ThisMac} isn't on a network a phone can reach right now. Join Wi-Fi.`)
      : html`<ul class="k-phone-addrs">${direct.addresses.map(one => html`<li><span class="k-phone-addr-k">${label(one.kind)}</span><code class="k-mono">${at(one.address)}</code></li>`)}</ul>`;
    return settingsRecord({ title, sub: joinHtml([
      html`<span>Direct, no relay: on the same Wi-Fi, or anywhere over Tailscale when your phone has it too.</span>`,
      list,
      direct.tailscale === "not_found" ? html`<span class="k-phone-line">Tailscale: not found on ${thisMac}. Optional — <a class="k-link" href="https://tailscale.com/download">get Tailscale</a> to connect directly from anywhere.</span>` : "",
      html`<span class="k-phone-line">${mac ? "If macOS asks whether Toolroll may accept incoming connections, click Allow. " : "If a firewall asks whether Toolroll may accept incoming connections, allow it. "}Phones can't reach ${thisMac} while it's asleep.</span>`,
    ]) });
  }

  function hostedRecord(hosted: HostedPathState, configured: boolean): Html {
    if (hosted.state === "off") return settingsRecord({ title: "Anywhere else", sub: configured ? `Off. Your phone connects only on ${thisMac}'s network.` : `Off (TOOLROLL_RELAY_URL=off). Your phone connects only on ${thisMac}'s network.` });
    const host = new URL(hosted.relay).host;
    const now = hosted.state === "connected" ? "Connected." : hosted.state === "unreachable" ? html`Can't reach it right now (${hosted.error}); Toolroll keeps trying.` : "Connecting…";
    return settingsRecord({ title: "Anywhere else", sub: joinHtml([
      html`<span>Through ${codeLine(host)}, ${runBy(host)}. End-to-end encrypted: the relay sees when your phone and ${thisMac} connect, never what they send. ${now}</span>`,
      hosted.superseded === true ? notice("Another Toolroll with this workspace's keys is connected to the relay. Phones connecting from anywhere reach that one; stop it, or turn off connecting from anywhere on one of them.") : "",
    ]) });
  }

  /** The pairing panel: every view drawn, the current one shown; the page script switches between them. */
  function pairingPanel(view: PairingView, qr: PageOptions["qr"] | undefined): Html {
    const id = view.pairSessionId;
    const left = Math.max(0, view.expiresAtMs - runtime.clock().getTime());
    const shown = view.status === "awaiting_confirm" ? "code" : view.status === "confirming" ? "confirming" : view.status === "finishing" ? "finishing" : qr !== undefined ? "scan" : "waiting";
    const hidden = (name: string) => name === shown ? html`` : html` hidden`;
    const cancel = (label = "Cancel") => postForm("/settings/phone/cancel", html`<button type="submit" class="k-btn k-btn-outline k-btn-sm"><span class="k-face">${label}</span></button>`, { hidden: { pairing: id } });
    const expires = html`<p class="k-note" data-phone-expires>This code works once, for 5 minutes.</p>`;
    // Without JavaScript the waiting views reload on their own (a meta refresh only a browser without scripts reads).
    const reload = html`<noscript><meta http-equiv="refresh" content="5"></noscript>`;
    const code = view.confirmCode ?? "";
    return html`<div id="phone-pairing" class="k-phone-pairing" data-pairing="${id}" data-left-ms="${left}" data-shown="${shown}">\
${qr === undefined ? "" : html`<div data-view="scan"${hidden("scan")}>\
<ol class="k-phone-steps"><li>Open the Toolroll app on your iPhone and tap <strong>Pair with your Mac</strong>.</li><li>Scan this code. ${ThisMac} then shows a short code to compare.</li></ol>\
${qrFigure(qr.payload, "Pairing code for the Toolroll iPhone app")}\
<details class="k-phone-paste"><summary class="k-note">Can't scan? Copy the pairing code and paste it in the app.</summary><textarea readonly rows="5" aria-label="Pairing code">${qr.payload}</textarea></details>\
${expires}${note("Treat this code like your password: anyone who scans it before you can try to pair.")}\
<noscript><p class="k-note">After you scan it, <a class="k-link" href="/settings/phone#phone-pair">open Settings → Phone</a> to compare codes.</p></noscript>\
${acts(cancel())}</div>`}\
${qr !== undefined ? "" : html`<div data-view="waiting"${hidden("waiting")}>${shown === "waiting" ? reload : ""}\
<p class="k-phone-wait" role="status">Waiting for your iPhone to scan the code…</p>${expires}\
${note("The QR code is shown only once. If you closed it before scanning, cancel and pair again.")}${acts(cancel())}</div>`}\
<div data-view="code"${hidden("code")}>\
<p class="k-note" data-phone-device>${codeLead(view.deviceName)}</p>\
<p class="k-phone-code"><span aria-hidden="true" data-phone-code>${code}</span><span class="k-sr" data-phone-code-spoken>${spokenCode(code)}</span></p>\
${note("Only confirm if your iPhone shows exactly this code. If it doesn't, cancel: someone else may have scanned your QR code.")}${expires}\
<div class="k-acts">${postForm("/settings/phone/confirm", html`<button type="submit" class="k-btn k-btn-primary k-btn-sm"><span class="k-face">Codes match — pair</span></button>`, { hidden: { pairing: id } })}${cancel()}</div></div>\
<div data-view="confirming"${hidden("confirming")}>${shown === "confirming" ? reload : ""}<p class="k-phone-wait" role="status">Saving the pairing…</p></div>\
<div data-view="finishing"${hidden("finishing")}>${shown === "finishing" ? reload : ""}<p class="k-phone-wait" role="status">Finishing on the iPhone…</p>\
${note("Keep the Toolroll app open until it says it's paired.")}</div>\
</div>`;
  }

  /** A finished pairing's outcome, said once (the owner's own cancel is neutral). */
  function outcomeLine(view: PairingView): Html {
    switch (view.status) {
      case "paired": return infoLine("Your iPhone is paired. Open the Toolroll app to see your work.");
      case "cancelled": return infoLine("Pairing cancelled.");
      case "expired": return notice("That pairing code expired. Pair again.");
      case "contested": return notice("Another device used this code, so pairing stopped. Pair again and keep the code to yourself.");
      case "failed": return notice(view.error === null ? "Pairing didn't finish. Pair again." : `Pairing didn't finish: ${view.error} Pair again.`);
      default: return html``;
    }
  }

  function phoneRecord(phone: PhoneRow, now: Date): Html {
    const seen = phone.lastSeenAt === null ? "never connected" : `last connected ${relativeAge(phone.lastSeenAt, now)}`;
    if (phone.state === "retired") {
      return settingsRecord({ title: html`<span class="k-muted">${phone.name}</span>`, sub: `${RETIRED_WORDS[phone.retiredReason ?? "removed"]} · paired ${pairedOn(phone.pairedAt)}`,
        attrs: { "data-phone": phone.deviceId, "data-phone-state": "retired" } });
    }
    const rename = html`<details class="k-phone-rename"><summary class="k-link">Rename</summary>${postForm("/settings/phone/rename", html`\
<label class="k-phone-rename-f"><span class="k-sr">New name for ${phone.name}</span><input class="k-input" type="text" name="name" value="${phone.name}" maxlength="${PHONE_NAME_MAX}" required autocomplete="off" spellcheck="false"></label>\
<button type="submit" class="k-btn k-btn-outline k-btn-sm"><span class="k-face">Save name</span></button>`, { hidden: { device: phone.deviceId } })}</details>`;
    return settingsRecord({
      title: phone.name,
      sub: phone.state === "finishing" ? `Finishing on the iPhone… · paired ${pairedOn(phone.pairedAt)}` : `Paired ${pairedOn(phone.pairedAt)} · ${seen}`,
      attrs: { "data-phone": phone.deviceId, "data-phone-state": phone.state },
      more: joinHtml([rename, kitSectionForm({ proof: "phone-remove", action: "/settings/phone/remove", id: `phone-remove-${phone.deviceId}`, hidden: { device: phone.deviceId },
        save: { label: "Remove", variant: "danger" }, confirm: `Remove ${phone.name}`, body: "" })]),
    });
  }

  function page(who: CookieWho, options: PageOptions = {}): { body: Html; script: boolean } {
    const access = deps.access, on = access.enabled(), service = access.service(), now = runtime.clock();
    const problem = options.problem === undefined ? "" : notice(options.problem);
    const operator = store.isInstanceOperator(who.name);
    const passworded = hasPassword(who);
    const hostedChoice = access.hostedChoice();
    const hostedHost = hostedChoice.ok ? new URL(hostedChoice.url).host : null;
    const paths = service === null ? null : pathStates(service);
    const direct = paths?.direct ?? null, hosted: HostedPathState = paths?.hosted ?? { state: "off" };
    const directWorks = direct !== null && direct.state === "listening" && direct.addresses.length > 0;
    const hostedWorks = hosted.state === "connected";
    // Pair is offered only when a phone could reach this computer now (U7).
    const reachable = on && (directWorks || hostedWorks);

    // 1. The iPhone app: on or off, and how a phone reaches this computer — directly on its network, through the relay.
    const hostedBox = (checked: boolean): Html => hostedHost === null ? html`` : html`<label class="k-phone-hosted"><input type="checkbox" name="hosted" value="1"${checked ? html` checked` : ""}> <span>Also connect from anywhere through ${codeLine(hostedHost)}, ${runBy(hostedHost)}. It's end-to-end encrypted: the relay sees when your phone and ${thisMac} connect, never what they send, and it can't act for you.</span></label>`;
    const notOnStore = note(html`The iPhone app isn't on the App Store yet. <a class="k-link" href="${COMPANION_DOCS_URL}">How to install it</a>`);
    const accessBody = !passworded
      // No password, nothing to finish: one notice and the way to set one (U1). The server still refuses without it.
      ? joinHtml([notOnStore, infoLine("Set a password to pair a phone. Pairing and removing phones ask for it, so only you can do them."),
        acts(btn("Set a password", { variant: "primary", sm: true, href: "/password/set?next=%2Fsettings%2Fphone" }))])
      : joinHtml([
        notOnStore,
        ...access.problems().map(text => notice(text)),
        on && access.hostedApprovalStale() ? notice(hostedHost === null
          ? `Connecting from anywhere is off on ${thisMac} now (TOOLROLL_RELAY_URL=off).`
          : html`This Toolroll's relay setting changed to ${codeLine(hostedHost)}. Phones connect only on ${thisMac}'s network until you approve the new relay below.`) : "",
        on && direct !== null ? joinHtml([directRecord(direct, hostedWorks), hostedRecord(hosted, hostedHost !== null)]) : "",
        !operator ? note(on ? "Whoever runs this Toolroll turned phone access on." : "Ask whoever runs this Toolroll to turn on phone access.")
          : on ? joinHtml([
            // One ink act per screen (U13): Pair an iPhone is it; the relay switch is an outline.
            hostedHost === null ? "" : kitSectionForm({ proof: "phone-access", action: "/settings/phone/access", id: "phone-hosted-form", native: true,
              hidden: { act: access.hostedEnabled() ? "hosted-off" : "hosted-on" },
              save: access.hostedEnabled() ? { label: "Stop connecting from anywhere", variant: "outline" } : { label: `Connect from anywhere through ${hostedHost}`, variant: "outline" },
              confirm: access.hostedEnabled() ? "Stop connecting from anywhere" : "Connect from anywhere", body: "" }),
            kitSectionForm({ proof: "phone-access", action: "/settings/phone/access", id: "phone-access-form", native: true,
              hidden: { act: "off" }, save: { label: "Turn off phone access", variant: "danger" }, confirm: "Turn off phone access",
              body: note("Paired phones stay paired but can't connect until you turn it back on.") }),
          ])
          : kitSectionForm({ proof: "phone-access", action: "/settings/phone/access", id: "phone-access-form", native: true,
            hidden: { act: "on" }, save: { label: "Turn on phone access" }, confirm: "Turn on phone access",
            body: joinHtml([
              note(`Your phone connects straight to ${thisMac} on the same Wi-Fi (or over Tailscale).`),
              hostedHost === null ? note(`Connecting from anywhere is off on ${thisMac} (TOOLROLL_RELAY_URL=off).`) : hostedBox(true),
            ]) }),
      ]);
    const accessSection = settingsSection({
      id: "phone-access", title: "iPhone app", state: on ? " · On" : " · Off",
      lead: on ? `Your paired iPhone can see what needs you, read plans, steps and changes, and watch agents work. Approving still happens on ${thisMac}.`
        : "Let the Toolroll iPhone app see your work. Nothing is shared until you pair a phone.",
      body: accessBody,
    });

    // 2. Pair: the QR (only on the pair POST's answer), the pairing in progress, or the button.
    const binding = bindingOf(who);
    let script = false;
    let pairBody: Html | null = null;
    if (passworded) {
      const opened = openPairings.get(binding);
      let open: PairingView | null = null, restarted = false;
      if (opened !== undefined) {
        open = opened.service === service && service !== null ? pairingView(service, opened.id, binding) : null;
        // Not known any more: phone access restarted under it (M10.8), or the engine let a finished one go (L10).
        if (open === null) { restarted = opened.service !== service; openPairings.delete(binding); }
      }
      const live = open !== null && ["awaiting_scan", "awaiting_ready", "awaiting_confirm", "confirming", "finishing"].includes(open.status);
      if (open !== null && live) {
        script = true;
        pairBody = pairingPanel(open, options.qr?.pairSessionId === open.pairSessionId ? options.qr : undefined);
      } else {
        // A finished pairing's outcome is shown once, then forgotten. A problem said above replaces it (M10.3).
        if (open !== null) openPairings.delete(binding);
        const last = options.problem !== undefined ? "" : open !== null ? outcomeLine(open) : restarted ? notice("Pairing stopped because phone access restarted. Pair again.") : "";
        const why = !on ? note(operator ? "Turn on phone access first." : "Ask whoever runs this Toolroll to turn on phone access.")
          : hosted.state === "starting" && !directWorks ? note(`Connecting to ${new URL(hosted.relay).host}… Reload this page in a moment.`)
          : direct !== null && direct.state === "failed" && !hostedWorks
            ? note(hostedHost !== null && !access.hostedEnabled() ? "Direct connections aren't working (see above). Turn on connecting from anywhere to pair now." : `Direct connections aren't working (see above), so a phone can't reach ${thisMac} yet.`)
            : note(`A phone has no way to reach ${thisMac} yet. Join Wi-Fi${hostedHost !== null ? ", or connect from anywhere" : ""}.`);
        pairBody = joinHtml([
          last,
          reachable
            ? kitSectionForm({ proof: "phone-pair", action: "/settings/phone/pair", id: "phone-pair-form", native: true, save: { label: "Pair an iPhone" },
              confirm: "Pair an iPhone with Toolroll", body: note("You'll get a QR code to scan with the Toolroll app. It works once, for 5 minutes.") })
            : why,
        ]);
      }
    }
    const pairSection = pairBody === null ? "" : settingsSection({ id: "phone-pair", title: "Pair an iPhone", body: pairBody });
    if (options.qr !== undefined) {
      // The QR answer is a focused page: the pairing and nothing else to act on.
      return { body: settingsSubPage("access", "Phone", joinHtml([problem, pairSection]), { lead: "Pair an iPhone with the Toolroll app." }), script };
    }

    // 3. This person's own phones (an approver sees and renames or removes only their own) — read from the workspace, so
    // a lost phone can be seen and removed with phone access off, without turning it back on first.
    const phones = listPhones(store, { accountName: who.name }, now);
    const current = phones.filter(one => one.state !== "retired"), retired = phones.filter(one => one.state === "retired");
    const devices = phones.length === 0 && !passworded ? "" : settingsSection({
      id: "phone-devices", title: "Your phones", state: current.length === 0 ? " · None" : ` · ${current.length}`,
      body: joinHtml([
        current.length === 0 ? note("No phones are paired.") : joinHtml(current.map(phone => phoneRecord(phone, now))),
        retired.length === 0 ? "" : html`<h3 class="k-phone-sub">Removed or signed out in the last 30 days</h3>${joinHtml(retired.map(phone => phoneRecord(phone, now)))}`,
      ]),
    });

    return { body: settingsSubPage("access", "Phone", joinHtml([problem, accessSection, pairSection, devices]), { lead: "The Toolroll iPhone app: what needs you, in your pocket." }), script };
  }

  const render = (response: ServerResponse, status: number, who: CookieWho, options: PageOptions = {}) => {
    const built = page(who, options);
    return show(response, status, built.body, { script: built.script });
  };

  async function phonePage(ctx: HandlerContext): Promise<void> {
    return render(ctx.response, 200, browserCaller(ctx.who));
  }

  /** GET /settings/phone/pairings/:id — this session's own pairing as JSON (PairingView), or 404 for any other. */
  async function pairingJson(ctx: HandlerContext): Promise<void> {
    const who = browserCaller(ctx.who);
    const id = ctx.url.pathname.slice("/settings/phone/pairings/".length);
    const service = deps.access.service();
    const view = service === null ? null : pairingView(service, id, bindingOf(who));
    if (view === null) return respond(ctx.response, 404, "application/json; charset=utf-8", JSON.stringify({ error: "not_found" }));
    return respond(ctx.response, 200, "application/json; charset=utf-8", JSON.stringify(checkResponse("phonePairingView", view)));
  }

  async function accessAct(ctx: HandlerContext): Promise<void> {
    const who = browserCaller(ctx.who);
    const body = readForm(ctx.posted, CONSOLE_FORMS.phoneAccess);
    if (body.getAll("password").length > 1 || body.getAll("act").length !== 1) return render(ctx.response, 400, who, { problem: "Submit one value for each field." });
    const act = body.get("act");
    if (act !== "on" && act !== "off" && act !== "hosted-on" && act !== "hosted-off") return render(ctx.response, 400, who, { problem: "Choose on or off." });
    if (body.getAll("hosted").length > 1) return render(ctx.response, 400, who, { problem: "Submit one value for each field." });
    // An installation-wide switch: an instance operator's, proved again here (the route's role gate drew the form).
    if (!store.isInstanceOperator(who.name)) return render(ctx.response, 403, who, { problem: "An instance operator turns phone access on or off." });
    if (!passwordHolds(who, body.get("password") ?? "")) return render(ctx.response, 403, who, { problem: passwordProblem(who) });
    // "on" carries the hosted choice from its checkbox; hosted-on/off change only that, and only while access is on
    // (decided inside the access queue, after any change posted before this one).
    const change = act === "on" ? { act, hosted: body.get("hosted") === "1" } as const : { act } as const;
    const applied = await deps.access.change(change, who.name, runtime.clock(), () => store.isInstanceOperator(who.name) && store.accountOf(who.name)?.generation === who.session.generation);
    if (applied === "not_on") return render(ctx.response, 409, who, { problem: "Phone access is off now. Turn it on first." });
    if (applied === "not_allowed") return render(ctx.response, 403, who, { problem: "An instance operator turns phone access on or off." });
    return redirect(ctx.response, "/settings/phone");
  }

  async function pairAct(ctx: HandlerContext): Promise<void> {
    const who = browserCaller(ctx.who);
    const body = readForm(ctx.posted, CONSOLE_FORMS.phonePair);
    if (body.getAll("password").length > 1) return render(ctx.response, 400, who, { problem: "Submit one value for each field." });
    // Pairing a phone is a credential act: the password, typed, every time.
    if (!passwordHolds(who, body.get("password") ?? "")) return render(ctx.response, 403, who, { problem: passwordProblem(who) });
    const service = deps.access.service();
    if (service === null) return render(ctx.response, 409, who, { problem: "Turn on phone access first." });
    const binding = bindingOf(who);
    const started = startPairing(service, who.name, binding, who.session.generation);
    if (!started.ok) return render(ctx.response, 409, who, { problem: started.error });
    openPairings.set(binding, { id: started.qr.pairSessionId, service });
    const built = page(who, { qr: { payload: JSON.stringify(started.qr), pairSessionId: started.qr.pairSessionId, expiresAtMs: started.expiresAtMs } });
    return show(ctx.response, 200, built.body, { sensitive: true, script: built.script });
  }

  const pairingAct = (op: "confirm" | "cancel") => async (ctx: HandlerContext): Promise<void> => {
    const who = browserCaller(ctx.who);
    const body = readForm(ctx.posted, CONSOLE_FORMS.phonePairing);
    const pairing = body.getAll("pairing").length === 1 ? body.get("pairing") ?? "" : "";
    const binding = bindingOf(who);
    const service = deps.access.service();
    const opened = openPairings.get(binding);
    // Only this session's own open pairing, by its id, on the service it started on.
    if (service === null || pairing === "" || opened === undefined || opened.id !== pairing || opened.service !== service) {
      return refuse(ctx.response, who, 409, "That pairing isn't open any more. Pair again.", "/settings/phone");
    }
    if (op === "cancel") {
      cancelPairing(service, pairing, binding);
      return redirect(ctx.response, "/settings/phone#phone-pair");
    }
    const confirmed = await confirmPairing(service, pairing, binding);
    if (!confirmed.ok) return render(ctx.response, 409, who, { problem: confirmed.error });
    // Back to the pairing itself: "Finishing on the iPhone…", then the success line (U18).
    return redirect(ctx.response, "/settings/phone#phone-pair");
  };

  async function renameAct(ctx: HandlerContext): Promise<void> {
    const who = browserCaller(ctx.who);
    const body = readForm(ctx.posted, CONSOLE_FORMS.phoneRename);
    if (body.getAll("device").length !== 1 || body.getAll("name").length !== 1) return render(ctx.response, 400, who, { problem: "Submit one value for each field." });
    const name = (body.get("name") ?? "").trim();
    if (name.length === 0 || name.length > PHONE_NAME_MAX) return render(ctx.response, 400, who, { problem: `Name the phone in 1 to ${PHONE_NAME_MAX} characters.` });
    // Only the person's own phone (a teammate's is never named here, and an unknown one is the same answer).
    if (!renamePhone(store, body.get("device") ?? "", name, who.name)) return render(ctx.response, 404, who, { problem: "That phone isn't paired." });
    return redirect(ctx.response, "/settings/phone#phone-devices");
  }

  async function removeAct(ctx: HandlerContext): Promise<void> {
    const who = browserCaller(ctx.who);
    const body = readForm(ctx.posted, CONSOLE_FORMS.phoneRemove);
    if (body.getAll("password").length > 1 || body.getAll("device").length !== 1) return render(ctx.response, 400, who, { problem: "Submit one value for each field." });
    if (!passwordHolds(who, body.get("password") ?? "")) return render(ctx.response, 403, who, { problem: passwordProblem(who) });
    // Only the person's own phone, removed now: its sessions end before this answers; the relay hears in the background.
    if (!removePhone(deps.access.service(), store, body.get("device") ?? "", who.name, runtime.clock())) return render(ctx.response, 404, who, { problem: "That phone isn't paired." });
    return redirect(ctx.response, "/settings/phone#phone-devices");
  }

  return {
    registrations: handlersOf("settings", {
      "settings.phone": phonePage,
      "settings.phone-pairing": pairingJson,
      "settings.phone-access": accessAct,
      "settings.phone-pair": pairAct,
      "settings.phone-confirm": pairingAct("confirm"),
      "settings.phone-cancel": pairingAct("cancel"),
      "settings.phone-rename": renameAct,
      "settings.phone-remove": removeAct,
    }),
  };
}
