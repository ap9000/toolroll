# Plan v3: everyday interactive agent threads (Flexible, beta) — from 8 to 9

Base: main f91ea774 (0.9.114). Read-only study in a fresh detached worktree, removed afterwards. No product code. File:line refs are at that commit. v2 folds in Codex round 1 (REVISE, six findings) and the owner's decisions D1–D7. The changelog is at the end.

## 0. What the code says (verified)

**Ship has no caller.** `shipFlexible` (src/flexible-ship.ts:267), `flexibleShipTerms` (:233), `cancelFlexibleShip` (:749), `sendBackFlexible` (:765) and `removeFlexibleImport` (:787) are called only from flexible-ship.slow.test.ts; the module says so at :30–31. Two more problems sit inside it:
- `personNow` (:197) accepts any proof `authenticateApprover` gives: a session standing in, a remembered login, `cli-login`, the local-owner act.
- It is proved before the thread lock (:271).

**There is no follow-up turn.** `admitFlexibleTurn` (flexible-turns.ts:277) has one caller, the first turn (flexible-session.ts:699, `opening: true`). It takes no thread lock. The engine registers only the start and answer POSTs (server/engine-api.ts:484).

**There is no End.** The thread state goes `preparing → ready → removing → removed` (flexible-thread-schema.ts). The list shows `state='ready'` only (flexible-session.ts:859). The terminal files every thread under Working (thread.rs:151). `s` goes to the task-only Steer (app.rs:3197).

**Titles live only in memory** (flexible-session.ts:635, with the fallback at :816). The start answer carries no thread id (engine-api.ts:334).

**Ending authority leaves threads running.**
- Account changes all go through `Store.revokeDerivedAuthority` (store.ts:10266): rotation :9943, access change :10349, SSO groups :11170, revoke :11304, and password reset (`resetAccountPassword`, store.ts:27547). That path ends sessions, lead turns and chat bindings, but never thread turns.
- Revoke retires sign-ins itself (store.ts:11273) and calls `relayCancel`, which only reaches this process.
- `removeFlexibleSignIn` (flexible-sign-in.ts:235) moves the removal epoch and cuts calls in this process only.
- None of these interrupts a turn, withdraws an admitted one, or stops an agent in another process.

**The relay and the turn record disagree.**
- The relay's own refusals (flexible-relay.ts:552) record the call but leave the turn running. Only an upstream 401/403 interrupts it (:481).
- `primaryResultEvent` ends a turn "finished" even when the result is an error (flexible-session.ts:529).
- `endFlexibleThreadTurn` clears `agent.turn` even on `turn-not-running` (:564). An interrupt followed by a result loses the link between the agent and its turn.
- `factsOf` never shows `end_detail` (:805).
- Nothing stops an agent whose turn was interrupted. `settleFlexibleStops` acts only while threads are off (:183).

**Local-owner sessions can't take a typed password.** `proveAccountNow` decides a local owner first and refuses credential acts whatever was typed (scope.ts:1358–1365). It returns `local-owner` for any non-read act. The setup routes `settings.flexible-sign-in` (route-table.ts:663–665) and `settings.project-flexible` (:640) have no `LOCAL_POSTS` row (:150), so they are refused at serve.ts:2518.

**CLI prompts.** `askCredentials` (operate.ts:11483) has no default name. `config show flexible` already doesn't prompt (:15287). The prompts are on `config set flexible on|off` (:15296) and every `flexible-sign-in` action (:15357, :15360). `show --check` sends the saved credential to Claude (:15379).

## 1. Findings: root cause → change → words

### F1. Continue, ship, end

**One boundary per act.** Each act holds the thread lock (`withFlexibleThreadLock`, flexible-thread.ts:593) for its whole length. That lock is file-backed, works across processes, and is re-entrant within a call.
- **Reply:** admission → begin → writing the message to the agent.
- **Ship:** the running-turn check → stopping an idle agent → the press.
- **End:** closing → withdrawing → asking for the stop.

**Reply.**
- `continueFlexibleThread(store, sessions, {thread, by, message, requestKey, held, launcher})` runs under the lock. Its admission transaction re-reads:
  - the person's live session (`held()`, compared whole with the saved row, as the answer road does at engine-api.ts:279);
  - the sign-in's billing (`flexibleSignInBilling`);
  - whether the thread is ended.
