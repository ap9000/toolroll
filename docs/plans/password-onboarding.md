# Password onboarding in the Mac app

Status: revised 2026-11-22 after critic review (see "Critic review" at the end). Owner ask (Alex): "make the onboarding much clearer so we have a password
(in the UI we need this onboarding)". He had a password set by an earlier session and never saw it; the app offered
password boxes that couldn't work (fixed in b02239be).

## Today

- A laptop install starts in local mode with no usable password (`initLocalMode`). The first password is set at
  `POST /password/set` (people-tokens.ts:773, cookie session, csrf + mutation key, >= 8 characters, typed twice; ends every
  session of the account) or `toolroll password set`. A forgotten one is reset only at this Mac's terminal
  (`toolroll password reset`, operate.ts:15138: the trust boundary is this computer's account); no HTTP route, by design.
- The app never learns whether a password is set, has no set-password step, and maps the local-owner refusal "Set a
  password to do this." to a password box (ToolrollClient.swift sendFormAct), which can't succeed.

## Design (smallest that makes it clear)

1. **The app learns `passwordSet`.** `POST /login/once` (the app's connect, `linkRedemptionSchema`) answers an optional
   `passwordSet: boolean`, read from the store for the redeemed account. Optional, so older apps and servers still match.
2. **Set a password (native sheet).** Shown from: a one-line banner while `passwordSet` is false ("Set a password to
   approve work and change settings." + **Set a password**), the first-run Setup screen, and in place of any password
   box when the server says "Set a password to do this." Fields: Password ("At least 8 characters.") and Type it again;
   buttons **Set password** / **Not now**. It posts the existing `/password/set` form (csrf, mutation key, form-encoded,
   the console's own Origin), then reconnects through the local link (the post ends every session, the app's included)
   and reads `passwordSet` again: that, not the HTML answer, decides success. Refusals map to the server's own words
   (400 short or not matching, 409 already set, 429 too many tries).
3. **Forgot password?** Under every password box (approval, model change, worktree setup, Project Settings): opens
   Terminal on a one-line `.command` file that runs `toolroll password reset` (no Automation permission needed), with
   the note "Resetting happens in Terminal, on this Mac. It signs out your other sessions." Nothing is reset from the app.
4. **Words.** The browser's (render-people.ts:155-172), so both say the same thing.

## Out of scope

Changing a set password from the app (Terminal's `toolroll password reset`), remote/bearer connections (no local link).

## Tests

- Server: `/login/once` answers `passwordSet` false before and true after `enrollOwnerPassword` (engine-api contract test
  and its fixture).
- Swift: decoding a redemption with and without `passwordSet`; the refusal mapping ("Set a password to do this." opens
  the set-password sheet, "Enter your Toolroll password…" keeps the box); the `.command` file's exact contents.
- Manual: on this Mac, Forgot password? opens Terminal with the reset prompt; a fresh install's banner sets a password
  and the banner goes away.

## Critic review (folded in)

- Forgot password? never writes or runs a file (a build could swap it between write and open, outside the sandbox):
  it shows the command with **Copy command** and **Open Terminal**; the person pastes it. Nothing runs on its own.
- Set a password: length and match are checked in the sheet first (a wrong try spends the sign-in budget); the form
  carries `csrf` in its body and the key header; the answer is HTML, so the app pauses its refreshes, mints a fresh local
  link, reconnects, and only the re-read `passwordSet` says it worked.
- Refusals match the server's exact sentences (local-owner.ts localOwnerRefusal): "Set a password to do this." opens
  the sheet; "Sign in with your password to do this." says so plainly with Open in browser, never a password box.
- The banner's Not now is remembered for a week; success says "Password set."
