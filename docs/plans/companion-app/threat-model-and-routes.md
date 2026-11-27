# Companion Phone App — Threat Model, Identity & Route Allowlist

**Status:** Design spec (pre-build, for independent security review)  
**Target client:** Native iOS SwiftUI app (sharing `mac/Sources/ToolrollCore`; Android deferred past V1)  
**Related ADRs:** [0001](../../adr/0001-retire-all-credentials-on-restore.md), [0002](../../adr/0002-quarantined-git-objects-for-candidates.md), [0003](../../adr/0003-browser-only-step-up-for-approvals.md), [0004](../../adr/0004-truthful-custody-on-disconnect-and-heartbeat-loss.md), [0005](../../adr/0005-passkey-phone-approvals.md)

---

## 1. Security Invariants (Non-Negotiable)

1. **The Mac/Workspace remains the sole authority.** The relay can never read payloads, forge identities, or authorize any act.
2. **No loopback spoofing (`src/public-access.ts:122`).** Decrypted phone RPC frames are **never** forwarded as HTTP requests to `127.0.0.1` / `localhost`. A phone connection receives a dedicated **`paired-device`** principal bound directly at the decrypted Noise session layer (`deviceId`, `accountName`, `workspaceId`, `recoveryGeneration`). `requestFromThisComputer()` is unconditionally `false` for all paired-device calls, even on the same Wi-Fi, and local-owner shortcuts (including `POST /login/once` in `src/server/link-redemption.ts:42`) are unreachable.
3. **Explicit RPC allowlist, default-deny.** Modeled on `REMOTE_TUI_READ_ROUTES` (`src/terminal-connection.ts:25`), every operation reachable by a paired device must be explicitly named in a static allowlist table with its required Gate, role check, and idempotency contract.
4. **Live Terminals are completely blocked in V1.** Neither `/term/*` nor any indirect PTY/shell path is exposed over the paired-device RPC surface.
5. **Single approval gate (`src/scope.ts:1564`).** Passkey proofs enter Toolroll's existing transactional approval / acceptance / land / ship functions as an additional verified person proof (`personProof("passkey") === true`), never via a parallel ledger write path.
6. **Honest proof wording.** A modified client could theoretically use software keys or bypass local biometric UI; records state only what the server verified (*"user verified on a registered device"* / `uv: true`, `deviceId`, `credentialId`), never *"Face ID verified"*.
7. **Honest privacy claims.** The relay cannot read content or authorize anything, **but** it does observe IP addresses, opaque machine/device routing IDs, timing, and ciphertext sizes, and can drop or delay frames. Documentation and UI must state this accurately.
8. **Truthful disconnected state (ADR 0004).** Losing contact with the relay or daemon proves only unreachability, never sleep or shutdown. The app shows **`Unavailable · last seen <time>`**, marks cached views explicitly as stale, and **never queues approvals or mutations offline**.
9. **Unconditional retirement on backup restore (ADR 0001).** Backup restore advances `recoveryGeneration` and deletes/retires all paired devices, Noise static peer records, passkey credentials, push subscriptions, and pending approval challenges.
10. **No OTA code updates.** Approval-capable builds ship only as signed App Store / TestFlight native Swift binaries (no JS/bundle hot-patching).

---

## 2. Threat Model

| Threat | Attack Vector | Mitigation |
|---|---|---|
| **Loopback privilege escalation** | Relay frame injected into local HTTP server passes `requestFromThisComputer()` and acts as local owner or redeems `/login/once`. | Decrypted RPC dispatches directly into typed domain handlers with `PairedDevicePrincipal`; never touches HTTP loopback socket or local-owner middleware. |
| **QR photo race during pairing** | Bystander photographs Mac screen QR and races the owner to complete pairing first. | Pairing starts from a signed-in Mac act, displays a short 6-character visual confirmation code on both Mac and Phone, and the device remains untrusted until the owner explicitly confirms the match on the Mac (same pattern as `src/telegram.ts:5`). |
| **Compromised or malicious relay** | Relay inspects payloads, swaps Mac public key during migration, replays message 1, or floods frames. | Noise `IKpsk2` end-to-end encryption; Mac static public key pinned independently of relay URL; daemon never executes RPCs on Noise handshake message 1; monotonic 64-bit byte-encoded nonces; server rejects unknown/revoked `deviceId` regardless of relay forwarding. |
| **Relay DoS / billing exhaustion** | Unauthenticated attackers open millions of WebSockets to random `machineId`s. | Relay requires pre-registered `machineId` + short-lived signed connection token before WebSocket upgrade, strict per-IP/per-machine rate limits, 5-second Noise handshake deadline, 256 KB max frame size, and a global Cloudflare spend cutoff. |
| **Cross-action approval replay** | Signed approval for `Approve` replayed against `Ship` or a modified scope. | Fresh single-use server challenge bound to `{ actionVerb, taskId, runId?, exactDigest, deviceId, recoveryGeneration, expiresAt }`. Distinct human-readable challenge wording per verb (`Approve`, `Accept`, `Land`, `Ship`). Consumed atomically inside `store.transact()`. |
| **Zombie device after restore** | Restoring a week-old backup resurrects a lost/revoked phone. | ADR 0001 unconditional wipe of `paired_devices`, `device_passkeys`, `device_push_tokens`, and `device_challenges` on restore, plus `recoveryGeneration` check on every Noise session open. |
| **Stolen unlocked phone** | Attacker holds phone while unlocked. | High-trust acts require WebAuthn Passkey with `userVerification: "required"` (`UV=1`) at the OS hardware boundary; owner can revoke device in Settings → Devices or run `toolroll devices revoke <id>` from the Mac, taking effect immediately on active sessions. |
| **Duplicate execution on flaky 5G** | Phone retries `Accept` or `Send back` after timeout while first request succeeded. | Every mutation RPC requires a client-generated `idempotencyKey` (UUIDv4), deduplicated transactionally against the device + action record. |
| **Slow mobile client OOMing daemon** | Phone opens live log stream on slow LTE and stops reading. | Per-stream bounded credit window + backpressure drop/coalesce policy; stream cancel RPC means *"stop watching"*, never *"stop the agent run"*. |