- It then calls `admitFlexibleTurn` with the last turn's `termsDigest`, `model` and level.
- Then `beginFlexibleThreadTurn`, then the message is written to the agent, all before the lock is released.
- The route is `POST /agents/live/thread/<id>/turn` with local act `reply-thread` and the start's proofs. The client sends a random 32-hex `key`; the existing request-key rule stops a repeated post from taking a second turn.
- D7: no `--resume` in this arc. When no agent is live, the reply box says **"This starts a fresh agent. It won't remember earlier turns; your files are as it left them."** After sending: **"Sent. Turn 3 started with a fresh agent."** (or **"Sent. Turn 2 started."** when the agent was reused).

**End (D4: final).**
- Migration v174 adds `flexible_thread_meta(thread PK, title ≤80 written once, ended_at, ended_by, end_words, tidied_at)`. This is separate from `flexible_thread.state`, which stays the record of the repository's removal.
- Under the lock, one transaction:
  - sets `ended_at`;
  - withdraws admitted turns;
  - interrupts the running one ("You ended this thread.");
  - revokes answers;
  - writes a durable stop requirement (§F2).
- The stop then runs, with retries on the tick.
- Both `admitFlexibleTurn` (:286) and `beginFlexibleTurn` (:432) refuse an ended thread: **"This thread has ended. Press T to start a new one."**
- Ended threads go to Recent and can't be reopened.
- An ended thread stays shippable once its stop is verified. While the stop is pending, Ship refuses: **"Its agent is still being stopped."**
- Send back on an ended thread is refused: **"This thread has ended, so it can't take your note. Cancel the Ship, or start a new thread."** Cancel stays available.
- The upkeep tidies an ended thread's copy after 7 days (`removeFlexibleThread`, which already refuses while a Ship is open, flexible-thread.ts:343). It skips threads with an open Ship and tries again next pass. A merged Ship counts as "shipped": that copy is tidied too (see the open questions).
- What the person sees: **"Ended. Stopping its agent…"**, then **"Ended."** once the exit is verified. While it isn't: **"Ended. Its agent hasn't stopped yet; Toolroll keeps trying."**

**Lists (D3).**

| State | Section | Word |
|---|---|---|
| Turn admitted or running | Working | `Working` |
| Question or permission waiting | Needs you, read or not | `Question` |
| Turn finished | Needs you with an unread dot until looked at once, then Recent | `Ready` |
| Turn stopped (interrupted) | as above | `Stopped` (its note: why, then Reply) |
| Turn outcome unknown | as above | `Outcome unknown` (its note: check its activity) |
| Ship armed or on its way | Working | `Shipping` |
| Ship stopped / refused or failed | as a finished turn | `Ship stopped` / `Ship refused` |
| Ended (closed by the person) | Recent | `Ended` |

