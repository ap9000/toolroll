# Passwordless mode — plan

Status: draft v1, 2026-10-20. Branch `passwordless` (from `live-terminal-main`, PR #205).

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
  own rules; step-up routes stay browser-only. Passwordless is about the person at a browser.
- **Your own credentials**: changing your password, adding or removing a sign-in method, and turning Passwordless
  *on* still take the current password — they are the login itself. Turning it *off* is one click.

## How

### 1. The setting

`passwordless` in the instance settings ledger (append-only, newest wins, like the check level): `on` / `off`, who,
when. Settings → Sign-in shows it with the trade in plain words. Turning it on: operator, password, a ledger line;
off: one click, a ledger line. The People and Sessions pages say "Passwordless is on" so it's never invisible.

### 2. One place in the code

Every step-up already ends in `proveAccountNow(store, by, token)` (`scope.ts`), through `authenticateApprover`. Today an
empty password is honoured only by the B2 freshness rules. Passwordless adds one more reading there, and nowhere else:

- `token === ""`, Passwordless is on (read live, at the act), and the request carries **browser session facts**
  (`freshFacts`) for this same person whose `live()` holds (the session still saved, same credential generation, not
  revoked) → `{ ok: true, method: "session" }`.
- No session facts (a CLI, a token, a chat bridge, a background job) → unchanged: a password is required.
- A typed password is still checked as a password when one is sent.

`method: "session"` is recorded wherever the method is recorded today (approvals, the ledger), so every act shows it
was approved without a password while Passwordless was on.

The routes that change the login itself (password change, sign-in methods, the Passwordless toggle) refuse
`method: "session"` explicitly.

### 3. The forms

Password fields are rendered in ~35 places (server pages and React views). They move to **one helper**,
`ceremonyPassword()`, that renders the field as today, or, with Passwordless on, nothing but a quiet line ("No password
needed — Passwordless is on"). The forms keep posting `password` (empty), so the server path is the same one. The
login form and the credential forms keep their fields regardless. A static test: no `type="password"` outside the
helper and the credential forms.

### 4. The freshness audit

B2's static tripwire (`password-freshness.test.ts`) pins every password-related mention in the source. The new
reading lives inside `proveAccountNow` and the setting reader; their pins are added as reviewed changes, and the test
gains one rule: `method: "session"` is produced in exactly one place and refused by the credential routes.

## Tests

- Off (default): every existing ceremony test passes unchanged; an empty password is refused as today.
- On: an approval, a chat card confirm, a settings change, signing a mode and starting a Live terminal succeed with an
  empty password from a live browser session; the ledger shows `session`.
- On, but: a revoked/rotated/ended session, a viewer, a project-limited account outside its projects, an API token, the
  CLI, a chat bridge — all refused exactly as today.
- On: protected work still needs a second person; a lead-proposed scope is still never mode-sealed.
- On: password change and the Passwordless toggle still require the password; turning off is one click.
- Forms: with Passwordless on, no ceremony renders a password field; the login form still does.

## Not in this slice

Passwordless for the local CLI (it has no session; it keeps asking), per-project or per-person passwordless, a
"this computer only" variant, and removing the password from sign-in itself.
