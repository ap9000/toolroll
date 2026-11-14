import { handlersOf } from './handler-registry.js';
import { adapterPolicy } from "./route-policy.js";
/** settings handlers, moved without changing their route bodies. */
import { mintApiToken,TOKEN_DAYS } from "../api-tokens.js";
import { CONSOLE_FORMS,readForm } from "../contracts/console-api.js";
import { html, htmlString, joinHtml, postForm, reauth, replaceMarkup, scriptElement, type Html, type HtmlValue } from "../html.js";
import { credentialsHtml,tokenShownHtml } from "../credentials-ui.js";
import {
projectName
} from "../project.js";
import { requestLimitsHtml,tokenLimitWords } from "../request-budget-ui.js";
import { authenticateAccount } from "../scope.js";
import { SSO_CALLBACK } from "../sso-settings.js";
import type { EdgeContext,HandlerContext } from './handler-context.js';
import type { ServerRuntime } from './runtime.js';
import { personChip,refuse,screen } from "./chrome.js";
import { inviteLinkHtml,ownAccessHtml,peopleHtml,settingsSubPage } from "../settings-groups-ui.js";
import { redirect,respond,sayTo } from "./http.js";
/** people handlers, moved without changing their route bodies. */
import { randomBytes } from "node:crypto";
import { type IncomingMessage,type ServerResponse } from "node:http";
import { type FormFieldOf,type FormView } from "../contracts/console-api.js";
import { listCoordinators } from "../coordinator.js";
import { logEvent } from "../log.js";
import { accessFromGroups,accountNameFor,exchangeOidcCode,newOidcVisit,oidcAuthorizeUrl,verifyIdToken } from "../oidc.js";
import { personAuditHtml,personHref } from "../people-audit-ui.js";
import { cursorOf as auditCursorOf,remoteAudit } from "../remote-audit.js";
import { credentialProof,hashPassword,proveAccountNow } from "../scope.js";
import { form,HANDOFF_STYLE,loginHref,loginReturn,page,passwordSetNext,SIGN_IN_COOKIE,signInSpent,startedHere } from "./http.js";
import { joinDeadPage,joinFormPage,loginPage,passwordAlreadySetPage,passwordSetPage,reconnectPage,SIGNUP_NAME,SIGNUP_PASSWORD_MIN,signupPage,type PasswordSetProblem } from "./render-people.js";
import { enrollOwnerPassword, liveInviteTerms, localOwnerBinding } from "../store.js";
import { KEY_FILL_SCRIPT } from "./mutation-key.js";
import { LOCAL_OWNER_LAPSED } from "../local-owner.js";
import { withFormToken } from "./request-context.js";
import { loginHelpOf } from "./login-help.js";
import type { Store } from "../store.js";
import { FULL_SESSION,SESSION_COOKIE,SIGN_IN_LINK_PATH,type SsoIntent } from "./session.js";
import { setupCodeMatches,signupCookie,signupFromHere } from "./signup-gate.js";

/** Clock skew allowed between the provider and this server when reading auth_time — forward only (a provider clock
 * running ahead). auth_time is in whole seconds, so a check made in the visit's own second is floored below startedAt:
 * the one allowance backward is that rounding, never a check made before the visit began. */
const AUTH_TIME_SKEW_MS = 60_000;
/** When the provider checked the person, in ms, if its auth_time is a check made for this visit: present, no earlier
 * than the second the visit began, and not in the future beyond the skew. Null otherwise. */