**Placement (owner's decision, status audit 2026-11-18).** Looking means selecting the thread or opening its view. Seen
state is per thread turn (and Ship state), kept in the workbench's own view state like task unread dots; a new finished
turn is news again. Reading clears only the news, never answers anything. The latest turn's stop or refusal is said
first, an older Ship's words after it. A merged Ship reads `Ship: Merged` on the row's second line, apart from the
thread's own word. The top bar's count, `!` and the terminal title count threads in Needs you with Work's rows. Words
the browser and the CLI also show name no terminal keys. The browser and the CLI say the same state words.

`liveThreads` rows gain `turn`, `ended`, `ship` and `stopPending`. The start answer carries `thread`. A new `ActOutcome::ThreadStarted` selects the thread once it is listed.

**Keys.**
- On a thread: `s` Reply, `a` Ship, `x` Stop the agent, `X` End (asks first). After arming, `r` Send back.
- New palette-only actions `ThreadReply`, `ThreadShip`, `ThreadStop`, `ThreadEnd` and `ThreadSendBack` have no default keys. `s/a/x/X/r` route to them when the selection is a thread.
- The palette finds "Reply to the thread", "Ship the thread's work" and "End the thread".

**CLI.** `toolroll thread list|show|ship|end|remove`. Reply stays in the workbench, because the console holds the agent's input.

### F2. Ending authority stops running turns; Toolroll's words show

**The shared path.** A new `endThreadAuthorityFor(handle, person, cause, now)` lives in a small module that takes only the database handle, so store.ts has no import cycle. In the caller's transaction it:
1. retires the person's active and staged sign-ins;
2. raises the removal epoch;
3. interrupts every running turn the person owns, with the cause's words;
4. withdraws their admitted turns;
5. writes one durable stop requirement per live launch of theirs;
6. calls `relayCancel` (the in-process fast path).

Who calls it:
- `revokeDerivedAuthority`, so every generation move gets it: rotation, access change, SSO groups, revoke, password reset;
- `removeFlexibleSignIn` (self, or an operator from People);
- the restore reset, for every person;
- the tidy's account-change retire.

Codex 1 asked for exactly this path.

**The durable stop requirement (Codex 3).**
- v174 adds `flexible_stop_request(launch PK, thread, reason, words, requested_at, settled_at)`.
- Only a verified exit settles a row. A row names one launch, and is settled for that launch only.
- Each console's tick reads the table and stops through custody (`stopFlexibleThreadAgent` with `expect: {launch, holder}`). So a CLI-side removal is acted on by the console holding the agent. That cross-process observation is tested on its own; the in-process `relayCancel` cut is tested separately.
- `config clear flexible-sign-in`, People and Settings also stop at once where they can (`stopFlexibleThreadsOf(owner)`, a filter on `stopFlexibleThreadsEverywhere`) and report what they stopped.

**The session.**
- `endFlexibleThreadTurn` no longer clears `agent.turn` on `turn-not-running`. It clears it only once the record is terminal and, for an abnormal end, a stop requirement for that launch exists (inserted if missing).
- A `result` with `is_error` ends the turn `unknown`.
- The tick's backstop predicate is `signInHoldsFor`, but with the epoch and generation captured when the turn began, not today's. v174 adds `flexible_turn_dispatch(turn PK, sign_in_epoch, sign_in_generation)`, written by `beginFlexibleTurn`. A removal followed by a fresh save still stops the turn. A plain replacement never does.

**The relay.** Its refusals for `no-sign-in`, `sign-in-refused`, `billing-mismatch` and `threads-off` interrupt the running turn inside `settle`'s transaction, with the words the agent was sent, and write a stop requirement.

**The view.**
- Facts gain `turn.endWords` and `turn.billing`.
- The terminal head reads `turn 1 stopped · on your plan`, followed by a line in Toolroll's style.
- The agent's lines after a relay refusal (`API Error: 4xx`, `Invalid API key`, `Please run /login`) are replaced by that line. The decision comes from the relay's own record for the turn, never from the agent's text.

**Words.**
- Removed by yourself: **"Your Claude sign-in for threads was removed, so Toolroll stopped this turn. Add one again, then reply to continue."**
- Removed by an operator: **"An instance operator removed your Claude sign-in for threads, so Toolroll stopped this turn."**
- Account changed: **"Your Toolroll account changed (a password reset or an access change ends your Claude sign-in for threads), so Toolroll stopped this turn."**
- Claude refused the sign-in: the existing `signInRefusedWords`.
- CLI clear: **"Removed. Stopped 1 running thread (Fix the parser)."**
- Browser: **"Removed. 1 running thread stopped."**

### F3. Thread setup from the `w` link (D2: a typed password counts, for a closed list)

Closed list: `flexible-switch` (on), `flexible-sign-in-save`, `flexible-sign-in-check`, `project-flexible-enable`. Ship is not on it: the browser stays read-only (D6).

On those rows only, when a local owner is in flight and a non-empty password was typed, `proveAccountNow` checks it against the owner's real account hash. Codex's conditions, kept exactly:
- **The session stays restricted.** Only these rows get `LOCAL_POSTS` entries.
- **The live binding is required.** `localOwnerStandsNow` (local mode on at the bound generation, same account and generation, session row saved) is re-read in the write's transaction.
- **A real password is required.** With `passwordSet = false`, the existing `localOwnerRefusal(false)` applies: **"Set a password to do this."**
- **The lockouts are kept.** The same sign-in guard counts every wrong password: **"That password isn't right. Nothing changed."**
- **Nothing carries over.** No reusable freshness: `passwordAt` is never set and no fresh facts are written. No session upgrade: the authority stays `local-owner`. The proof is good for this one act's transaction only.

Narrowing rows (`flexible-sign-in-clear`, threads off) become plain local acts with no password.

### F4. CLI (D5)

**Wording fix:** `config show flexible` already doesn't prompt. The prompts are on `set flexible on|off` and every `flexible-sign-in` action.

**Changes:**
- **Default name:** `askCredentials` defaults to the remembered login's name, or else to the solo operator: `Toolroll name [alex]: `. Only function bodies change: ordinals are pinned by password-freshness.test.ts, rule 7.
- **No password on a solo install** for `flexible off`, `flexible-sign-in clear` and plain `show`. Each narrowing write re-reads solo mode and the operator's identity inside its own transaction. Lead, token, chat and `machineActing()` refusals still come first.
- **`show --check` still needs a proof** (Codex 6): it sends the saved credential to Claude.
- **Credential acts ask every time.** `on` and `set flexible-sign-in` take a hidden password typed now, never the remembered login.
- **`on` names the next steps:** **"Threads are on. Next: 1) your own Claude sign-in: `claude setup-token`, then `toolroll config set flexible-sign-in`. 2) this project's terms: `toolroll project flexible enable --repo <path>`."** Steps already done are left out.

### F5. Words and the browser

**Define Flexible once, where it is chosen** (project settings and the top of the terms card): **"Flexible: people here can start interactive agent threads right away, without a plan approved first. A thread's changes reach the project only when you Ship them and the project's checks pass."**

**D6: a read-only Threads list on Agents → Live**, from `GET /agents/live/threads`. It uses the same state words and says **"Continue in the terminal: run `toolroll`, then pick it."**

## 2. Ship

### What `shipFlexible` already proves (kept whole)

- **Terms:** everything in `FlexibleShipTerms`.
- **Digest:** `sha256("standing-orders:flexible-ship:" + canonicalJson(terms))[0:32]`.
- **Summary key:** `shipSummaryOf` (approval-summary.ts:539) binds every row and warning shown.
- **Under the thread lock:** no running turn and no live launch; the terms are rebuilt and must match the digest and key.
- **One consent transaction** re-reads the owner's standing, the generation, the delegation digest and the next seq. The Ship's id is its digest, so it can be pressed once.
- **The quarantined import:** every check, on every commit, before any ref moves.
- **One transaction** files the verify-only task, seals it through `approve()` and arms the merge.
- **The armed merge** re-proves itself every pass (`authorityProblem`, :442) and merges only when the required check passed on the exact commit.

### New doors

- **Show the terms:** `GET …/ship`, owner only, no side effects.
- **Press:** `POST …/ship {digest, key}` (plus the proof below) goes through `shipFlexibleThread`. Under one lock it:
  - refuses while a turn is admitted or running: **"The agent is still working on your last message. Wait for it, or stop it with x."**
  - stops an idle agent, exit verified;
  - runs `shipLocked`.
- **The proof changes (Codex 2).** `personNow` gives way to a typed `ShipProof`: either `{kind: "local-owner"}` or `{kind: "password-now", password}`. There is no session, remembered-login, `cli-login`, Passwordless or `--token` proof.
- **Proved in the right place.** The proof is checked before the lock (a quick refusal) and again inside the consent transaction, before the import. The seal check in `fileAndSeal` stays as it is.
- **One term is added:** **"Shipping stops the thread's agent. A later reply starts a fresh agent on the same files."**

### D1: the password-free local-owner road ("No password (laptop)")

**Where it works.** The terminal only, through the engine route, from the live local-owner session. In the terminal: `a` opens the Ship sheet, headed **"Ship approves exactly this:"**. The terms are drawn whole and read with j/Space. Enter works only once the end has been drawn, as in today's Approve. The answer: **"Shipping: checks run on commit abc123; Toolroll merges it once they pass."**

**A new act `ship-thread` in `LOCAL_OWNER_ACTS` permits exactly this:**
- one press of exactly the terms shown (digest and key), for a thread the owner started;
- stopping that thread's idle agent;
- recording consent with proof `local-owner` (transport `terminal`, local and account generations);
- running the quarantined import;
- filing that Ship's own verify-only task (`flexible-<digest>`) and sealing it;
- arming the merge.

**It never permits:**
- merging directly (that stays the armed pass's job, on the exact green commit);
- opening a pull request outside the armed pass;
- changing the check command, the publication grant or the project's terms;
- approving any other task;
- carrying over to any other act.

**Checks, all inside the consent transaction:**
1. `localActNow(store, "ship-thread")`. This means local mode is on at the bound generation, the same owner, the same account generation, the session row saved and in flight, and no lead or remote chain.
2. **The install has no password at all**, read again here: `passwordFreeOwner` (no active account with `password_set = 1`), no SSO identity linked, the install solo, and the owner is the only active approver.
3. **This is not a remembered login.** CLI and remembered-login roads never carry this act. Bare CLI commands outside the workbench are not local-owner (operate.ts:1192), so on a password-free install `toolroll thread ship` answers: **"Ship from the workbench: select the thread and press a."**
4. **The request comes from this computer**, checked per request at the door (`fromThisComputer`). I found no per-request locality check in `localPrincipalOf` (serve.ts:2510), so the door does it itself.
5. **The owner's standing:** the thread's creator, an approver, not a two-person project, Flexible on. The rebuilt terms must match the digest and key.
6. **The work is the kind the local owner may approve.** `localWorkEligible(owner, task, {act: "approve"})` runs on the verify-only task inside `fileAndSeal`. That refuses release or deploy work, protected or two-person work, an escalated profile, an unsandboxed project and coordinator-filed tasks. Refused words: **"This change needs a password to ship (it touches protected files). Set one with `toolroll password set`."**
7. **`approve()` gets one narrow branch.** It accepts local act `ship-thread` only when the task id is `flexibleShipTaskId(digest)` of a row that is `imported`, `approved_by` the owner, with proof `local-owner`, and whose candidate equals the scope's candidate. The seal is a local seal, so `localSealStandsSql` demotes it if local mode moves. The armed pass's `authorityProblem` also checks local mode at the bound generation for local-owner Ships.
8. **Setting a password ends it.** It moves the account generation (`enrollOwnerPassword`), so an armed local-owner Ship is cancelled for good by `authorityProblem` (:447). This is the safe default; see the questions.

**What I think is unsafe, or needs the owner's eyes:**
- **(a) It contradicts the recorded policy.** docs/plans/local-owner-acts.md (2026-11-12) says "Merging, releasing … keep their password", and pull-request-flow.ts:189 refuses a local owner a pull request. D1 overrides that for Ship only. That doc should record the exception.
- **(b) A row alone would grant too much.** `proveAccountNow` says yes to any non-read local act (scope.ts:1364), so adding a `ship-thread` row without replacing `personNow` would make today's `shipFlexible` accept it unchecked. This is local-owner-acts' "trap"; `personNow` must go in the same slice.
- **(c) Terminal versus browser is no boundary.** Both carry the same local owner at the same computer. The safety comes from items 1–4. The browser simply has no Ship door (D6).
- **(d) One key merges code the agent wrote, once checks pass.** On a password-free laptop the project's check command is the only gate. Ship already refuses a project with no check command.
- **(e) Per-request locality.** local-owner-acts v2's "slice 0" called for it centrally, and I couldn't confirm it shipped. If it didn't, every other local act has the same gap.

### Installs with a password: password typed now, through a CLI hand-off

**The choice.** The CLI hand-off, not a field in the terminal. In the terminal, Enter answers: **"Shipping needs your password. c puts `toolroll thread ship 2aab596b --key 3f…` in your scrollback."**

**What the CLI does.**
- It prints the full terms and asks **"Ship exactly this? [y/N]"**.
- It then asks `Password:` at a hidden prompt. It refuses `--token`, a remembered login and `cli-login`.
- It binds the digest and key it printed. A `--key` that differs answers: **"The terms changed since the workbench showed them. Here they are again."**

**Why the CLI and not a terminal field:**
- The workbench stays password-free, which local-owner-acts and the console both rely on ("its proofs never stand on the session").
- The CLI already has the hardened hidden prompt and lockout accounting.
- No secret lives in the long-running Rust process's memory or redraws.
- The yes binds to what the CLI showed.

The cost is one extra step.

**After arming:**
- `x` Cancel ship (it only narrows).
- `r` Send back with a note (refused once the thread has ended).
- When merged: **"Shipped: merged into main."**

## 3. Slices (★ = security-sensitive: AGENTS.md safety self-review, then Codex review, at most 2 rounds)

1. **★ S1:** `endThreadAuthorityFor` via `revokeDerivedAuthority`, sign-in removal and restore; the v174 stop requirement and dispatch epoch; relay refusals interrupting; the session fixes; the tick; CLI, People and Settings reporting.
2. **S2:** Toolroll's words in the view (`endWords`, billing, replacing the refused-call lines).
3. **S3:** v174 metadata (title, end); list states; the start answer's thread id and selection.
4. **★ S4:** Reply under one lock (live session re-read, billing, ended barrier, the fresh-agent words).
5. **★ S5:** End's admission barrier, Stop, the 7-day tidy, the CLI `thread end`.
6. **★ S6:** D2, a typed password in a local-owner session for the closed list.
7. **★ S7:** Ship doors, `ShipProof`, the `ship-thread` act and the narrow `approve()` branch, the terminal sheet, the CLI ship, cancel and send back.
8. **★ S8:** CLI thread commands, default names, solo narrowing (re-read in the write), `--check` proof, next steps after `on`.
9. **S9:** the "Flexible" definition, the guide, the read-only browser list.

## 4. Tests (stand-ins only; own HOME/XDG; no real model, keychain or launchd; docs/testing.md kinds)

**S1:**
- Every `revokeDerivedAuthority` caller (rotation, access, SSO groups, revoke, reset) and sign-in removal retire the sign-ins, raise the epoch, interrupt running turns, withdraw admitted ones and write stop rows. A replacement does none of these.
- Two Store handles on one file: one process writes the removal, the other's tick stops the agent. The in-process cut is tested on its own.
- Interrupt → result → replacement sign-in → tick still stops the launch, including when the interrupt came from the other handle.
- The four relay reasons each interrupt the turn.

**S4/S5:**
- A reply racing Ship, End and another reply: exactly one wins, under the lock.
- Admission and begin both refuse an ended thread.
- End withdraws a pending admission atomically.
- An unverified stop shows as pending and is retried.
- Send back on an ended thread is refused.

**S6 (`proveAccountNow` table):**
- Accepted: a listed act with the right password.
- Refused: an unlisted act; an empty password; a wrong password (and the lockout counts it); `passwordSet = false`; a stale binding.
- After the act, the session has no `passwordAt` and its authority is unchanged.

**S7, negatives:**
- Refused proofs: session, remembered login, `cli-login`, `--token`, Passwordless, a lead token, `machineActing`.
- Proved before but not inside the transaction (a password changed in between) refuses with no import.
- The local road on: an install with a password, an SSO-linked install, a team install, a second approver, a request not from this computer, stale local generations, protected, two-person and release work.
- `approve()`'s branch refused for any other task id, state or proof.
- A password set while armed cancels the merge.
- A replayed press is refused.

**Contracts and migration:** v174 tables and triggers; engine responses (`threadShipTerms`, start answer with `thread`, facts additions); Rust parse; route inventory local marks.

**CLI:**
- The default name is offered.
- Solo narrowing works without a password and refuses if a second operator appears mid-command.
- `--check` asks for a proof.
- Credential acts never take the remembered login.

**Rust:** the palette finds ship and reply; key routing on threads; the Ship sheet's Enter works only after the end; Ready and Ended sections.

**verify.mjs flows (docs/feature-map.json).** New world needs:
- `ship-ready`: a local bare remote, a publication grant, and a stand-in `gh` in world.bin;
- `password-set`;
- a stand-in Claude that answers each message and can hold a turn until a release file appears.

| id | reach | expected |
|---|---|---|
| thread-selected | T…Enter | the new thread is selected |
| thread-reply | `s`, type, Enter | `Turn 2 started\.` |
| thread-reply-fresh | `x`, then `s`, type, Enter | `fresh agent` |
| thread-end | `X`, Enter | `Ended\.` and the row under Recent; T on it refused |
| thread-sign-in-removed | turn held; `config clear flexible-sign-in` (solo: no prompt) | `turn 1 stopped` + `sign-in for threads was removed`; launch exited |
| thread-ship-laptop | password-free: `a`, read to end, Enter | `Shipping: checks run` |
| thread-ship-password | `password-set`: `a`, Enter, `c`, `thread ship --key` + y + password | `Shipping: checks run` |
| threads-cli | `thread list`; `config show flexible-sign-in` | the title; no prompt (solo) |

**Browser journeys (desktop and phone):** D2 setup from the `w` link; the read-only Threads list.

## 5. Risks and open questions

- **D1 follow-ups.** Record the exception in local-owner-acts.md. Confirm that "slice 0" per-request locality shipped. Confirm that setting a password should cancel an armed local-owner Ship (my default) rather than let it finish.
- **D4: does "unless shipped" mean what I took it to mean?** I read it as: a merged Ship's copy is tidied too, and only an open Ship holds the copy. If "shipped" should keep the copy, that's a one-line change.
- **D7: a fresh agent has no memory.** The words say so plainly. Adding `--resume` later means a later agent loads a file an earlier one wrote (persistent prompt injection), so it needs its own review.
- **Transcripts live only in console memory.** A restart loses them; `thread show` gives facts only.
- **Ship takes only committed changes.** Telling the person how much is uncommitted would mean reading agent-written data. That stays informational only, through hardened git.
- **Contract digest changes.** The terminal and console ship together, but an older workbench against a newer console must fail plainly.
- **The new tables:** `flexible_thread_meta`, `flexible_stop_request` and `flexible_turn_dispatch` need the update-safe migration list (store.ts:2313).

## v3 (Codex round 2, final; built on branch threads-everyday)

- **D1: one laptop predicate, read at every step that acts on it** (flexible-laptop.ts laptopShipProblem): local mode on
  for the owner at the consent's local generation, no active account with a password, no identity-provider sign-in
  linked, a solo install, the owner the only approver. A second account getting a password (store.ts saveApprover) or a
  linked SSO identity moves no generation of the owner's, so it is read directly: in the consent transaction, in the
  seal's transaction (fileAndSeal and approve()'s ship-thread branch), and in the armed completion and merge-reservation
  transactions (authorityProblem). When it fails the Ship is cancelled for good; reverting the settings revives nothing.
  The consent is recorded in flexible_ship_laptop (written once), bound to the local and account generations.
- **Locality is already shipped**: server/guards.ts refuses every local-owner cookie request unless requestFromThisComputer
  accepts it (0.9.104). The Ship door relies on it; one test shows a forwarded request is refused.
- **D2**: proveAccountNow intercepts the four named acts BEFORE the generic local-owner success; an empty or wrong password
  never falls back to it; settings.ts no longer refuses every non-full session for the sign-in save.
- **Schema**: the tables are v174 (task-loop's v173 merges first); the migration is self-contained.
- **Ship's terms** are answered by the same POST road without a key (like a thread's start card), not a separate GET.

## Changelog v2 against v1

- **D1 replaced.** v1 had "no local-owner Ship". v2 has a password-free local-owner road in the terminal, with a defined `ship-thread` act, ten checks and five safety flags. On installs with a password, Ship goes through a CLI hand-off with a password typed now (chosen over a terminal field, with reasons).
- **Codex 2.** `personNow` is replaced by a typed `ShipProof`. The proof is checked before the lock and again inside the consent transaction, before the import. Negative cases are listed.
- **Codex 1.** Threads' authority now ends through `revokeDerivedAuthority` (every generation move), sign-in removal and restore: retire, epoch, interrupt, withdraw, stop rows. Cross-process and in-process behaviour are tested separately.
- **Codex 3.** A durable `flexible_stop_request` row stays until the exit is verified. The dispatch-time epoch goes in `flexible_turn_dispatch`. `agent.turn` is no longer cleared on `turn-not-running`. The interrupt → result → replacement → tick test is added.
- **Codex 4.** One thread-lock boundary each for Reply (through the message hand-off) and Ship (through idle-stop and the press). Reply's admission re-reads the live session, billing and End.
- **Codex 5.** End is final, with an admission barrier in both admission and begin, an atomic withdraw, stop retries, a pending stop shown truthfully, no Send back, and its metadata separate from repository-removal state.
- **Codex 6.** `--check` keeps its proof. Solo narrowing re-reads mode and identity in the write. The root-cause wording is fixed (`config show flexible` already doesn't prompt).
- **D2.** Scoped per act: the closed list drops `ship-thread`, and there is no freshness or session upgrade.
- **D3.** Ready in Needs you (refined by the owner's placement decision above: until looked at once, then Recent).
- **D4.** Final End, 7-day tidy.
- **D5.** Plain status, off and clear without a password on solo installs.
- **D6.** A read-only browser list.
- **D7.** The fresh-agent words.
- **New migration content:** v174 now holds three tables.
- **Slices:** S5 (End) and S4 (Reply) are now security-sensitive.
