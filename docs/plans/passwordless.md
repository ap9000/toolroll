# Passwordless mode — plan

Status: v3, 2026-10-20 — Codex rounds 1–2 folded in (§ Review). Branch `passwordless`.

## What

Alex: *"I wanna remove the password thing anyway with a password less mode (except ui login)."*

One installation setting, **Passwordless**. When it is on, signing in to the console is the only password: every
step-up that asks an approver to type their password again (approvals, the chat card confirm, settings, secrets,
budgets, people, signing a mode, starting a Live terminal…) is satisfied by the person's live browser session instead.
Off by default; an existing installation is unchanged until an operator turns it on.

The trade, stated on the setting itself: anyone holding a signed-in browser (an unlocked laptop, a phone, a stolen
cookie) can then do everything that person can, with no second check. Sign-in, session lifetime (12 h idle, 7 days
absolute), sign-out, and "end this session" on the Sessions page are the protection that remains.

## What does not change

- **Signing in** still takes the password (or the identity provider).
- **Who may act**: roles, project access, operator-only areas, viewers — all checked exactly as now.
- **Two-person rules**: protected work still needs two *different* people. Passwordless removes typing, not people.
- **The lead and modes**: a lead-proposed or coordinator-filed scope is still sealed only by a person's act, never by an
  operating mode (the mate/coordinator quarantine in `store.ts`). Passwordless makes the person's act a click; it
  doesn't let a mode, a schedule, the lead or an API token decide.
- **Machine callers**: API tokens, OAuth, the MCP gateway, chat bridges (Telegram/Slack/…) and the remote CLI keep their
  own rules; step-up routes stay browser-only. Passwordless is about the signed-in person: at a browser, or at this
  computer's CLI through its remembered login (§5).
- **Credential acts** still take a typed password (or a one-use identity-provider re-check, `sso-now`), because each
  creates or widens a way in. The closed list:
  - **your own login**: changing your password; sign-in methods and identity-provider (SSO) settings;
  - **machine credentials**: creating an API token; OAuth consent (connecting an outside app); registering or replacing
    a worker (`/fleet/runner/register`);
  - **people**: inviting someone (`/people/invite`); widening anyone's access, including to instance operator
    (`/people/projects`);
  - **channels that can act**: pairing a chat (Telegram, Slack, Teams, Discord); turning on approving from chat or
    changing its limits; signing an operating mode **with** chat approval (`/mode/sign`, `chat-approve=1` — signing a
    mode without it is an ordinary act);
  - **inbound hooks**: a flow trigger's setup, secret, accepted sender or scope
    (`/flows/:flow/triggers/:trigger/{setup,secret,sender,scope}`) — they create ingress credentials or widen what is
    accepted;
  - **Passwordless itself**: turning it **on**. Turning it **off** is one click.

## How

### 1. The setting

`passwordless` in the instance settings ledger (append-only, newest wins, like the check level): `on` / `off`, who,
when. Settings → Sign-in shows it with the trade in plain words. Turning it on: operator, password, a ledger line;
off: one click, a ledger line. The People and Sessions pages say "Passwordless is on" so it's never invisible.

### 2. One place in the code, and the paths that bypass it today

Every step-up should end in `proveAccountNow(store, by, token)` (`scope.ts`). Passwordless adds one reading there:

- `token === ""`, Passwordless is on (read live, at the act), and the request carries **browser session facts**
  (`freshFacts`) for this same person whose `live()` holds → `{ ok: true, method: "session" }`.
- `live()` is made strict for everyone (it matters to B2 freshness too): the session must still be **saved in the
  database** at the act (`sessions.stillSaved`), not only held in this process's memory, plus the existing generation
  and revocation checks — so a session ended from another process mid-request no longer counts.
- No session facts → unchanged: a password is required.

Paths that don't reach the prover today, fixed in this slice:
- **Reject-empty-first** handlers (task approval `tasks.ts`, chat card approval `chat-actions.ts`) stop rejecting an
  empty password themselves and delegate to the prover (inside their existing transaction).
- **Direct `authenticateAccount` callers** (chat-approval settings, chat pairing in `settings.ts`) are credential acts
  (list above): they move to `proveCredential` (below), keeping their standing and generation checks.

**Credential acts** call `proveCredential(store, by, token)`: the prover, but refusing `method: "session"` (and B2's
remembered-password methods). Every route in the closed list uses it; a static test enumerates them, and fails if a
listed route calls `authenticateApprover`/`proveAccountNow` directly or if `authenticateAccount` is called anywhere
else outside sign-in.

**Background work never inherits a session.** Detached work started during a request (the lead's turn in
`server/chat.ts`, and any other `void`-started task found by the audit) runs with `freshFacts` cleared, so it can't
carry the request's session into an act. A test starts detached work inside a request and proves its acts see no
facts.

`method: "session"` is recorded wherever the method is recorded today, so every act shows it was approved without a
password while Passwordless was on.

### 3. The forms

