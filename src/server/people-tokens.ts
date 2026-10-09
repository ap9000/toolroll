import { handlersOf } from './handler-registry.js';
import { adapterPolicy } from "./route-policy.js";
/** settings handlers, moved without changing their route bodies. */
import { mintApiToken,TOKEN_DAYS } from "../api-tokens.js";
import { CONSOLE_FORMS,readForm } from "../contracts/console-api.js";
import { html, htmlString, joinHtml, postForm } from "../html.js";
import { credentialsHtml,tokenShownHtml } from "../credentials-ui.js";
import {
projectName
} from "../project.js";
import { requestLimitsHtml,tokenLimitWords } from "../request-budget-ui.js";
import { authenticateAccount } from "../scope.js";
import { SSO_CALLBACK } from "../sso-settings.js";
import type { EdgeContext,HandlerContext } from './handler-context.js';
import type { ServerRuntime } from './runtime.js';
import { requestContext } from "./request-context.js";
import { personChip,refuse,screen } from "./chrome.js";
import { redirect,respond } from "./http.js";
/** people handlers, moved without changing their route bodies. */
import { randomBytes,timingSafeEqual } from "node:crypto";
import { type IncomingMessage,type ServerResponse } from "node:http";
import { type FormFieldOf,type FormView } from "../contracts/console-api.js";
import { listCoordinators } from "../coordinator.js";
import { logEvent } from "../log.js";
import { accessFromGroups,accountNameFor,exchangeOidcCode,newOidcVisit,oidcAuthorizeUrl,verifyIdToken } from "../oidc.js";
import { personAuditHtml,personHref } from "../people-audit-ui.js";
import { cursorOf as auditCursorOf,remoteAudit } from "../remote-audit.js";
import { hashPassword } from "../scope.js";
import { form,HANDOFF_STYLE,loginHref,loginReturn,page,SIGN_IN_COOKIE,signInSpent,startedHere } from "./http.js";
import { joinDeadPage,joinFormPage,loginPage,signupPage } from "./render-people.js";
import { SESSION_COOKIE,SIGN_IN_LINK_PATH,type SsoIntent } from "./session.js";
export function createPeopleHandlers(runtime: ServerRuntime) {
  const { settingsUpdates, joinBySource, ssoOffer, ssoVisits, ssoSettings, options, clock, ssoHandoffs, managedRepos, store, visible, admissionList, sendScreen, chromeFor, restricted, sessions, consoleProjects, authenticateApprover, bustBadge, projectOf, signInLinks, linkKey, fromThisComputer, recordSignIn, passwordAllowed, arrival, defaultProject, cookieSecure, consoleOrigin, providerFor, joinSourceOf, signInBudget, signInActor, minutesWords } = runtime;

  // v101: Settings → Sessions & tokens: where you're signed in, and your API tokens. An instance operator can see everyone's.
  async function sessionsPage(ctx: HandlerContext): Promise<void> {
    const { url, who, response, project } = ctx;
    if (who.via !== "cookie") return refuse(response, who, 403, "Sign in in a browser to see your sessions.", "/settings");
    const everyone = url.searchParams.get("everyone") === "1" && store.isInstanceOperator(who.name);
    const here = sessions.hashOf(who.session);
    const view = { who: who.name, everyone, canSeeEveryone: store.isInstanceOperator(who.name), now: Date.now(),
      sessions: store.webSessions(everyone ? null : who.name).map(one => ({ ...one, here: one.idHash === here })), tokens: store.apiTokens(everyone ? null : who.name),
      limits: { note: tokenLimitWords.bind(null, store.handle), section: store.isInstanceOperator(who.name) ? requestLimitsHtml(store.handle, store.apiTokens(null), Date.now()) : html`` } };
    return sendScreen(response, 200, screen("Sessions & tokens", html`<p><a href="/settings">Settings</a></p><h1>Sessions &amp; tokens</h1>${credentialsHtml(view, { said: url.searchParams.get("said"), problem: url.searchParams.get("problem") })}`,
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
      return sendScreen(response, 200, screen("people", html`<h1>Your access</h1><p>${personChip(who.name)} · ${who.role === "approver" ? "operator" : "viewer"}</p><p>${who.role === "approver" ? "You can create, manage, and approve work in these projects." : "You can read work in these projects."}</p><ul>${projects.map(repo => html`<li>${projectName(repo)}</li>`)}</ul><p class="meta">An instance operator manages invitations and project access.</p><p><a href="${personHref(who.name)}">Your remote activity</a></p>`, { chrome: chromeFor(project, "people") }));
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
    const accessFields = (selected: readonly string[] | null) =>
      html`<label>Project access<select name="access"><option value="selected"${selected !== null ? " selected" : ""}>Selected projects</option><option value="all"${selected === null ? " selected" : ""}>All projects</option></select></label>\
<p class="meta">Operators with all-project access also manage the instance.</p><fieldset><legend>Projects</legend>${projectChoices.length === 0 ? html`<p class="meta">Add a project before granting selected access.</p>` : projectChoices.map(repo => html`<label class="row"><input type="checkbox" name="projects" value="${repo}"${selected?.includes(repo) ? " checked" : ""}>${projectName(repo)}</label>`)}</fieldset>`;
    const cards = accounts.map(one => {
      const seen = lastSeenOf(one.name);
      const acts = store.recentActsOf(one.name);
      const standing =
        one.revokedAt !== null
          ? html`revoked ${one.revokedAt.slice(0, 16).replace("T", " ")} by ${personChip(one.revokedBy ?? "?")}`
          : one.role === "approver"
            ? "approves"
            : "watches";
      return joinHtml([
        html`<div class="card">`,
        html`<h2 style="margin-top:0">${personChip(one.name)} <span class="meta">${standing}</span></h2>`,
        html`<p class="meta">${one.projects === null ? "All projects" : one.projects.length === 0 ? "No project access" : one.projects.map(repo => projectName(repo)).join(", ")}</p>`,
        approverView && one.revokedAt === null ? html`<details><summary>Edit project access</summary>${postForm("/people/projects", html`${accessFields(one.projects)}<label>Your password<input type="password" name="token" autocomplete="current-password" required></label><p class="meta">Changing access signs this person out and ends their derived sessions and modes. Previously approved work stays recorded.</p><button type="submit">Save project access</button>`, { hidden: { name: one.name } })}</details>` : "",
        html`<p class="meta">${seen === null ? "not signed in right now" : `signed in \u2014 active ${new Date(seen).toISOString().slice(11, 16)} UTC`} \u00b7 joined ${one.addedAt.slice(0, 10)}</p>`,
        html`<p><a href="${personHref(one.name)}">Tokens and remote activity</a></p>`,
        acts.length === 0
          ? html`<p class="meta">No recorded acts yet</p>`
          : joinHtml(acts.map(act => html`<p class="row meta">${act.kind} ${act.subject} \u00b7 ${act.at.slice(0, 16).replace("T", " ")}</p>`), "\n"),
        approverView && one.revokedAt === null && one.name !== who.name
          ? postForm("/people/revoke", html`\
<label>Your password<input type="password" name="token" autocomplete="current-password"></label>\
<button type="submit">Remove ${one.name}'s sign-in</button>\
<span class="meta">ends their access and everything it signed \u2014 history stays</span>`, { attrs: { class: "row" }, hidden: { name: one.name } })
          : "",
        html`</div>`,
      ], "\n");
    });
    const invites = approverView ? store.openInvites(now) : [];
    const inviteRows = invites.map(one =>
      html`<p class="row">${one.role} invite · ${one.projects === null ? "all projects" : one.projects.map(repo => projectName(repo)).join(", ")} \u00b7 from ${personChip(one.mintedBy)} \u00b7 expires ${one.expiresAt.slice(0, 16).replace("T", " ")}${one.attempts > 0 ? ` \u00b7 ${one.attempts} failed attempt${one.attempts === 1 ? "" : "s"}` : ""}\
 ${postForm("/people/invite-revoke", html`\
<label>Password <input type="password" name="token" autocomplete="current-password" style="width:8rem"></label>\
<button type="submit">Cancel it</button>`, { attrs: { style: "display:inline" }, hidden: { id: one.id } })}</p>`,
    );
    const inviteCard = !approverView
      ? ""
      : joinHtml([
          html`<div class="card">`,
          html`<h2 style="margin-top:0">Invite someone</h2>`,
          inviteRows.length === 0 ? html`<p class="meta">No open invites</p>` : joinHtml(inviteRows, "\n"),
          postForm("/people/invite", joinHtml([
            "",
            html`<label>They can<select name="role"><option value="viewer">Viewer — read work</option><option value="approver">Operator — create, manage and approve work</option></select></label>`,
            accessFields(project === null ? [] : [project]),
            html`<label>Your password<input type="password" name="token" autocomplete="current-password"></label>`,
            html`<button type="submit">Make an invite link</button>`,
            html`<span class="meta">single-use, expires in 72 hours</span>`,
          ], "\n"), { attrs: { class: "row" } }),
          html`</div>`,
        ], "\n");
    // Coordinators (MCP spec v6): the machine principals beside the
    // human ones — name, immutable fingerprint, what they may file
    // into, their rate, and the revoke road. Approver eyes only.
    const coordinatorCard = !approverView
      ? ""
      : (() => {
          const rows = listCoordinators(store);
          if (rows.length === 0) return "";
          return joinHtml([
            html`<div class="card">`,
            html`<h2 style="margin-top:0">Agent filers</h2>`,
            html`<p class="meta">Agents that can propose tasks. You approve what runs.</p>`,
            ...rows.map(one =>
              html`<p class="row"><span class="mono">${`${one.name}#${one.cid.slice(0, 4)}`}</span> ${one.revokedAt !== null
                ? html`<span class="meta">revoked ${one.revokedAt.slice(0, 10)}</span>`
                : html`<span class="meta">${one.perHour}/hour · files into ${one.repos.join(", ")} · ${one.expiresAt === null ? "no expiry (made before expiry)" : `expires ${one.expiresAt.slice(0, 10)}`} · last filed ${one.lastFiledAt === null ? "never" : one.lastFiledAt.slice(0, 16).replace("T", " ")}</span>`}</p>`,
            ),
            html`<details class="settings-more"><summary>Revoke an agent filer</summary><p class="meta">Run <code>toolroll coordinator revoke &lt;cid&gt; --as you</code> on this computer.</p></details>`,
            html`</div>`,
          ], "\n");
        })();
    return sendScreen(
      response,
      200,
      screen("people", joinHtml([html`<h1>People</h1>`, ...cards, coordinatorCard, inviteCard], "\n"), {
        chrome: chromeFor(project, "people"),
      }),
    );
  }

  async function sessionsSend(ctx: HandlerContext): Promise<void> {
    const { who, request, response, now, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.sessions);
    if (who.via !== "cookie") return refuse(response, who, 403, "Sign in in a browser to manage sessions and tokens.", "/settings");
    const operator = store.isInstanceOperator(who.name);
    const back = (key: "said" | "problem", words: string) => redirect(response, `/settings/sessions?${body.get("everyone") === "1" && operator ? "everyone=1&" : ""}${key}=${encodeURIComponent(words)}`);
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
      // A token is a credential: made with the person's password (or their identity provider's check from moments ago), counted once.
      const typed = body.get("password") ?? "";
      const confirmed = who.role === "approver" ? authenticateApprover(who, typed).ok
        : typed === "" ? requestContext.getStore()?.sso?.fresh === true : authenticateAccount(store, who.name, typed).ok;
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
    if (!authenticateApprover(who, body.get("token") ?? "", null).ok) return refuse(response, who, 403, "Saving access requires your password.", "/people");
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
    if (!authenticateApprover(who, token).ok) {
      return refuse(response, who, 403, "making an invite takes your password, typed again", "/people");
    }
    const role = body.get("role") === "approver" ? ("approver" as const) : ("viewer" as const);
    const access = readAccessForm(body);
    if (!access.ok) return refuse(response, who, 400, access.message, "/people");
    if (access.projects !== null && access.projects.length === 0) return refuse(response, who, 400, "Select at least one project for this invitation.", "/people");
    const minted = store.mintInvite(role, who.name, now, undefined, access.projects);
    const origin = options.publicUrl !== undefined ? options.publicUrl.replace(/\/$/, "") : `http://${request.headers.host ?? "this-console"}`;
    const linkScreen = screen(
      "people",
      joinHtml([
        html`<h1>Invite link</h1>`,
        html`<div class="card">`,
        html`<p>Shown once, so copy it now.</p>`,
        html`<p class="mono secret-value">${`${origin}/join/${minted.token}`}</p>`,
        html`<p class="meta">Send it to one person. It works once, lets them ${role === "approver" ? "approve and act" : "read work"} in ${access.projects === null ? "all projects" : access.projects.map(repo => projectName(repo)).join(", ")}, and expires ${minted.expiresAt.slice(0, 16).replace("T", " ")} UTC. Cancel it any time on People.</p>`,
        html`</div>`,
        html`<p class="meta"><a href="/people">Back to People</a></p>`,
      ], "\n"),
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
      return page(response, 200, signupPage(null, runtime.setupAttemptsLeft));
    }
    return page(response, 200, loginPage(null, loginReturn(url.searchParams.get("return")), ssoOffer()));
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
      return page(response, 403, loginPage("That sign-in link works only in a browser on the computer running Toolroll. Sign in with your password.", "/chat", ssoOffer()));
    }
    if (held === undefined || held.expires < Date.now()) {
      return page(response, 410, loginPage("That sign-in link has been used or has expired. Sign in with your password, or run toolroll up again.", "/chat", ssoOffer()));
    }
    const account = store.accountOf(held.account);
    if (account === null || account.role !== "approver" || account.revokedAt !== null) return page(response, 403, loginPage("That account can't sign in here any more.", "/chat", ssoOffer()));
    if (!passwordAllowed(held.account)) return page(response, 403, loginPage(`Sign in with ${ssoSettings()?.label ?? "your identity provider"}.`, "/chat", ssoOffer()));
    const id = randomBytes(32).toString("hex");
    sessions.set(id, { ...arrival(request), name: held.account, csrf: randomBytes(32).toString("hex"), role: account.role, generation: account.generation, createdAt: Date.now(), sawBoardAt: null, lastSeen: Date.now(),
      project: defaultProject, projectRevision: 1 });
    recordSignIn(held.account, "signed in", "one-time link");
    response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${cookieSecure}`);
    return redirect(response, "/chat");
  }

  // v100: sign-in with the identity provider. ?reauth=1 asks it to check the person again (a step-up);
  // ?link=1 links the signed-in account to it. The browser that starts it holds the visit's state.
  async function ssoStart(ctx: EdgeContext): Promise<void> {
    const { url, who, request, response } = ctx;
    const settings = ssoSettings();
    const intent: SsoIntent = url.searchParams.get("link") === "1" ? "link" : url.searchParams.get("reauth") === "1" ? "reauth" : "sign-in";
    const returnTo = loginReturn(url.searchParams.get("return"));
    if (settings === null) return page(response, 404, loginPage("Sign-in with an identity provider isn't on.", returnTo));
    if (intent !== "sign-in" && who?.via !== "cookie") return redirect(response, loginHref(returnTo));
    const origin = consoleOrigin(request.headers.host);
    if (origin === null) return page(response, 400, loginPage("Sign in from this computer (localhost) or from your https address.", returnTo, ssoOffer()));
    const found = await providerFor(settings.issuer);
    if (!found.ok) return page(response, 502, loginPage(`${settings.label} isn't answering: ${found.said}`, returnTo, ssoOffer()));
    const visit = newOidcVisit(), redirectUri = `${origin}${SSO_CALLBACK}`;
    for (const [key, one] of ssoVisits) if (one.expires < Date.now()) ssoVisits.delete(key);
    // Bounded: anyone may start a sign-in, so the oldest waiting ones give way.
    while (ssoVisits.size >= 1000) ssoVisits.delete(ssoVisits.keys().next().value!);
    ssoVisits.set(visit.state, { visit, provider: found.provider, redirect: redirectUri, intent, returnTo, expires: Date.now() + 15 * 60_000 });
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
    if (!startedHere(request, key)) return page(response, 400, loginPage("That sign-in was started in another browser. Sign in again from this one.", "/", ssoOffer()));
    const handoff = ssoHandoffs.get(key);
    ssoHandoffs.delete(key);
    response.setHeader("Set-Cookie", signInSpent("/login/sso/finish"));
    const settings = ssoSettings();
    if (handoff === undefined || handoff.expires < Date.now() || settings === null) return page(response, 400, loginPage("That sign-in expired. Try again.", "/", ssoOffer()));
    const { claims } = handoff;
    const identity = { issuer: handoff.issuer, subject: claims.sub, email: claims.email, label: settings.label };
    if (handoff.intent === "link" || handoff.intent === "reauth") {
      if (who?.via !== "cookie") return redirect(response, loginHref(handoff.returnTo));
      if (handoff.intent === "link") {
        const linked = store.linkSsoIdentity(who.name, identity, clock());
        if (!linked.ok) return redirect(response, `/settings/sign-in?problem=${encodeURIComponent(`That ${settings.label} account signs in as someone else here.`)}`);
        who.session.sso = { at: Date.now() };
        sessions.persist(who.session);
        return redirect(response, `/settings/sign-in?said=${encodeURIComponent(`This account signs in with ${settings.label} now.`)}`);
      }
      // A step-up: the provider checked the same person again.
      if (store.ssoAccount(identity.issuer, identity.subject) !== who.name) return page(response, 403, loginPage(`That ${settings.label} account isn't the one signed in here.`, handoff.returnTo, ssoOffer()));
      who.session.sso = { at: Date.now() };
      sessions.persist(who.session);
      recordSignIn(who.name, "confirmed", settings.label);
      return redirect(response, handoff.returnTo);
    }
    const rule = accessFromGroups(claims.groups, settings.rules);
    const signedIn = store.signInWithSso(identity, rule === null ? null : { role: rule.role === "operator" ? "approver" : "viewer", projects: rule.projects === "all" ? null : rule.projects },
      () => accountNameFor(claims, name => store.accountOf(name) !== null), clock());
    if (!signedIn.ok) {
      recordSignIn(store.ssoAccount(identity.issuer, identity.subject) ?? "unknown account", "sign-in refused", signedIn.reason === "no-group" ? "no matching group" : signedIn.reason);
      return page(response, 403, loginPage(signedIn.reason === "no-group" ? `Your ${settings.label} account isn't in a group that may use Toolroll. Ask whoever runs it.`
        : signedIn.reason === "revoked" ? "This account was removed. Ask whoever runs Toolroll." : "That change would leave no one who can run this installation.", "/", ssoOffer()));
    }
    const account = store.accountOf(signedIn.account)!;
    const id = randomBytes(32).toString("hex");
    sessions.set(id, { ...arrival(request), name: signedIn.account, csrf: randomBytes(32).toString("hex"), role: account.role, generation: account.generation, createdAt: Date.now(), sawBoardAt: null, lastSeen: Date.now(),
      project: defaultProject, projectRevision: 1, sso: { at: Date.now() } });
    recordSignIn(signedIn.account, "signed in", settings.label);
    response.setHeader("Set-Cookie", [signInSpent("/login/sso/finish"), `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${cookieSecure}`]);
    return redirect(response, handoff.returnTo);
  }

  async function signupSend(ctx: EdgeContext): Promise<void> {
    const { request, response } = ctx;
    // Only while the table is empty, only with the printed code, only
    // five tries: the bootstrap door underneath is atomic, so two first
    // visitors serialize to one owner.
    if (options.setupCode === undefined || store.listApprovers().length > 0) {
      return page(response, 409, loginPage("an account already exists — sign in"));
    }
    if (runtime.setupAttemptsLeft <= 0) {
      return page(response, 403, signupPage("too many wrong codes — restart the server to get a fresh code", 0));
    }
    const body = readForm(await form(request), CONSOLE_FORMS.signup);
    const code = (body.get("code") ?? "").trim();
    const name = (body.get("name") ?? "").trim();
    const password = body.get("password") ?? "";
    const given = Buffer.from(code.padEnd(64, " "), "utf8");
    const wanted = Buffer.from(options.setupCode.padEnd(64, " "), "utf8");
    if (code === "" || !timingSafeEqual(given, wanted)) {
      runtime.setupAttemptsLeft -= 1;
      return page(response, 403, signupPage("that is not the setup code the server printed", runtime.setupAttemptsLeft));
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      return page(response, 400, signupPage("a username is letters, digits, dots, dashes — up to 64", runtime.setupAttemptsLeft));
    }
    if (password.length < 8) {
      return page(response, 400, signupPage("a password is at least 8 characters", runtime.setupAttemptsLeft));
    }
    const made = store.bootstrapApproverIfNone(name, hashPassword(password), clock());
    if (!made.ok) return page(response, 409, loginPage("an account already exists — sign in"));
    const authenticated = authenticateAccount(store, name, password);
    if (authenticated === null || !authenticated.ok) return page(response, 500, loginPage("the account was created but could not sign in — try again"));
    const id = randomBytes(32).toString("hex");
    sessions.set(id, {
      ...arrival(request),
      name,
      csrf: randomBytes(32).toString("hex"),
      role: authenticated.role,
      generation: authenticated.generation,
      createdAt: Date.now(),
      sawBoardAt: null,
      lastSeen: Date.now(),
      project: defaultProject,
      projectRevision: 1,
    });
    response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${cookieSecure}`);
    return redirect(response, "/");
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
      return page(response, 429, loginPage(`Too many sign-in attempts. Try again in ${minutesWords(wait)}.`, returnTo));
    }
    const authenticated =
      name !== null && token !== null ? authenticateAccount(store, name, token) : null;
    if (authenticated === null || !authenticated.ok) {
      if (authenticated?.reason === "locked") {
        const locked = authenticated.retryAfterMs!;
        recordSignIn(signInActor(name), "sign-in refused", "locked");
        response.setHeader("Retry-After", String(Math.ceil(locked / 1000)));
        return page(response, 429, loginPage(`Too many wrong passwords. Try again in ${minutesWords(locked)}.`, returnTo));
      }
      signInBudget.failed(source, at);
      recordSignIn(signInActor(name), "sign-in refused", "wrong password");
      return page(response, 403, loginPage("wrong username or password", returnTo, ssoOffer()));
    }
    if (!passwordAllowed(name as string)) {
      recordSignIn(name as string, "sign-in refused", "provider only");
      return page(response, 403, loginPage(`Sign in with ${ssoSettings()?.label ?? "your identity provider"}.`, returnTo, ssoOffer()));
    }
    recordSignIn(name as string, "signed in", "browser");
    const id = randomBytes(32).toString("hex");
    sessions.set(id, {
      ...arrival(request),
      name: name as string,
      csrf: randomBytes(32).toString("hex"),
      role: authenticated.role,
      generation: authenticated.generation,
      createdAt: Date.now(),
      sawBoardAt: null,
      lastSeen: Date.now(),
      project: defaultProject,
      projectRevision: 1,
    });
    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${cookieSecure}`,
    );
    return redirect(response, returnTo);
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
    return page(response, 200, store.inviteIsLive(joinToken, clock()) ? joinFormPage(joinToken, null, "") : joinDeadPage());
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
      return page(response, 400, joinFormPage(joinToken, "names are 1\u201340 characters \u2014 letters, digits, dots, dashes, underscores", name));
    }
    if (password.length < 8) {
      return page(response, 400, joinFormPage(joinToken, "the password needs at least 8 characters", name));
    }
    const made = store.consumeInviteAndCreateAccount({ tokenValue: joinToken, name, credentialHash: hashPassword(password) }, clock());
    if (!made.ok) {
      if (made.reason === "name-taken") {
        return page(response, 400, joinFormPage(joinToken, "that name is taken \u2014 pick another", name));
      }
      return page(response, 200, joinDeadPage());
    }
    // The cookie mints only AFTER the commit — same shape as login.
    const id = randomBytes(32).toString("hex");
    sessions.set(id, {
      ...arrival(request),
      name,
      csrf: randomBytes(32).toString("hex"),
      role: made.role,
      generation: 1,
      createdAt: Date.now(),
      sawBoardAt: null,
      lastSeen: Date.now(),
      project: defaultProject,
      projectRevision: 1,
    });
    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${cookieSecure}`,
    );
    return redirect(response, "/");
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
    const back = (words: string) => page(response, 400, loginPage(words, "/", ssoOffer()));
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
    if (!adapterPolicy({ caller: "service", capability: "none" }).ok) return page(response, 403, loginPage("This sign-in is not allowed."));
    const verified = await verifyIdToken(token.idToken, held.provider, settings, held.visit.nonce, clock(), fetcher);
    if (!verified.ok) { logEvent("warn", "sso.refused", { reason: verified.said }); return back(verified.said); }
    // A step-up must be a check made just now, not a remembered one.
    if (held.intent === "reauth" && verified.claims.authTime !== null && Date.now() / 1000 - verified.claims.authTime > 300) return back(`${settings.label} didn't check you again. Try once more.`);
    const key = randomBytes(24).toString("base64url");
    for (const [one, value] of ssoHandoffs) if (value.expires < Date.now()) ssoHandoffs.delete(one);
    while (ssoHandoffs.size >= 1000) ssoHandoffs.delete(ssoHandoffs.keys().next().value!);
    ssoHandoffs.set(key, { claims: verified.claims, issuer: held.provider.issuer, intent: held.intent, returnTo: held.returnTo, expires: Date.now() + 60_000 });
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
    "edge.join": joinPage,
    "edge.join-send": joinSend,
  });
  return { registrations, takeJoinAttempt, ssoCallback, readAccessForm };
}
