# Companion Phone App — Threat Model, Identity & Route Allowlist

**Status:** Design spec (pre-build, revised after independent security review)  
**Target client:** Native iOS SwiftUI app (sharing `mac/Sources/ToolrollCore`; Android deferred past V1)  
**Related ADRs:** [0001](../../adr/0001-retire-all-credentials-on-restore.md), [0002](../../adr/0002-quarantined-git-objects-for-candidates.md), [0003](../../adr/0003-browser-only-step-up-for-approvals.md), [0004](../../adr/0004-truthful-custody-on-disconnect-and-heartbeat-loss.md), [0005](../../adr/0005-passkey-phone-approvals.md)

---

## 1. Security Invariants (Non-Negotiable)

1. **The Mac/Workspace remains the sole authority.** The relay can never read payloads, forge identities, or authorize any act.
2. **No loopback spoofing (`src/public-access.ts:122`).** Decrypted phone RPC frames are **never** forwarded as HTTP requests to `127.0.0.1` / `localhost`. A phone connection receives a dedicated **`paired-device`** principal bound directly at the decrypted Noise session layer (`deviceId`, `accountName`, `workspaceId`, `recoveryGeneration`). `requestFromThisComputer()` is unconditionally `false` for all paired-device calls, even on the same Wi-Fi, and local-owner shortcuts (including `POST /login/once` in `src/server/link-redemption.ts:42`) are unreachable.
3. **Explicit RPC allowlist, default-deny.** Modeled on `REMOTE_TUI_READ_ROUTES` (`src/terminal-connection.ts:25`), every operation reachable by a paired device must be explicitly named in a static allowlist table with its Gate, role check, and idempotency contract.
4. **Live Terminals are completely blocked in V1.** Neither `/term/*` nor any indirect PTY/shell path is exposed over the paired-device RPC surface.
5. **Real transactional gates per verb (ADR 0005).** Passkey proofs enter Toolroll's real transactional functions — `src/scope.ts:approve()`, `src/assignment.ts:acceptAndCompleteAsOperator()`, `src/local-landing.ts:land()`, and `src/pull-request-flow.ts:mergeAsPerson()` — never via a parallel ledger write path.
6. **Honest passkey & device attribution.** iOS passkeys sync through iCloud Keychain with `attestation: "none"`, and `UV=1` accepts the device passcode as fallback. The server records `account_passkeys` (`credentialId`, `userHandle`) and `paired_devices` (`deviceId`) separately and logs only what was verified (*"Passkey user verification via paired device `<deviceId>`"*), never *"Face ID"* and never claiming non-exportable hardware binding to one physical phone.
7. **Honest privacy & trust-root claims.**
   - **Relay visibility:** The relay cannot read RPC content or authorize anything, **but** it observes IP addresses, opaque machine/device routing IDs, timing, and ciphertext sizes, and can drop or delay frames.
   - **Push visibility:** APNs and the push relay observe badge counts, opaque collapse/routing IDs, timing, and ciphertext sizes in the clear; only the encrypted payload inside `tr.c` is end-to-end encrypted. Task titles and summaries remain off-push by default (`src/push.ts:8-11`) unless explicitly opted in.
   - **Official trust root & forks:** For official builds, `toolroll.dev` (AASA + default relay/push forwarder) and the official Apple Team ID control app distribution, `webcredentials:toolroll.dev` passkey association, and APNs push delivery. Due to Apple platform rules, forks compiled under another Apple Team ID cannot use official `toolroll.dev` passkeys or official APNs push and must run their own Team ID, AASA domain, RP ID, and APNs key. *(Apple's rules do not block forks from using the official WebSocket relay; access to the hosted relay is governed strictly by the relay operator's admission policy.)*