export function sameVisitCheck(authTime: number | null, startedAt: number, now: number): number | null {
  if (authTime === null || !Number.isFinite(authTime)) return null;
  const at = authTime * 1000;
  if (at < Math.floor(startedAt / 1000) * 1000 || at > now + AUTH_TIME_SKEW_MS) return null;
  return Math.min(Math.max(at, startedAt), now);
}
export function createPeopleHandlers(runtime: ServerRuntime) {
  const { joinBySource, ssoOffer, ssoVisits, ssoSettings, options, clock, ssoHandoffs, managedRepos, store, visible, admissionList, sendScreen, chromeFor, restricted, sessions, consoleProjects, authenticateApprover, authenticateCredential, bustBadge, projectOf, signInLinks, linkKey, fromThisComputer, recordSignIn, passwordAllowed, arrival, cookieSecure, consoleOrigin, providerFor, providerKnown, joinSourceOf, signInBudget, signInActor, minutesWords, browserKeys } = runtime;

  // v101: Settings → Sessions & tokens: where you're signed in, and your API tokens. An instance operator can see everyone's.
  async function sessionsPage(ctx: HandlerContext): Promise<void> {
    const { url, who, response, project } = ctx;
    if (who.via !== "cookie") return refuse(response, who, 403, "Sign in in a browser to see your sessions.", "/settings");
    const everyone = url.searchParams.get("everyone") === "1" && store.isInstanceOperator(who.name);
    const here = sessions.hashOf(who.session);
    const view = { who: who.name, everyone, canSeeEveryone: store.isInstanceOperator(who.name), now: Date.now(),
      sessions: store.webSessions(everyone ? null : who.name).map(one => ({ ...one, here: one.idHash === here })), tokens: store.apiTokens(everyone ? null : who.name),
      limits: { note: tokenLimitWords.bind(null, store.handle), section: store.isInstanceOperator(who.name) ? requestLimitsHtml(store.handle, store.apiTokens(null), Date.now()) : html`` } };
    return sendScreen(response, 200, screen("Sessions & tokens", settingsSubPage("access", "Sessions and tokens", html`${credentialsHtml(view, { said: url.searchParams.get("said"), problem: url.searchParams.get("problem") })}`),
      { chrome: chromeFor(project, "settings") }));
  }

  async function peoplePage(ctx: HandlerContext): Promise<void> {
    const { url, who, response, now, project } = ctx;
    // People → a person: their API tokens and remote activity (people-audit-ui.ts). An approver may open anyone, within
    // their projects; anyone else only themselves. Another person reads exactly like nobody.
    const person = url.searchParams.get("person");
    if (person !== null) {
      const token = (url.searchParams.get("token-name") ?? "").slice(0, 60) || null, before = url.searchParams.get("before");
      const cursor = before === null ? null : auditCursorOf(before);
      if (before !== null && cursor === null) return refuse(response, who, 400, "Invalid activity cursor.", "/people");
      const page = who.role === "approver" || person === who.name
        ? remoteAudit(store, { self: who.name, everyone: who.role === "approver", repos: admissionList(), unplaced: store.isInstanceOperator(who.name) },
          { person, token, source: null, since: null }, { before: cursor })
        : null;
      if (page === null || !page.ok) return refuse(response, who, 404, "No such person.", "/people");
      return sendScreen(response, 200, screen("people", personAuditHtml({ name: person, tokens: store.apiTokens(person), actions: page.actions, token, nextCursor: page.nextCursor, now }),
        { chrome: chromeFor(project, "people") }));
    }
    // Approvers see everyone (D7's ceiling: every fact already passed
    // the process admission); a viewer sees exactly themselves (U3).
    if (restricted()) {
      const projects = admissionList() ?? [];
      return sendScreen(response, 200, screen("Your access", ownAccessHtml({ name: who.name, approver: who.role === "approver", projects: projects.map(repo => projectName(repo)), activity: personHref(who.name) }), { chrome: chromeFor(project, "people") }));
    }
    const approverView = store.isInstanceOperator(who.name);
    const accounts = store.accountFacts().filter(one => approverView || one.name === who.name);
    const lastSeenOf = (name: string): number | null => {
      let seen: number | null = null;
      for (const session of sessions.values()) {
        if (session.name === name && (seen === null || session.lastSeen > seen)) seen = session.lastSeen;
      }
      return seen;
    };
    const projectChoices = consoleProjects();
    const people = accounts.map(one => {
      const seen = lastSeenOf(one.name);
      return {
        name: one.name, you: one.name === who.name, approver: one.role === "approver", projects: one.projects,
        projectNames: one.projects === null ? "All projects" : one.projects.length === 0 ? "No project access" : one.projects.map(repo => projectName(repo)).join(", "),
        revoked: one.revokedAt === null ? null : `Removed ${one.revokedAt.slice(0, 16).replace("T", " ")} by ${one.revokedBy ?? "someone"}`,
        seen: seen === null ? `Joined ${one.addedAt.slice(0, 10)}` : now.getTime() - seen < 5 * 60_000 ? "Signed in now" : `Active ${new Date(seen).toISOString().slice(11, 16)} UTC`,
        joined: one.addedAt.slice(0, 10), activity: personHref(one.name),
        acts: store.recentActsOf(one.name).map(act => `${act.kind} ${act.subject} ${act.at.slice(0, 16).replace("T", " ")}`),
      };
    });
    const invites = approverView ? store.openInvites(now) : [];
    const filers = !approverView ? [] : listCoordinators(store).map(one => ({ name: `${one.name}#${one.cid.slice(0, 4)}`, words: one.revokedAt !== null ? `Revoked ${one.revokedAt.slice(0, 10)}`
      : `${one.perHour} an hour · files into ${one.repos.join(", ")} · ${one.expiresAt === null ? "no expiry (made before expiry)" : `expires ${one.expiresAt.slice(0, 10)}`} · last filed ${one.lastFiledAt === null ? "never" : one.lastFiledAt.slice(0, 16).replace("T", " ")}` }));
    return sendScreen(
      response,
      200,
      screen("People", peopleHtml({
        operator: approverView, you: who.name, said: url.searchParams.get("said"), problem: url.searchParams.get("problem"), people,
        invites: invites.map(one => ({ id: one.id, role: one.role, projects: one.projects === null ? "All projects" : one.projects.map(repo => projectName(repo)).join(", "), from: one.mintedBy, expires: `${one.expiresAt.slice(0, 16).replace("T", " ")} UTC`, attempts: one.attempts })),
        projects: projectChoices.map(repo => ({ repo, name: projectName(repo) })), openProject: project !== null && projectChoices.includes(project) ? project : null, filers,
      }), { chrome: chromeFor(project, "people") }),
    );
  }

  async function sessionsSend(ctx: HandlerContext): Promise<void> {
    const { who, request, response, now, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.sessions);
    if (who.via !== "cookie") return refuse(response, who, 403, "Sign in in a browser to manage sessions and tokens.", "/settings");
    const operator = store.isInstanceOperator(who.name);
    const back = sayTo(response, `/settings/sessions${body.get("everyone") === "1" && operator ? "?everyone=1" : ""}`);
    const action = body.get("action") ?? "";
    if (action === "end-session") {
      const target = store.webSessions(null).find(one => one.idHash === (body.get("session") ?? ""));
      if (target === undefined) return back("problem", "That session has already ended.");
      if (target.account !== who.name && !operator) return refuse(response, who, 403, "You can end only your own sessions.", "/settings/sessions");
      sessions.endByHash(target.idHash);
      recordSignIn(target.account, "signed out", target.account === who.name ? "by you elsewhere" : `by ${who.name}`);
      return back("said", "Signed out there.");
    }
    if (action === "end-others") {
      const here = sessions.hashOf(who.session);
      const others = store.webSessions(who.name).filter(one => one.idHash !== here);
      for (const one of others) sessions.endByHash(one.idHash);
      if (others.length > 0) recordSignIn(who.name, "signed out", `everywhere else (${others.length})`);
      return back("said", others.length === 0 ? "You aren't signed in anywhere else." : `Signed out of ${others.length} other session${others.length === 1 ? "" : "s"}.`);
    }
    if (action === "revoke-token") {
      const token = store.apiTokens(null).find(one => one.id === (body.get("token") ?? ""));
      if (token === undefined || token.revokedAt !== null) return back("problem", "That token was already revoked.");
      if (token.account !== who.name && !operator) return refuse(response, who, 403, "You can revoke only your own tokens.", "/settings/sessions");
      store.revokeApiToken(token.id, who.name, now);
      return back("said", `Revoked ${token.name}. Anything using it stops working now.`);
    }
    if (action === "create-token") {
      const name = (body.get("name") ?? "").trim().replace(/[\u0000-\u001f\u007f]+/g, " ");
      const access = body.get("access") === "act" ? "act" as const : "read" as const;
      const days = Number(body.get("days"));
      if (name === "" || name.length > 60) return back("problem", "Name the token, in 60 characters or fewer.");
      if (!(TOKEN_DAYS as readonly number[]).includes(days)) return back("problem", "Choose when it expires.");
      if (access === "act" && who.role !== "approver") return back("problem", "A viewer's token can only read.");
      // A token is a credential: made with the person's password typed now (or an explicit identity-provider re-check,
      // spent by it), counted once. Never a remembered password: this act is outside every freshness allowlist.
      const typed = body.get("password") ?? "";
      // Passwordless never covers it (docs/plans/passwordless.md: a credential act).
      const viewerProof = who.role === "approver" || who.via !== "cookie" ? null : proveAccountNow(store, who.name, typed, { credential: true });
      const confirmed = who.role === "approver" ? authenticateCredential(who, typed).ok
        : viewerProof !== null && viewerProof.ok && credentialProof(viewerProof.method);
      if (!confirmed) return back("problem", "Enter your Toolroll password to make a token.");
      const minted = mintApiToken();
      const expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString();
      store.createApiToken({ id: minted.id, account: who.name, name, secretHash: minted.hash, access, expiresAt, by: who.name }, now);
      // The token, once, on a page with no script.
      return sendScreen(response, 200, screen("API token", tokenShownHtml(name, minted.token, access, expiresAt), { chrome: chromeFor(projectOf(who, request) ?? null, "settings"), forceSensitive: true }));
    }
    return back("problem", "Choose an action.");
  }

  async function peopleProjects(ctx: HandlerContext): Promise<void> {
    const { who, response, now, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.peopleProjects);
    // Widening access (up to instance operator) is a credential act: a password typed now, Passwordless or not.
    if (!authenticateCredential(who, body.get("token") ?? "", null).ok) return refuse(response, who, 403, "Saving access requires your password.", "/people");
    const access = readAccessForm(body);
    if (!access.ok) return refuse(response, who, 400, access.message, "/people");
    const changed = store.setAccountProjects((body.get("name") ?? "").trim(), access.projects, who.name, now);
    if (!changed.ok) return refuse(response, who, 409, changed.reason === "last-instance-operator" ? "Keep at least one instance operator with all-project access." : "That account cannot be changed.", "/people");
    bustBadge();
    return redirect(response, "/people?said=Project%20access%20saved");
  }

  async function peopleInvite(ctx: HandlerContext): Promise<void> {
    const { who, request, response, now, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.peopleInvite);
    if (who.via !== "cookie") return refuse(response, who, 403, "inviting is a browser surface");
    const token = body.get("token") ?? "";
    // RAISING authority is a password ceremony (the doctrine): adding a
    // person to the instance is exactly that.
    if (!authenticateCredential(who, token).ok) {
      return refuse(response, who, 403, "making an invite takes your password, typed again", "/people");
    }
    const role = body.get("role") === "approver" ? ("approver" as const) : ("viewer" as const);
    const access = readAccessForm(body);
    if (!access.ok) return refuse(response, who, 400, access.message, "/people");
    if (access.projects !== null && access.projects.length === 0) return refuse(response, who, 400, "Select at least one project for this invitation.", "/people");
    const minted = store.mintInvite(role, who.name, now, undefined, access.projects);
    const origin = options.publicUrl !== undefined ? options.publicUrl.replace(/\/$/, "") : `http://${request.headers.host ?? "this-console"}`;
    const linkScreen = screen(
      "Invite link",
      inviteLinkHtml({ link: `${origin}/join/${minted.token}`, approver: role === "approver", projects: access.projects === null ? "all projects" : access.projects.map(repo => projectName(repo)).join(", "), expires: `${minted.expiresAt.slice(0, 16).replace("T", " ")} UTC` }),
      // A one-time secret on screen: no script of any kind rides along.
      { chrome: chromeFor(projectOf(who, request) ?? null, "people"), forceSensitive: true },
    );
    return sendScreen(response, 200, linkScreen);
  }

  async function peopleInviteRevoke(ctx: HandlerContext): Promise<void> {
    const { who, response, now, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.peopleInviteRevoke);
    if (who.via !== "cookie") return refuse(response, who, 403, "inviting is a browser surface");
    const token = body.get("token") ?? "";
    if (!authenticateApprover(who, token).ok) {
      return refuse(response, who, 403, "cancelling an invite takes your password, typed again", "/people");
    }
    const id = Number(body.get("id") ?? "");
    const revoked = Number.isInteger(id) && id > 0 && store.revokeInvite(id, now);
    return redirect(response, `/people?said=${encodeURIComponent(revoked ? "the invite is cancelled — its link is dead" : "that invite was already gone")}`);
  }

  async function peopleRevoke(ctx: HandlerContext): Promise<void> {
    const { who, response, now, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.peopleRevoke);
    if (who.via !== "cookie") return refuse(response, who, 403, "removing a person is a browser surface");
    const token = body.get("token") ?? "";
    if (!authenticateApprover(who, token).ok) {
      return refuse(response, who, 403, "removing a person takes your password, typed again", "/people");
    }
    const name = (body.get("name") ?? "").trim();
    const severed = store.revokeAccount(name, who.name, now);
    if (!severed.ok) {
      const words =
        severed.reason === "last-approver"
          ? "that is the last account that can approve — add another approver first"
          : severed.reason === "already-revoked"
            ? `${name} is already removed`
            : `no account \u0060${name}\u0060`;
      return refuse(response, who, severed.reason === "last-approver" ? 409 : 404, words, "/people");
    }
    return redirect(
      response,
      `/people?said=${encodeURIComponent(`${name} can no longer sign in — their sessions, invites, and signed modes ended with them; history stays`)}`,
    );
  }

  async function signInPage(ctx: EdgeContext): Promise<void> {
    const { url, response } = ctx;
    if (options.setupCode !== undefined && store.listApprovers().length === 0) {
      // The form's same-site proof (signup-gate.ts): a post without it never reaches the setup code.
      if (runtime.setupAttemptsLeft > 0) response.setHeader("Set-Cookie", signupCookie(cookieSecure));
      // Its own post then carries this console's Origin (the console's default no-referrer sends `null`).
      response.setHeader("Referrer-Policy", "same-origin");
      return page(response, 200, signupPage(null, runtime.setupAttemptsLeft));
    }
    return page(response, 200, loginWith(store, null, loginReturn(url.searchParams.get("return")), ssoOffer()));
  }

  // The one-time link `up` opens (onboarding): it signs the browser on this computer in and lands on Chat. Spent on
  // the first visit whatever happens; the ledger notes the sign-in, never the link.
  async function signInLink(ctx: EdgeContext): Promise<void> {
    const { url, request, response } = ctx;
    const code = url.pathname.slice(SIGN_IN_LINK_PATH.length);
    const held = /^[A-Za-z0-9_-]{43}$/.test(code) ? signInLinks.get(linkKey(code)) : undefined;
    if (held !== undefined) signInLinks.delete(linkKey(code));
    response.setHeader("Referrer-Policy", "no-referrer");
    if (!fromThisComputer(request)) {
      recordSignIn(held?.account ?? "unknown account", "sign-in refused", "one-time link", "opened from another device");
      return page(response, 403, loginWith(store, "That sign-in link works only in a browser on the computer running Toolroll. Sign in with your password.", "/chat", ssoOffer()));
    }
    if (held === undefined || held.expires < Date.now()) {
      return page(response, 410, loginWith(store, html`That sign-in link has been used or has expired. Sign in with your password, or run <code>toolroll</code> again.`, "/chat", ssoOffer()));
    }
    const account = store.accountOf(held.account);
    if (account === null || account.role !== "approver" || account.revokedAt !== null) return page(response, 403, loginWith(store, "That account can't sign in here any more.", "/chat", ssoOffer()));
    if (!passwordAllowed(held.account)) return page(response, 403, loginWith(store, `Sign in with ${ssoSettings()?.label ?? "your identity provider"}.`, "/chat", ssoOffer()));
    const id = randomBytes(32).toString("hex");
    const keyed = keyFor(request);
    const base = { ...arrival(request), name: held.account, csrf: randomBytes(32).toString("hex"), role: account.role, generation: account.generation, createdAt: Date.now(), sawBoardAt: null, lastSeen: Date.now(),
      project: runtime.defaultProject, projectRevision: 1 };
    if (held.kind === "local-owner") {
      // Easy-start C4: a local owner's link becomes only a local-owner session, and only if local mode, read again in
      // the same transaction as the session is saved, is still on at the link's generation for the same owner, and the
      // owner's account generation hasn't moved (a password set since ended this road).
      const made = store.transact(() => {
        const now = localOwnerBinding(store);
        if (now === null || now.account !== held.account || now.localGeneration !== held.localGeneration || now.accountGeneration !== held.accountGeneration) return false;
        sessions.set(id, { ...base, generation: now.accountGeneration, authority: "local-owner", localGeneration: now.localGeneration, ...keyed.fields });
        return true;
      });
      if (!made) return page(response, 410, loginWith(store, html`That sign-in link has been used or has expired. Run <code>toolroll</code> again to open Toolroll.`, "/chat", ssoOffer()));
      recordSignIn(held.account, "signed in", "local link");
    } else {
      sessions.set(id, { ...base, ...FULL_SESSION, ...keyed.fields });
      recordSignIn(held.account, "signed in", "one-time link");
    }
    return signedInTo(response, keyed.key, "/chat", [`${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${cookieSecure}`]);
  }

  // v100: sign-in with the identity provider. ?reauth=1 asks it to check the person again (a step-up);
  // ?link=1 links the signed-in account to it. The browser that starts it holds the visit's state.
  async function ssoStart(ctx: EdgeContext): Promise<void> {
    const { url, who, request, response } = ctx;
    const settings = ssoSettings();
    const intent: SsoIntent = url.searchParams.get("link") === "1" ? "link" : url.searchParams.get("reauth") === "1" ? "reauth" : "sign-in";
    const returnTo = loginReturn(url.searchParams.get("return"));
    if (settings === null) return page(response, 404, loginWith(store, "Sign-in with an identity provider isn't on.", returnTo));
    if (intent !== "sign-in" && who?.via !== "cookie") return redirect(response, loginHref(returnTo));
    const origin = consoleOrigin(request.headers.host);
    if (origin === null) return page(response, 400, loginWith(store, "Sign in from this computer (localhost) or from your https address.", returnTo, ssoOffer()));
    // Discovered as the console starts and in the background (docs/plans/get-side-effects.md): following this link
    // fetches nothing.
    const known = providerKnown(settings.issuer);
    if (known === null) return page(response, 503, loginWith(store, `${settings.label} isn't answering yet. Try again in a moment.`, returnTo, ssoOffer()));
    const found = { provider: known };
    const visit = newOidcVisit(), redirectUri = `${origin}${SSO_CALLBACK}`;
    for (const [key, one] of ssoVisits) if (one.expires < Date.now()) ssoVisits.delete(key);
    // Bounded: anyone may start a sign-in, so the oldest waiting ones give way.
    while (ssoVisits.size >= 1000) ssoVisits.delete(ssoVisits.keys().next().value!);
    const asker = intent === "sign-in" || who?.via !== "cookie" ? null : sessions.hashOf(who.session);
    ssoVisits.set(visit.state, { visit, provider: found.provider, redirect: redirectUri, intent, returnTo, expires: Date.now() + 15 * 60_000, startedAt: Date.now(),
      session: asker === null || who?.via !== "cookie" ? null : { hash: asker, generation: who.session.generation } });
    response.writeHead(302, { location: oidcAuthorizeUrl(found.provider, settings, visit, redirectUri, intent === "reauth"), "cache-control": "no-store", "referrer-policy": "no-referrer",
      "set-cookie": `${SIGN_IN_COOKIE}=${visit.state}; Path=${SSO_CALLBACK}; Max-Age=900; HttpOnly; SameSite=Lax${origin.startsWith("https:") ? "; Secure" : ""}` });
    response.end();
    return;
  }

  async function ssoReturn(ctx: EdgeContext): Promise<void> {
    return ssoCallback(ctx.request, ctx.response, ctx.url);
  }

  async function ssoFinish(ctx: EdgeContext): Promise<void> {
    const { url, who, request, response } = ctx;
    const key = url.searchParams.get("h") ?? "";
    if (!startedHere(request, key)) return page(response, 400, loginWith(store, "That sign-in was started in another browser. Sign in again from this one.", "/", ssoOffer()));
    const handoff = ssoHandoffs.get(key);
    ssoHandoffs.delete(key);
    response.setHeader("Set-Cookie", signInSpent("/login/sso/finish"));
    const settings = ssoSettings();
    if (handoff === undefined || handoff.expires < Date.now() || settings === null) return page(response, 400, loginWith(store, "That sign-in expired. Try again.", "/", ssoOffer()));
    const { claims } = handoff;
    const identity = { issuer: handoff.issuer, subject: claims.sub, email: claims.email, label: settings.label };
    if (handoff.intent === "link" || handoff.intent === "reauth") {
      if (who?.via !== "cookie") return redirect(response, loginHref(handoff.returnTo));
      // Only the session that asked: same kept session, same credential generation.
      if (handoff.session === null || sessions.hashOf(who.session) !== handoff.session.hash || who.session.generation !== handoff.session.generation) {
        return page(response, 403, loginWith(store, `That ${settings.label} check was started by another sign-in. Start it again from this page.`, handoff.returnTo, ssoOffer()));
      }
      if (handoff.intent === "link") {
        const linked = store.linkSsoIdentity(who.name, identity, clock());
        if (!linked.ok) return redirect(response, `/settings/sign-in?problem=${encodeURIComponent(`That ${settings.label} account signs in as someone else here.`)}`);
        who.session.sso = { at: handoff.checkedAt ?? 0 };
        sessions.persist(who.session);
        return redirect(response, `/settings/sign-in?said=${encodeURIComponent(`This account signs in with ${settings.label} now.`)}`);
      }
      // A step-up: the provider checked the same person again.
      if (store.ssoAccount(identity.issuer, identity.subject) !== who.name) return page(response, 403, loginWith(store, `That ${settings.label} account isn't the one signed in here.`, handoff.returnTo, ssoOffer()));
      who.session.sso = { at: handoff.checkedAt ?? 0 };
      // An explicit re-check on request: the one identity-provider event that stands in for a password typed now (for ONE
      // step-up, spent by it) and may start a freshness window (B2). Kept in memory only: a restart forgets it.
      if (handoff.checkedAt !== null) { who.session.ssoReauthAt = handoff.checkedAt; who.session.ssoNowAt = handoff.checkedAt; }
      sessions.persist(who.session);
      recordSignIn(who.name, "confirmed", settings.label);
      return redirect(response, handoff.returnTo);
    }
    const rule = accessFromGroups(claims.groups, settings.rules);
    const signedIn = store.signInWithSso(identity, rule === null ? null : { role: rule.role === "operator" ? "approver" : "viewer", projects: rule.projects === "all" ? null : rule.projects },
      () => accountNameFor(claims, name => store.accountOf(name) !== null), clock());
    if (!signedIn.ok) {
      recordSignIn(store.ssoAccount(identity.issuer, identity.subject) ?? "unknown account", "sign-in refused", signedIn.reason === "no-group" ? "no matching group" : signedIn.reason);
      return page(response, 403, loginWith(store, signedIn.reason === "no-group" ? `Your ${settings.label} account isn't in a group that may use Toolroll. Ask whoever runs it.`
        : signedIn.reason === "revoked" ? "This account was removed. Ask whoever runs Toolroll." : "That change would leave no one who can run this installation.", "/", ssoOffer()));
    }
    const account = store.accountOf(signedIn.account)!;
    const id = randomBytes(32).toString("hex");
    const keyed = keyFor(request);
    sessions.set(id, { ...arrival(request), ...FULL_SESSION, ...keyed.fields, name: signedIn.account, csrf: randomBytes(32).toString("hex"), role: account.role, generation: account.generation, createdAt: Date.now(), sawBoardAt: null, lastSeen: Date.now(),
      project: runtime.defaultProject, projectRevision: 1, sso: { at: handoff.checkedAt ?? 0 } });
    recordSignIn(signedIn.account, "signed in", settings.label);
    return signedInTo(response, keyed.key, handoff.returnTo, [signInSpent("/login/sso/finish"), `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${cookieSecure}`]);
  }

  async function signupSend(ctx: EdgeContext): Promise<void> {
    const { request, response } = ctx;
    // A re-shown form posts again: its Origin must name this console too (signup-gate.ts).
    response.setHeader("Referrer-Policy", "same-origin");
    // Only while the table is empty, only with the printed code, only
    // five tries: the bootstrap door underneath is atomic, so two first
    // visitors serialize to one owner.
    if (options.setupCode === undefined || store.listApprovers().length > 0) {
      return page(response, 409, loginWith(store, "An account already exists. Sign in."));
    }
    if (runtime.setupAttemptsLeft <= 0) {
      return page(response, 403, signupPage(null, 0));
    }
    // Another site's post (or one without this page's cookie) is refused before it can spend a try.
    if (!signupFromHere(request, runtime.allowedHost)) {
      request.resume();
      response.setHeader("Set-Cookie", signupCookie(cookieSecure));
      return page(response, 403, signupPage("This form had expired, so it was reloaded. Enter the details again.", runtime.setupAttemptsLeft));
    }
    const body = readForm(await form(request), CONSOLE_FORMS.signup);
    const code = (body.get("code") ?? "").trim();
    const name = (body.get("name") ?? "").trim();
    const password = body.get("password") ?? "";
    // Re-read after the body: concurrent posts all waited above, and only the tries still left may be compared.
    // From here to the decrement nothing awaits, so check and spend are one step.
    if (runtime.setupAttemptsLeft <= 0) {
      return page(response, 403, signupPage(null, 0));
    }
    if (!setupCodeMatches(code, options.setupCode)) {
      runtime.setupAttemptsLeft -= 1;
      // What was typed comes back except the code and the password (never echoed); the count rides the code's note.
      return page(response, 403, signupPage(runtime.setupAttemptsLeft > 0
        ? { field: "code", text: "That isn't the setup code Toolroll printed. Check the terminal and try again." }
        : "That wasn't the setup code, and that was the last try. Restart Toolroll to get a new code.", runtime.setupAttemptsLeft, name));
    }
    if (!SIGNUP_NAME.test(name)) {
      return page(response, 400, signupPage({ field: "name", text: "Use only letters, digits, dots, dashes or underscores, starting with a letter or digit." }, runtime.setupAttemptsLeft, name));
    }
    if (password.length < SIGNUP_PASSWORD_MIN) {
      return page(response, 400, signupPage({ field: "password", text: `Use at least ${SIGNUP_PASSWORD_MIN} characters.` }, runtime.setupAttemptsLeft, name));
    }
    const made = store.bootstrapApproverIfNone(name, hashPassword(password), clock());
    if (!made.ok) return page(response, 409, loginWith(store, "An account already exists. Sign in."));
    const authenticated = authenticateAccount(store, name, password);
    if (authenticated === null || !authenticated.ok) return page(response, 500, loginWith(store, "The account was created, but signing in failed. Sign in with it now."));
    const id = randomBytes(32).toString("hex");
    const keyed = keyFor(request);
    sessions.set(id, {
      ...arrival(request),
      ...FULL_SESSION,
      ...keyed.fields,
      name,
      csrf: randomBytes(32).toString("hex"),
      role: authenticated.role,
      generation: authenticated.generation,
      createdAt: Date.now(),
      sawBoardAt: null,
      lastSeen: Date.now(),
      project: runtime.defaultProject,
      projectRevision: 1,
      // A password typed on this computer starts this session's freshness window (cockpit B2); from anywhere else, never.
      ...(fromThisComputer(request) ? { passwordAt: Date.now() } : {}),
    });
    return signedInTo(response, keyed.key, "/", [`${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${cookieSecure}`]);
  }

  async function loginSend(ctx: EdgeContext): Promise<void> {
    const { request, response } = ctx;
    const body = readForm(await form(request), CONSOLE_FORMS.login);
    const name = body.get("name");
    const token = body.get("token");
    // The destination a deep link asked for rides the form as a same-site
    // path, re-checked here on both roads: a failed sign-in keeps it, a
    // successful one lands on it. Nothing about the sign-in itself changes.
    const returnTo = loginReturn(body.get("return"));
    const source = joinSourceOf(request), at = Date.now();
    const wait = signInBudget.waitFor(source, at);
    if (wait > 0) {
      recordSignIn(signInActor(name), "sign-in refused", "too many tries", "from one address");
      response.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
      return page(response, 429, loginWith(store, `Too many sign-in attempts. Try again in ${minutesWords(wait)}.`, returnTo));
    }
    const authenticated =
      name !== null && token !== null ? authenticateAccount(store, name, token) : null;
    if (authenticated === null || !authenticated.ok) {
      if (authenticated?.reason === "locked") {
        const locked = authenticated.retryAfterMs!;
        recordSignIn(signInActor(name), "sign-in refused", "locked");
        response.setHeader("Retry-After", String(Math.ceil(locked / 1000)));
        return page(response, 429, loginWith(store, `Too many wrong passwords. Try again in ${minutesWords(locked)}.`, returnTo));
      }
      signInBudget.failed(source, at);
      recordSignIn(signInActor(name), "sign-in refused", "wrong password");
      return page(response, 403, loginWith(store, "wrong username or password", returnTo, ssoOffer()));
    }
    if (!passwordAllowed(name as string)) {
      recordSignIn(name as string, "sign-in refused", "provider only");
      return page(response, 403, loginWith(store, `Sign in with ${ssoSettings()?.label ?? "your identity provider"}.`, returnTo, ssoOffer()));
    }
    recordSignIn(name as string, "signed in", "browser");
    const id = randomBytes(32).toString("hex");
    const keyed = keyFor(request);
    sessions.set(id, {
      ...arrival(request),
      ...FULL_SESSION,
      ...keyed.fields,
      name: name as string,
      csrf: randomBytes(32).toString("hex"),
      role: authenticated.role,
      generation: authenticated.generation,
      createdAt: Date.now(),
      sawBoardAt: null,
      lastSeen: Date.now(),
      project: runtime.defaultProject,
      projectRevision: 1,
      // A password typed to sign in on this computer starts this session's freshness window (cockpit B2); from anywhere
      // else (a phone, a proxy) it signs in and proves nothing more.
      ...(fromThisComputer(request) ? { passwordAt: Date.now() } : {}),
    });
    return signedInTo(response, keyed.key, returnTo, [`${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${cookieSecure}`]);
  }

  async function logout(ctx: EdgeContext): Promise<void> {
    const { request, response } = ctx;
    const cookies = request.headers.cookie ?? "";
    const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{64})`).exec(cookies);
    if (match !== null) {
      const leaving = sessions.get(match[1] as string);
      if (leaving !== undefined) recordSignIn(leaving.name, "signed out", "browser");
      sessions.delete(match[1] as string);
    }
    response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieSecure}`);
    return redirect(response, "/login");
  }

  // THE JOIN ROAD (v29, D6/E3): a single-use invite is the only door
  // that creates an account from the outside. Cookie-free, script-free,
  // and every dead token shape — unknown, expired, revoked, consumed,
  // attempts spent — answers with ONE indistinguishable page. GET spends
  // nothing; a POST spends one metered attempt BEFORE the KDF runs.
  async function joinPage(ctx: EdgeContext): Promise<void> {
    const { url, response } = ctx;
    const joinToken = joinCodeOf(url);
    const terms = liveInviteTerms(store, joinToken, clock());
    return page(response, 200, terms !== null ? joinFormPage(joinToken, null, "", terms) : joinDeadPage());
  }

  async function joinSend(ctx: EdgeContext): Promise<void> {
    const { url, request, response } = ctx;
    const joinToken = joinCodeOf(url);
    // EXACT media type (Codex people round 2, finding 5): parameters may
    // follow a semicolon; a merely prefix-shaped type is not a form.
    const media = String(request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (media !== "application/x-www-form-urlencoded") {
      return respond(response, 415, "text/plain; charset=utf-8", "forms only");
    }
    let body: FormView<FormFieldOf<"join">>;
    try {
      body = readForm(await form(request), CONSOLE_FORMS.join);
    } catch {
      return respond(response, 413, "text/plain; charset=utf-8", "body too large");
    }
    for (const field of ["name", "password"] as const) {
      if (body.getAll(field).length > 1) {
        return respond(response, 400, "text/plain; charset=utf-8", `duplicated ${field} field`);
      }
    }
    if (!takeJoinAttempt(joinSourceOf(request))) {
      return respond(response, 429, "text/plain; charset=utf-8", "too many sign-up attempts right now — try again in a few minutes");
    }
    const admitted = store.admitInviteAttempt(joinToken, clock());
    if (admitted === null) return page(response, 200, joinDeadPage());
    const name = (body.get("name") ?? "").trim();
    const password = body.get("password") ?? "";
    // Possession of a LIVE token earns real words (D6's disclosure
    // ruling) — the attempt is already spent either way (E3).
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) {
      return page(response, 400, joinFormPage(joinToken, { field: "name", text: "Use 1\u201340 letters, digits, dots, dashes or underscores, starting with a letter or digit." }, name, liveInviteTerms(store, joinToken, clock())));
    }
    if (password.length < 8) {
      return page(response, 400, joinFormPage(joinToken, { field: "password", text: "The password needs at least 8 characters." }, name, liveInviteTerms(store, joinToken, clock())));
    }
    const made = store.consumeInviteAndCreateAccount({ tokenValue: joinToken, name, credentialHash: hashPassword(password) }, clock());
    if (!made.ok) {
      if (made.reason === "name-taken") {
        return page(response, 400, joinFormPage(joinToken, { field: "name", text: "That name is taken. Choose another." }, name, liveInviteTerms(store, joinToken, clock())));
      }
      return page(response, 200, joinDeadPage());
    }
    // The cookie mints only AFTER the commit — same shape as login.
    const id = randomBytes(32).toString("hex");
    const keyed = keyFor(request);
    sessions.set(id, {
      ...arrival(request),
      ...FULL_SESSION,
      ...keyed.fields,
      name,
      csrf: randomBytes(32).toString("hex"),
      role: made.role,
      generation: 1,
      createdAt: Date.now(),
      sawBoardAt: null,
      lastSeen: Date.now(),
      project: runtime.defaultProject,
      projectRevision: 1,
    });
    return signedInTo(response, keyed.key, "/", [`${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${cookieSecure}`]);
  }

  /** The invite code in /join/:code (the route's pattern has already proven its shape). */
  function joinCodeOf(url: URL): string {
    return url.pathname.slice("/join/".length);
  }

  function takeJoinAttempt(source: string): boolean {
    const at = Date.now();
    const globalRefill = Math.floor((at - runtime.joinGlobal.refilledAt) / 20_000);
    if (globalRefill > 0) runtime.joinGlobal = { tokens: Math.min(30, runtime.joinGlobal.tokens + globalRefill), refilledAt: at };
    if (joinBySource.size > 1000) {
      const oldest = joinBySource.keys().next().value;
      if (oldest !== undefined) joinBySource.delete(oldest);
    }
    const bucket = joinBySource.get(source) ?? { tokens: 10, refilledAt: at };
    const refill = Math.floor((at - bucket.refilledAt) / 60_000);
    const tokens = refill > 0 ? Math.min(10, bucket.tokens + refill) : bucket.tokens;
    if (tokens <= 0 || runtime.joinGlobal.tokens <= 0) {
      joinBySource.set(source, { tokens, refilledAt: refill > 0 ? at : bucket.refilledAt });
      return false;
    }
    runtime.joinGlobal.tokens -= 1;
    joinBySource.set(source, { tokens: tokens - 1, refilledAt: refill > 0 ? at : bucket.refilledAt });
    return true;
  }

  /**
   * Back from a service's sign-in: the code becomes the tool's tokens,
   * kept in its secrets file, and a page sends the person back to Tools (or
   * to the kit the Connect came from, whose subagent may then use the tool).
   */
  /** v100: back from the identity provider. Proves the person, then hands them to /login/sso/finish on this site. */
  async function ssoCallback(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const back = (words: string) => page(response, 400, loginWith(store, words, "/", ssoOffer()));
    const state = url.searchParams.get("state") ?? "";
    if (!startedHere(request, state)) return back("That sign-in was started in another browser. Sign in again from this one.");
    const held = ssoVisits.get(state);
    ssoVisits.delete(state);
    const settings = ssoSettings();
    if (held === undefined || held.expires < Date.now() || settings === null) return back("That sign-in expired. Try again.");
    if (url.searchParams.has("error")) return back(url.searchParams.get("error") === "access_denied" ? `${settings.label} didn't let you in.` : `${settings.label} didn't finish the sign-in.`);
    const code = url.searchParams.get("code") ?? "";
    if (!/^[\x21-\x7e]{4,4096}$/.test(code)) return back(`${settings.label} didn't send a sign-in code.`);
    const fetcher = options.ssoFetch ?? fetch;
    const token = await exchangeOidcCode(held.provider, settings, code, held.visit, held.redirect, fetcher);
    if (!token.ok) return back(token.said);
    if (!adapterPolicy({ caller: "service", capability: "none" }).ok) return page(response, 403, loginWith(store, "This sign-in is not allowed."));
    const verified = await verifyIdToken(token.idToken, held.provider, settings, held.visit.nonce, clock(), fetcher);
    if (!verified.ok) { logEvent("warn", "sso.refused", { reason: verified.said }); return back(verified.said); }
    // When the provider checked the person (its auth_time), proved against this visit (cockpit B2, N18): no earlier than
    // this visit began, and not in the future beyond a minute of clock skew. A step-up must carry one that holds — a
    // check made for this request, never a remembered one; any other sign-in without one signs in, but is never fresh.
    const checkedAt = sameVisitCheck(verified.claims.authTime, held.startedAt, Date.now());
    if (held.intent === "reauth" && checkedAt === null) return back(`${settings.label} didn't check you again. Try once more.`);
    const key = randomBytes(24).toString("base64url");
    for (const [one, value] of ssoHandoffs) if (value.expires < Date.now()) ssoHandoffs.delete(one);
    while (ssoHandoffs.size >= 1000) ssoHandoffs.delete(ssoHandoffs.keys().next().value!);
    ssoHandoffs.set(key, { claims: verified.claims, issuer: held.provider.issuer, intent: held.intent, returnTo: held.returnTo, expires: Date.now() + 60_000, checkedAt, session: held.session });
    const to = `/login/sso/finish?h=${key}`;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
      // The hand-off key is this browser's alone, like the visit's state: its cookie rides to /login/sso/finish.
      "set-cookie": [signInSpent(SSO_CALLBACK), `${SIGN_IN_COOKIE}=${key}; Path=/login/sso/finish; Max-Age=60; HttpOnly; SameSite=Lax${held.redirect.startsWith("https:") ? "; Secure" : ""}`],
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" });
    response.end(htmlString(html`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${to}"><title>Toolroll</title>${HANDOFF_STYLE}<p>Signing you in… <a href="${to}">Continue</a></p>`));
  }

  function readAccessForm(body: FormView<"access" | "projects">): { ok: true; projects: string[] | null } | { ok: false; message: string } {
    if (body.getAll("access").length > 1) return { ok: false, message: "Choose one access setting." };
    const mode = body.get("access");
    // Older clients omitted this field and explicitly used instance roles.
    if ((mode === null && body.getAll("projects").length === 0) || mode === "all") return { ok: true, projects: null };
    if (mode !== "selected") return { ok: false, message: "Choose selected projects or all projects." };
    const allowed = new Set([...managedRepos(), ...store.knownRepos()].filter(visible));
    const projects = [...new Set(body.getAll("projects"))];
    if (projects.length > 100 || projects.some(repo => !allowed.has(repo))) return { ok: false, message: "Choose projects available on this instance." };
    return { ok: true, projects };
  }
  /** Easy-start C2: a session's key fields when it is made: on a protected loopback install, a fresh key (only its hash
   * and this start's epoch kept) to deliver once; else none. */
  function keyFor(request: IncomingMessage): { fields: { keyEpoch: string | null; keyHash: string | null }; key: string | null } {
    const fields: { keyEpoch: string | null; keyHash: string | null } = { keyEpoch: null, keyHash: null };
    const key = browserKeys.issue(fields, request);
    return { fields, key };
  }
  /** A sign-in's answer: its cookies, then on to `to` — through the key's one delivery when there is a key. */
  function signedInTo(response: ServerResponse, key: string | null, to: string, cookies: readonly string[]): void {
    if (key !== null) return browserKeys.deliver(response, key, to, cookies);
    response.setHeader("Set-Cookie", cookies.length === 1 ? cookies[0]! : [...cookies]);
    return redirect(response, to);
  }

  // Easy-start C2: Reconnect. A browser session keeps reading after a restart, but its mutation key was bound to the
  // console start that issued it. A full session gets a fresh key here by typing its password again (a cookie alone
  // never does: a cookie holder on another port has the cookie); a local owner, by running `toolroll open`.
  async function rekeyPage(ctx: EdgeContext): Promise<void> {
    const { url, who, response } = ctx;
    const returnTo = loginReturn(url.searchParams.get("return"));
    if (who?.via !== "cookie") return redirect(response, loginHref(returnTo));
    if (!browserKeys.required()) return redirect(response, returnTo);
    return page(response, 200, reconnectPage(null, returnTo, howToReconnect(who)));
  }

  function howToReconnect(who: Extract<NonNullable<EdgeContext["who"]>, { via: "cookie" }>): Parameters<typeof reconnectPage>[2] {
    if (who.authority !== "full") return { kind: "command" };
    if (!passwordAllowed(who.name)) return { kind: "sso", label: ssoSettings()?.label ?? "your identity provider" };
    return { kind: "password", name: who.name };
  }

  async function rekeySend(ctx: EdgeContext): Promise<void> {
    const { who, request, response } = ctx;
    const body = readForm(await form(request), CONSOLE_FORMS.rekey);
    const returnTo = loginReturn(body.get("return"));
    if (who?.via !== "cookie") return redirect(response, loginHref(returnTo));
    if (!browserKeys.required()) return redirect(response, returnTo);
    // Only this console's own page: a present Origin must name it (the password below is the proof either way).
    const origin = request.headers.origin;
    if (typeof origin === "string" && origin !== "null" && origin !== `http://${browserKeys.canonicalHost()}`) {
      return page(response, 403, reconnectPage("Reconnect from Toolroll's own page.", returnTo, howToReconnect(who)));
    }
    const how = howToReconnect(who);
    if (how.kind !== "password") return page(response, 403, reconnectPage(null, returnTo, how));
    const source = joinSourceOf(request), at = Date.now();
    const wait = signInBudget.waitFor(source, at);
    if (wait > 0) {
      recordSignIn(who.name, "sign-in refused", "too many tries", "reconnect");
      response.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
      return page(response, 429, reconnectPage(`Too many tries. Try again in ${minutesWords(wait)}.`, returnTo, how));
    }
    // Only a password typed now: never a session, Passwordless or a remembered password (an empty one simply fails).
    const proved = authenticateAccount(store, who.name, body.get("token") ?? "");
    if (!proved.ok) {
      if (proved.reason === "locked") {
        recordSignIn(who.name, "sign-in refused", "locked", "reconnect");
        response.setHeader("Retry-After", String(Math.ceil(proved.retryAfterMs! / 1000)));
        return page(response, 429, reconnectPage(`Too many wrong passwords. Try again in ${minutesWords(proved.retryAfterMs!)}.`, returnTo, how));
      }
      signInBudget.failed(source, at);
      recordSignIn(who.name, "sign-in refused", "wrong password", "reconnect");
      return page(response, 403, reconnectPage("That password isn't right.", returnTo, how));
    }
    // The same person under the same credential generation and standing this session signed in with; anything else
    // signs in again instead.
    if (proved.generation !== who.session.generation || proved.role !== who.session.role) return redirect(response, loginHref(returnTo));
    const key = browserKeys.issue(who.session, request);
    if (key === null) return page(response, 421, reconnectPage(`Open Toolroll at http://${browserKeys.canonicalHost()} to reconnect.`, returnTo, how));
    sessions.persist(who.session);
    recordSignIn(who.name, "reconnected", "browser");
    return browserKeys.deliver(response, key, returnTo);
  }

  // Easy-start C4: /password/set, the one credential act a local owner's session may make: its first password, only
  // while the account has none. The answer is a fresh full session (and a fresh browser key), and on to the act that
  // was refused. Every other session, and an account that has a password, is told to sign in with it.
  /** A /password/set page: no-store, and on a protected loopback install the key fill rides it (its form posts the key). */
  function passwordSetAnswer(response: ServerResponse, status: number, document: Html): void {
    response.setHeader("Cache-Control", "no-store");
    if (!browserKeys.required()) return page(response, status, document);
    const nonce = randomBytes(16).toString("base64");
    return page(response, status, replaceMarkup(document, /<\/body><\/html>$/, () => html`${scriptElement(KEY_FILL_SCRIPT, { nonce })}</body></html>`), nonce);
  }

  async function passwordSetForm(ctx: EdgeContext): Promise<void> {
    const { url, who, response } = ctx;
    // Where to go once it is set: `next` (a refusal's link), or `return` (older links), checked either way.
    const returnTo = passwordSetNext(url.searchParams.get("next") ?? url.searchParams.get("return"));
    if (who === null || who === undefined) return redirect(response, loginHref(returnTo));
    if (who.via !== "cookie") return respond(response, 403, "text/plain; charset=utf-8", "This address needs a browser sign-in.");
    if (who.authority === "full" || store.accountOf(who.name)?.passwordSet !== false) return passwordSetAnswer(response, 200, passwordAlreadySetPage("A password is already set", returnTo, who.authority === "full"));
    return passwordSetAnswer(response, 200, withFormToken(who.session.csrf, () => passwordSetPage({ returnTo, problem: null })));
  }

  async function passwordSetSend(ctx: EdgeContext): Promise<void> {
    const { who, request, response } = ctx;
    const media = String(request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (media !== "application/x-www-form-urlencoded") { request.resume(); return respond(response, 415, "text/plain; charset=utf-8", "forms only"); }
    const body = readForm(await form(request), CONSOLE_FORMS.passwordSet);
    const returnTo = passwordSetNext(body.get("next") ?? body.get("return"));
    if (who === null || who === undefined) return redirect(response, loginHref(returnTo));
    if (who.via !== "cookie") return respond(response, 403, "text/plain; charset=utf-8", "This address needs a browser sign-in.");
    for (const field of ["csrf", "password", "again", "next", "return"] as const) {
      if (body.getAll(field).length > 1) return respond(response, 400, "text/plain; charset=utf-8", `duplicated ${field} field`);
    }
    const account = store.accountOf(who.name);
    // A full session, or an account that has a password: only signing in with it.
    if (who.authority === "full" || account === null || account.passwordSet) return passwordSetAnswer(response, 409, passwordAlreadySetPage("A password is already set", returnTo, who.authority === "full"));
    const again = (problem: PasswordSetProblem, status: number) => passwordSetAnswer(response, status, withFormToken(who.session.csrf, () => passwordSetPage({ returnTo, problem })));
    // The console's own page only: a present Origin (or Referer) must name it; the session's CSRF token and (on a protected
    // loopback install) its browser key are proved as for every other mutation.
    const origin = request.headers.origin, referer = request.headers.referer;
    const named = typeof origin === "string" && origin !== "null" ? origin : typeof referer === "string" ? referer : null;
    if (named !== null && !runtime.allowedHost(named.replace(/^https?:\/\//, "").split("/")[0])) return again({ field: null, text: "Set your password from Toolroll's own page." }, 403);
    if (body.get("csrf") !== who.session.csrf) return again({ field: null, text: "This form had expired, so it was reloaded. Enter the password again." }, 403);
    const keyed = browserKeys.check(who, request, body.sent);
    if (keyed !== null) return again({ field: null, text: keyed.message }, keyed.status);
    if (account.revokedAt !== null || account.generation !== who.session.generation || !sessions.savedNow(who.session) || who.session.localGeneration === null) {
      return again({ field: null, text: LOCAL_OWNER_LAPSED }, 409);
    }
    // Rate-limited like signing in: the same per-address budget, and each refused try spends from it.
    const source = joinSourceOf(request), at = Date.now();
    const wait = signInBudget.waitFor(source, at);
    if (wait > 0) {
      response.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
      return again({ field: null, text: `Too many tries. Try again in ${minutesWords(wait)}.` }, 429);
    }
    const password = body.get("password") ?? "";
    // The strength rule sign-up and joining use.
    if (password.length < SIGNUP_PASSWORD_MIN) { signInBudget.failed(source, at); return again({ field: "password", text: `Use at least ${SIGNUP_PASSWORD_MIN} characters.` }, 400); }
    if ((body.get("again") ?? "") !== password) { signInBudget.failed(source, at); return again({ field: "again", text: "The two passwords don't match. Type them again." }, 400); }
    // Hashed before the transaction (scrypt is slow); enrollOwnerPassword then checks and writes in one IMMEDIATE
    // transaction: still no password, local mode on at this session's generation, the account its active owner. It ends
    // every session the account had (this one included).
    const enrolled = enrollOwnerPassword(store, who.name, hashPassword(password), who.session.localGeneration, clock());
    if (!enrolled.ok) {
      if (enrolled.reason === "already-set") return passwordSetAnswer(response, 409, passwordAlreadySetPage("A password was just set", returnTo));
      return again({ field: null, text: LOCAL_OWNER_LAPSED }, 409);
    }
    const cookieId = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{64})`).exec(request.headers.cookie ?? "")?.[1];
    if (cookieId !== undefined) sessions.delete(cookieId);
    recordSignIn(who.name, "signed in", "browser", "first password set");
    // A fresh full session, made only after the commit, with a fresh key delivered once (no-store) on a protected install.
    const id = randomBytes(32).toString("hex");
    const issued = keyFor(request);
    sessions.set(id, {
      ...arrival(request),
      ...FULL_SESSION,
      ...issued.fields,
      name: who.name,
      csrf: randomBytes(32).toString("hex"),
      role: account.role,
      generation: enrolled.generation,
      createdAt: Date.now(),
      sawBoardAt: null,
      lastSeen: Date.now(),
      project: who.session.project ?? runtime.defaultProject,
      projectRevision: 1,
      // A password typed on this computer starts this session's freshness window (cockpit B2), as signing in does.
      ...(fromThisComputer(request) ? { passwordAt: Date.now() } : {}),
    });
    return signedInTo(response, issued.key, returnTo, [`${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${cookieSecure}`]);
  }

  const registrations = handlersOf("people", {
    "people.page": peoplePage,
    "settings.sessions": sessionsPage,
    "settings.sessions-send": sessionsSend,
    "people.projects": peopleProjects,
    "people.invite": peopleInvite,
    "people.invite-revoke": peopleInviteRevoke,
    "people.revoke": peopleRevoke,
  }, {
    "edge.login-page": signInPage,
    "edge.login-link": signInLink,
    "edge.sso-start": ssoStart,
    "edge.sso-callback": ssoReturn,
    "edge.sso-finish": ssoFinish,
    "edge.signup": signupSend,
    "edge.login": loginSend,
    "edge.logout": logout,
    "edge.rekey-page": rekeyPage,
    "edge.rekey": rekeySend,
    "edge.join": joinPage,
    "edge.join-send": joinSend,
    "edge.password-set-page": passwordSetForm,
    "edge.password-set": passwordSetSend,
  });
  return { registrations, takeJoinAttempt, ssoCallback, readAccessForm };
}

/** The sign-in page, with its footer saying how to get in by install kind (login-help.ts), read at each render. (At the
 * end of the module: the password tripwire pins the handlers' places.) */
function loginWith(store: Store, problem: HtmlValue | null, returnTo = "/", sso: { label: string; operatorsOnly: boolean } | null = null): Html {
  return loginPage(problem, returnTo, sso, loginHelpOf(store));
}