Re-authentication fields (the ceremony's "your password" field — not API keys, secrets, or the login form) are rendered
in ~35 places. They move to **one helper**, `ceremonyPassword()`, which renders the field as today or, with
Passwordless on, nothing at all. Forms keep posting `password` (empty). Each form's own submit rules stop requiring it
too (e.g. the Live terminal's Start button, which is disabled until a password is typed). Credential-act forms keep
their field regardless. A static test: no re-authentication field (`name="password"` in a ceremony form) outside the
helper and the credential forms; secret and key inputs are untouched.

### 4. The freshness audit

B2's static tripwire (`password-freshness.test.ts`) pins every password-related mention in the source. The new
reading lives inside `proveAccountNow` and the setting reader; their pins are added as reviewed changes, and the test
gains one rule: `method: "session"` is produced in exactly one place and refused by the credential routes.

### 5. The local CLI (Alex, 2026-10-20: "stop asking on CLI and apply wherever we're signed in")

The CLI's "signed in" is the **remembered login**: `up-login.txt` beside the database (0600, written durably by
`toolroll up`, denied to every agent by the fence's secret patterns, never read on a remote run — `credentialsFrom`
returns the token's person first). The CLI **already** falls back to it wherever a command takes credentials through
`credentialsFrom`/`askCredentials`, so most CLI writes already need no typing. What Passwordless adds:

- **Every person-credential read goes through `credentialsFrom`.** The commands that read `--token` directly for a
  person's password are moved onto it (an `--as` naming someone else without a token is still refused, never silently
  replaced). Worker, coordinator and lead tokens are not person passwords and stay as they are.
- `credentialsFrom` reports its **source** (`typed` or `remembered`); an act proved with the remembered login is
  recorded with the method `cli-login`, so the ledger never reads it as a typed password.
- **Credential acts refuse `remembered` while Passwordless is on**: a typed `--token` (or stdin/file) only. The CLI
  list mirrors the browser's: `approver add`; minting an API token; inviting people and widening access; `runner
  register` and **`runner bind`** (widens a worker's projects); **`bridge telegram pair`** and any other chat pairing;
  **`chat-approval on`** (and changing its limits); signing a mode with chat approval; a flow trigger's
  setup/secret/sender/scope; `passwordless on`. A static test enumerates them.
- Passwordless off → exactly today's CLI behaviour.
- The remote CLI (API tokens over HTTP) is unchanged.

Tests: with Passwordless on, an approval, a settings change and a task merge succeed from the CLI with no `--token`
and record `cli-login`; `--as someone-else` without a token is refused; every listed credential command refuses the
remembered login and accepts a typed one; Passwordless off restores today's behaviour; a remote run never reads the
file.

## Tests

- Off (default): every existing ceremony test passes unchanged; an empty password is refused as today.
- On: an approval, a chat card confirm, a settings change, signing a mode and starting a Live terminal succeed with an
  empty password from a live browser session; the ledger shows `session`.
- On, but: a revoked/rotated/ended session, a viewer, a project-limited account outside its projects, an API token, the
  CLI, a chat bridge — all refused exactly as today.
- On: protected work still needs a second person; a lead-proposed scope is still never mode-sealed.
- On: every credential act (the closed list) still requires a typed password; turning off is one click.
- A session ended from another process while a request is in flight: the act is refused (on and off).
- Detached work started inside a request sees no session facts.
- The Live terminal's Start works with no password typed.
- Forms: with Passwordless on, no ceremony renders a password field; the login form still does.

## Not in this slice

Per-project or per-person passwordless, a "this computer only" variant (Alex: wherever signed in), and removing the
password from sign-in itself.

## Review — round 1 (Codex, NO-GO, 5 findings), and what changed

1. **`live()` trusted memory** → it now proves the saved session at the act (all modes), with a cross-process test.
2. **Credential exceptions unspecified** (API tokens, OAuth consent would have gone passwordless) → a closed list of
   credential acts on `proveCredential`, which refuses session and remembered-password proof; statically enumerated.
3. **Paths that bypass the prover** → reject-empty-first handlers delegate to it; direct `authenticateAccount` callers
   (chat approval, pairing) become credential acts.
4. **Background inherits facts** → cleared when detaching, with a test.
5. **Forms** → submit rules updated too; the static ban is narrowed to re-authentication fields; no repeated helper
   text.

## Review — round 2 (Codex: 4 CLOSED, 1 OPEN)

2. **The credential list was incomplete** → added inviting people, widening access, registering a worker, a flow
   trigger's setup/secret/sender/scope, and signing a mode with chat approval. The static test enumerates exactly
   these routes on `proveCredential`.

## Review — round 4 (Codex on §5: NO-GO, 1 finding)

The CLI credential list missed `runner bind`, `bridge telegram pair` and `chat-approval on` (all through
`askCredentials`, which already accepts the remembered login) → added, and §5 now states the CLI already uses the
remembered login through `credentialsFrom`; Passwordless only routes stray `--token` reads through it, records
`cli-login`, and makes the listed credential commands typed-only.