---

## 3. Explicit V1 RPC Allowlist (`PAIRED_DEVICE_ROUTES`)

All methods carry `workspaceId` and `recoveryGeneration` verification at session open and re-check device non-revocation + account project access (`store.accountCanAccess`) on every call.

### Gate 1 — Read-Only Pilot Allowlist
| RPC Method | Domain Backing | Access Rule | Notes |
|---|---|---|---|
| `device.hello` | `engine/hello` + workspace identity | Paired device | Verifies `workspaceId`, `recoveryGeneration`, contract digest, and device standing. |
| `work.rows` | `GET /work/rows` (`engine-api.ts`) | Account-admitted projects | Needs You groups (`Decide`, `Review`, `Unblock`) + task rows. |
| `task.steps` | `GET /t/<task>/steps` | Task project admitted | Step cards, merge checklist, status, check summary. |
| `task.diff` | `GET /t/<task>/diff` (file list + per-file hunks/context) | Task project admitted | Paginated per file; respects existing sealed-patch redaction & byte caps. |
| `task.approval.read` | `GET /t/<task>/approval` | Task project admitted | Read-only view of exact scope/terms/digest awaiting approval. |
| `run.watch.subscribe` | `agents/live/run/<id>` stream | Task project admitted | Sequenced stream with flow control; `run.watch.cancel` stops watching only. |
| `push.register` | Device E2EE push key + APNs token | Same paired device | Registers P-256 public key for RFC 8291 E2EE push + opaque APNs token. |
| `device.self.revoke` | Paired device retirement | Same paired device | Allows clean "Unpair this phone" from the iOS app. |

### Gate 2 — Action & Approval Allowlist *(Unlocked ONLY after Section 5 Test Gates Pass)*
| RPC Method | Proof Required | Idempotency | Backing Gate |
|---|---|---|---|
| `approval.challenge` | Paired device (`approver` role) | N/A (single-use TTL 120s) | Issues action-specific WebAuthn challenge for `approve \| accept \| land \| ship`. |
| `task.approve` | Fresh `passkey` assertion (`approve` challenge) | Required (`idempotencyKey`) | `src/scope.ts:approve()` with `personProof("passkey")`. |
| `task.accept` | Fresh `passkey` assertion (`accept` challenge) | Required | Existing result acceptance gate (`Accept` / `Mark complete`). |
| `task.land` | Fresh `passkey` assertion (`land` challenge) | Required | Existing `local-landing.ts` gate. |
| `task.ship` | Fresh `passkey` assertion (`ship` challenge) | Required | Existing PR ship/merge gate. |
| `task.revise` | Paired device (`approver` role, no passkey) | Required | Send back with typed feedback note (never widens approved scope). |
| `run.steer` | Paired device (`approver` role) | Required | Sends live steer note / pause / stop to running attempt. |
| `chat.send` | Paired device (`approver` role) | Required | Sends a message to Lead / Direct Chat (cannot self-approve any proposal). |

### Explicitly Blocked in V1
- `/term/*` (Live Terminals, PTY start/attach/input)
- `/login/once` (local-owner link redemption)
- `/settings/*` policy, credentials, password, auto-update, backup/restore, or device-enrollment mutations
- Arbitrary HTTP pass-through

---

## 4. Device Lifecycle Flows

- **Pair new phone:** Signed-in approver clicks *Pair iPhone* on Mac (or runs `toolroll phone pair`) → QR displayed → Phone scans QR & runs Noise `IKpsk2` pairing handshake → Both screens show 6-char confirmation code derived from handshake transcript hash (`h`) → Owner clicks *Confirm match* on Mac → Phone enrols WebAuthn Passkey → Active.
- **Lost phone:** Owner opens Settings → Devices on Mac (or `toolroll devices revoke <id>`) → Immediate SQLite revocation + active Noise session closed + push token purged.
- **New phone:** Same flow as pairing; old device stays independently revocable.
- **Backup restore:** All paired devices wiped automatically; phone receives `session_retired_restore` (or handshake rejection) and prompts *"This Workspace was restored from a backup. Pair this iPhone again on your Mac."*

---

## 5. Mandatory Test Gates Before Unlocking Gate 2

No Gate 2 mutation RPC may be enabled in production until automated tests pass for all five categories:
1. **Pairing & race tests:** QR photo stolen before Mac confirmation fails closed; wrong confirmation code aborts and purges pending pair; expired `pairSecret` rejected.
2. **Restore wipe tests (ADR 0001):** Restoring a backup immediately invalidates previously paired Noise keys, passkey credentials, pending challenges, and push tokens.
3. **Revocation & loopback isolation tests:** Revoked device is rejected mid-session; paired-device calls always have `requestFromThisComputer === false` and are refused on `/login/once`, `/term/*`, and non-allowlisted routes; cross-verb passkey replay (`approve` assertion submitted to `ship`) is rejected.
4. **Slow-client & flow-control tests:** Stalled phone stream trips credit window without growing daemon memory or blocking the agent; `run.watch.cancel` never stops the underlying run.
5. **Uncertain-outcome & idempotency tests (ADR 0004):** Disconnect mid-mutation leaves honest uncertain state; retry with identical `idempotencyKey` executes exactly once; offline phone never queues approvals.