8. **Truthful disconnected state (ADR 0004).** Losing contact with the relay or daemon proves only unreachability, never sleep or shutdown. The app shows **`Unavailable · last seen <time>`**, marks cached views explicitly as stale, and **never queues approvals or mutations offline**.
9. **Unconditional retirement on backup restore (ADR 0001).** Backup restore advances `recoveryGeneration` and wipes all `paired_devices` (including `device_psk` and `phoneStaticPub`), `account_passkeys`, `device_push_tokens`, and pending challenges.
10. **No OTA code updates.** Approval-capable builds ship only as signed App Store / TestFlight native Swift binaries (no JS/bundle hot-patching).
11. **Chat-management policy compatibility.** Per `docs/plans/chat-management.md` (§7, line 918), if a Workspace or project enables a *"Passkey required for approvals"* policy, `chat-code` approvals are refused as well.

---

## 2. Threat Model

| Threat | Attack Vector | Mitigation |
|---|---|---|
| **Loopback privilege escalation** | Relay frame injected into local HTTP server passes `requestFromThisComputer()` and acts as local owner or redeems `/login/once`. | Decrypted RPC dispatches directly into typed domain handlers with `PairedDevicePrincipal`; never touches HTTP loopback socket or local-owner middleware. |
| **QR photo race & lookalike device name** | Bystander photographs Mac screen QR, races the owner to finish handshake first, and sends a plausible device name (e.g., *"Work iPhone"*). | Pairing starts from a signed-in Mac act and displays a 6-char transcript confirmation code (`h`). **Any second pairing handshake for the same `pairSessionId` immediately aborts the entire pairing session** and purges `pairPsk` + `pairConnToken`. The Mac UI explicitly instructs the owner to click Confirm **only if their own phone displays the exact same code** (if someone else raced first, the owner's phone shows no code). Self-reported `deviceName` is untrusted display text only, never a trust signal. |
| **Compromised or malicious relay** | Relay inspects payloads, hijacks daemon slot, swaps Mac public key during migration, replays message 1, or floods frames. | `Noise_IKpsk2_25519_ChaChaPoly_SHA256` E2EE; `role=daemon` requires Ed25519 signature by `relayMachinePriv`; `machineId` is deterministically derived from `relayMachinePub`; `macStaticPub` is pinned independently of `relayUrl`; daemon never acts on handshake message 1; monotonic 64-bit byte-encoded nonces with `2^64-1` refusal + rekey; server rejects unknown/revoked `deviceId` regardless of relay forwarding. |
| **Relay DoS / billing exhaustion** | Unauthenticated attackers open millions of WebSockets to random `machineId`s. | Pre-upgrade Ed25519-signed connection tokens (`role=daemon`, `role=pair`, `role=device`, 5-min TTL), strict per-IP/per-machine rate & byte limits, 5-second first-frame deadline on the relay + 5-second Noise completion deadline on the daemon, 65,535-byte Noise message cap, max 4 phone sockets per machine, and global spend cutoff. |
| **Cross-action approval replay** | Signed WebAuthn assertion for `Approve` replayed against `Ship` or a modified scope/commit. | Fresh single-use server challenge bound to `{ verb, workspaceId, recoveryGeneration, taskId, runId?, exactDigestOrKey, deviceId, credentialId?, nonce, expiresAt }`. Distinct canonical structure and human-readable wording per verb (`approve`, `accept`, `land`, `ship`). Consumed atomically inside each verb's transaction. |
| **Passkey registration replay / cross-Mac overwrite** | Replaying an old `webauthn.create` response in a later enrollment window, or a second Mac overwriting the first Mac's passkey under `toolroll.dev`. | Registration verifies & atomically consumes a fresh 120s challenge bound to `(workspaceId, accountName, deviceId, recoveryGeneration)`, requires `credentialId` to be brand new, and assigns a unique opaque `user.id = SHA-256("toolroll-passkey-user-v1\0" || workspaceId || "\0" || accountName)` verified via `userHandle` on every assertion. |
| **Passcode shoulder-surfing / synced passkey** | Attacker observes user's iOS passcode and holds phone, or uses another iCloud-synced Apple device. | `UV=1` is necessary for high-trust acts, **and** transport requires the phone's `ThisDeviceOnly` Noise static key + `devicePsk` (not synced to iCloud). Owner can immediately revoke either the paired device (`toolroll devices revoke <id>`) or the passkey credential independently. |
| **Zombie device after restore** | Restoring a week-old backup resurrects a lost/revoked phone (or exposes `device_psk` backed up in SQLite). | ADR 0001 unconditional wipe of `paired_devices`, `account_passkeys`, `device_push_tokens`, and `device_challenges` on restore, plus `recoveryGeneration` mixed into the Noise prologue so old sessions fail handshake cryptographically. |
| **Duplicate / ambiguous execution on flaky 5G** | Phone retries `Accept`, `Land`, or `Ship` after timeout, or reuses an idempotency key with a different payload. | Every mutation RPC requires a client-generated `idempotencyKey` (UUIDv4) tracked in SQLite (`device_idempotency`) with `requestHash` binding and explicit `in_flight` / `completed` / `unknown` states (Section 3). |
| **Slow mobile client OOMing daemon** | Phone opens streams on slow LTE and stops reading, or floods concurrent stream IDs. | Max 8 concurrent streams per phone, max 1 MiB total buffered bytes per phone (4 MiB daemon-wide), per-stream credit window, response chunks wait for credit (never dropped) up to 30s deadline, live watch records cap at 32 records / 256 KiB with `{ k: "cut" }`, and `CANCEL` stops watching only. |

---

## 3. Explicit V1 RPC Allowlist (`PAIRED_DEVICE_ROUTES`)

All methods bind `workspaceId`, `deviceId`, and `recoveryGeneration` in the Noise prologue at session open and re-check device non-revocation + account standing + project access (`store.accountCanAccess`) on every call.

### Gate 1 — Read-Only Pilot Allowlist

| RPC Method | Real Domain Backing | Access Rule | Notes |
|---|---|---|---|
| `device.hello` | `engine/hello` + workspace identity | Active paired device | First transport RPC (key confirmation); returns `workspaceId`, `recoveryGeneration`, contract digest, and account role. |
| `work.rows` | Shared data helper extracted from `workRows` (`src/server/pages.ts:1506`) | Account-admitted projects | Needs You groups (`Decide`, `Review`, `Unblock`) + task rows. |
| `task.steps` | `stepCardsOf` (`src/engine-reads.ts:67`) | Task project admitted | Step cards, merge checklist, status, check summary. |
| `task.diff` | `taskDiff` domain reader (`src/server/engine-api.ts:477`) | Task project admitted | Paginated file list + per-file hunks/context; respects sealed-patch redaction & byte caps; chunked across ≤60,000 B frames (max 1 MiB per response). |
| `task.approval.read` | Pure read helper: `taskViewData(..., { mintNonce: false })` + `approvalTermsOf(...)` | Task project admitted | **Strictly read-only** — does **not** call `GET /t/<task>/approval` (which mints browser nonces and requires a terminal-keyed cookie session, `src/server/engine-api.ts:423`). Returns `{ task, key, digest, terms, problem }`. |
| `run.window.read` | `readRunLive` (`src/server/engine-api.ts:78`, returning `liveSessionWindow`) | Task project admitted | Cursor-paginated JSON window (`file`, `cursor`) — exact match to `GET /agents/live/run/<id>`. |
| `run.watch.subscribe` | Daemon-side tail adapter over `readRunLive` | Task project admitted | Optional push stream of window deltas using `CHUNK` + `CREDIT` + `END`/`ERROR`; `CANCEL` stops watching only (never stops the run). |
| `push.register` | Device push subscription store | Same paired device | Registers `{ apnsToken, p256dh, authSecret }` (65-byte P-256 point + 16-byte RFC 8291 auth secret for `encryptPushPayload`, `src/push.ts:154`). |
| `device.self.revoke` | Paired device retirement | Same paired device | Allows clean *"Unpair this phone"* from the iOS app. |

### Gate 2 — Passkey Registration, Approvals & Actions *(Unlocked ONLY after Gate 1 & Gate 2 Test Gates Pass)*

| RPC Method | Proof Required | Idempotency | Backing Code Path |
|---|---|---|---|
| `passkey.register.begin` / `.finish` | Active paired device (`approver` role) + explicit signed-in Mac consent window | Single-use challenge (120s) | Verifies & consumes registration challenge, checks expiry/binding/`origin`/`rpIdHash`/`UP=1`/`UV=1`/`AT=1`/ES256/new `credentialId`, writes `account_passkeys` with unique `userHandle`. |
| `approval.challenge` | Active paired device (`approver` role) | Single-use challenge (120s) | Mints verb-specific challenge (`approve \| accept \| land \| ship`) + `allowCredentials` for `(workspaceId, accountName)`. |
| `task.approve` | Fresh `passkey` assertion (`approve` challenge) | Required (`idempotencyKey`) | `src/scope.ts:approve()` with `passkey` input (`personProof("passkey") === true`), atomic challenge consume + proof + seal. |
| `task.accept` | Fresh `passkey` assertion (`accept` challenge) | Required | `src/assignment.ts:acceptAndCompleteAsOperator()` (+ `completeAndOpenPullRequest` if `publish: true`), atomic challenge consume + proof + acceptance + completion. |
| `task.land` | Fresh `passkey` assertion (`land` challenge) | Required | `src/local-landing.ts:land()` with `LandAuthority = { kind: "passkey", ... }`, atomic challenge consume + proof in `LAND_INTENT` / `LAND_HANDOFF` transaction. |
| `task.ship` | Fresh `passkey` assertion (`ship` challenge) | Required | `src/pull-request-flow.ts:mergeAsPerson()` with passkey auth, atomic challenge consume + proof before `gh pr merge`. |
| `task.revise` | Active paired device (`approver` role, no passkey) | Required | Send back with typed feedback note (never widens approved scope). |
| `run.steer` | Active paired device (`approver` role) | Required | Live pause / resume / steer note / stop via `Store.requestPause`, `Store.requestResume`, and `requestTaskStop` (`src/task-control.ts:138`). |
| `chat.send` | Active paired device (`approver` role) | Required | Sends message to Lead / Direct Chat (never self-approves any proposal). |

### Mutation Idempotency State Machine (`device_idempotency`)
Every Gate 2 mutation RPC stores `(deviceId, idempotencyKey, method, requestHash, state, outcomeJson, updatedAt)` where `requestHash = SHA-256(canonicalParamsJson)`:
- **Conflict refusal:** Reusing an existing `(deviceId, idempotencyKey)` with a different `method` or `requestHash` is unconditionally rejected (`409 idempotency_key_conflict`).
- **`in_flight`:** Recorded before executing an async/external operation (`land`, `ship`); a retry arriving while `in_flight` returns `{ ok: false, code: "in_progress" }` and never starts a second execution.
- **`completed`:** Stores the deterministic outcome (`ok`, `result` / `error`); retries with matching `requestHash` return the stored outcome without re-executing.
- **`unknown`:** Recorded if the daemon crashes, restarts, or loses contact mid-external side effect before settlement; retries return `{ ok: false, code: "outcome_unknown" }` prompting the client to refresh state (ADR 0004 — never blindly re-runs an uncertain external mutation).
- **Startup reconciliation & retention:** On daemon startup, a sweep unconditionally transitions every lingering `in_flight` row to `unknown` (a crashed process can no longer settle it). Settled (`completed` and `unknown`) rows are pruned after **24 hours** (with a hard ceiling of 1,000 rows per paired device, evicting oldest settled rows first) so the table stays strictly bounded.

### Explicitly Blocked in V1
- `/term/*` (Live Terminals, PTY start/attach/input)
- `/login/once` (local-owner link redemption)
- `/settings/*` policy, credentials, password, auto-update, backup/restore, or device-enrollment mutations
- Arbitrary HTTP pass-through

---

## 4. Device Lifecycle Flows

- **Pair new phone:** Signed-in approver clicks *Pair iPhone* on Mac (or runs `toolroll phone pair`) → QR displayed with single-use `pairPsk` + `pairConnToken` → Phone scans QR & runs Noise `IKpsk2` pairing handshake → Any second handshake for the same `pairSessionId` immediately aborts the session → Both screens show 6-char confirmation code derived from handshake hash `h` → Mac prompts owner: *"Click Confirm ONLY if your own phone shows this exact code"* → Owner confirms on Mac → Mac sends `{ deviceId, recoveryGeneration, pskEntropy, pskVersion: 1 }`, registers `deviceRelayPub` on the relay, clears `pairPsk` → Active (Gate 1 read-only). In Gate 2, owner optionally completes Passkey enrollment during or after confirmation.
- **Lost phone:** Owner opens Settings → Devices on Mac (or `toolroll devices revoke <id>`) → Immediate SQLite revocation + active Noise session closed + relay device registration deleted + push token purged. Owner can also revoke the associated passkey credential independently if desired.
- **New phone:** Same pairing flow; old device remains independently revocable.
- **Backup restore:** All `paired_devices`, `account_passkeys`, `device_push_tokens`, `device_challenges`, and `device_idempotency` rows are wiped automatically and `recoveryGeneration` is incremented; old phone fails Noise prologue verification and prompts *"This Workspace was restored from a backup. Pair this iPhone again on your Mac."*

---

## 5. Mandatory Security Test Gates

### Gate 1 Security Gate *(Mandatory BEFORE shipping Read-Only Relay Pilot)*
Gate 1 exposes private task content, plans, and diffs to the phone, so transport, pairing, isolation, and resource-limit defenses MUST pass before Gate 1 ships:
1. **Cross-language Noise & protocol tests:** Both `vitest` and `swift test` pass `test/fixtures/companion-noise/vectors.json`; handshake message 1 executes zero RPCs; prologue mismatch (including `recoveryGeneration`) fails handshake; Noise 65,535-byte message cap enforced; bounded multi-chunk request/response reassembly verified; nonce `2^64-1` rejected; rekey/re-handshake threshold enforced.
2. **Pairing & race tests:** Second pairing handshake for the same `pairSessionId` aborts the entire session and invalidates `pairPsk` + `pairConnToken`; unconfirmed device refused all RPCs; wrong confirmation code or 5-min expiry purges session; untrusted `deviceName` control/bidi chars sanitized.
3. **Restore wipe tests (ADR 0001):** Restoring a backup deletes all `paired_devices`, `device_psk`, `device_push_tokens`, and fails old sessions via `recoveryGeneration` prologue mismatch.
4. **Revocation & loopback isolation tests:** Revoked device terminated mid-session and rejected at relay pre-upgrade; paired-device calls unconditionally have `requestFromThisComputer === false` and are refused on `/login/once`, `/term/*`, `/t/<task>/approval`, and non-allowlisted routes; cross-project reads return `404`.
5. **Slow-client & resource-limit tests:** Stalled phone trips per-stream credit window and 1 MiB session / 4 MiB global memory caps without blocking agents; unary response chunks wait for credit (never dropped) and cleanly fail with `deadline_exceeded` at 30s; live watch streams cap at 32 records / 256 KiB with `{ k: "cut" }`; stream ID reuse refused; concurrent stream cap (>8) refused; `CANCEL` stops watching only and never stops the underlying run.

### Gate 2 Security Gate *(Mandatory BEFORE enabling Passkey Approvals & Actions)*
6. **WebAuthn registration, verification & policy tests:** Rejects replayed/expired/wrong-binding registration challenges and duplicate `credentialId`s; verifies unique per-workspace `user.id` + `userHandle` check on assertion; rejects wrong `origin`, wrong `rpIdHash`, `UV=0`, `UP=0`, bad signature, non-monotonic non-zero `signCount`, missing `allowCredentials` match, expired/reused assertion challenge, and cross-verb replay (`approve` assertion submitted to `accept`/`land`/`ship`); verifies `0 → 0` synced passkey acceptance; verifies `chat-code` refusal under passkey-required policy; verifies backup restore wipes `account_passkeys`.
7. **Transactional verb, idempotency & uncertain-outcome tests (ADR 0004):** Each of `approve`, `accept`, `land`, and `ship` writes proof + action atomically in its real domain transaction and refuses stale digests/keys; tests all `device_idempotency` states (`in_flight`, `completed`, `unknown`) and `409 idempotency_key_conflict` on payload mismatch; offline phone never queues approvals.
