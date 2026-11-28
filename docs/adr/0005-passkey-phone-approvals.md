# Passkey-Backed Phone Approvals via Paired Devices

High-trust actions initiated from the native iOS companion app — approving a Task plan (`Approve`), accepting a result (`Accept`), landing onto a local branch (`Land`), and merging a pull request (`Ship`) — extend [ADR 0003](0003-browser-only-step-up-for-approvals.md) using WebAuthn Passkeys (`"passkey"` in `src/person-proof.ts`) verified locally by the Workspace inside each verb's existing transactional authority gate. This ADR explicitly unshelves the passkey ceremony deferred in `docs/plans/chat-management.md` (§7, *The phone-approval passkey plan*), while preserving its policy invariant: whenever a project or Workspace enables a *"Passkey required for approvals"* policy, `chat-code` approvals are also refused.

Paired devices connect on a dedicated `paired-device` identity over an end-to-end encrypted Noise `IKpsk2` channel and are **never** treated as local loopback requests (`src/public-access.ts:requestFromThisComputer`). Every high-trust action requires a fresh, single-use, verb-specific server challenge bound to the exact target and digest (`Approve`, `Accept`, `Land`, and `Ship` each carry distinct canonical challenge payloads and human-readable wording so one assertion can never stand in for another).

## Per-Verb Wiring & Transactional Authority

Each verb routes into its real domain function rather than a parallel ledger writer:

1. **`Approve` (`src/scope.ts:approve`)**: Extend `approve()` with an optional `passkey` proof input (parallel to `chat?`). Inside `store.transact()`: re-verify account standing (`approver` role, `accountCanAccess`, non-revoked) and active `paired-device` standing (`recoveryGeneration`), verify the WebAuthn assertion against a registered credential owned by `by`, atomically consume the single-use `approve` challenge bound to `(taskId, sawDigest, deviceId, credentialId)`, run every existing check (scope digest, release hold, CI hold, separation-of-duties votes, org policy), write the structured `APPROVAL_PROOF` row (`outcome: "passkey"`), and seal under basis `"password"`.
2. **`Accept` (`src/assignment.ts:acceptAndCompleteAsOperator`, with `completeAndOpenPullRequest` when publishing)**: Inside its `store.transact(() => store.savepoint(...))`, verify `VerifiedApprover` standing, active `paired-device` standing, and the WebAuthn assertion; atomically consume the single-use `accept` challenge bound to `(taskId, runId, receiptDigest, noteHash, publish, deviceId, credentialId)`; record a structured `passkey` proof row (`action: "accept proved"`, `outcome: "passkey"`) alongside `store.acceptProof(...)`, `ACCEPT_ACTION`, and `finish(digest)`.
3. **`Land` (`src/local-landing.ts:land`)**: Extend `LandAuthority` (`src/local-landing.ts:68`) with `{ kind: "passkey"; who: VerifiedApprover; proof: PasskeyLandProof }`. Verify the WebAuthn assertion before running hardened git preparation, then atomically consume the single-use `land` challenge bound to `(taskId, plan.key, into, undo, deviceId, credentialId)`, re-verify account/device standing in `stillStands()`, and write the structured `passkey` proof row inside the same `store.transact()` that records `LAND_INTENT` or `LAND_HANDOFF`.
4. **`Ship` / Merge PR (`src/pull-request-flow.ts:mergeAsPerson`)**: Extend `mergeAsPerson()` to accept either password auth or a verified passkey assertion. Before executing `gh pr merge` (after `mergePullRequest`'s existing release/Flexible/archive guards), atomically consume the single-use `ship` challenge bound to `(runId, taskId, prNumber, headSha, method, anyway, deviceId, credentialId)`, re-verify account/device/project standing, and record the structured `passkey` proof row (`action: "merge proved"`, `outcome: "passkey"`) in the reservation transaction.

## WebAuthn Verification Rules & Honest Attribution

Apple's Associated Domain (`webcredentials:toolroll.dev`) only permits the iOS app to invoke `ASAuthorizationController` for `toolroll.dev`; it performs no verification. The Mac daemon verifies every registration and assertion locally:

- **Unique `user.id` per `(workspaceId, accountName)`:** Because every Mac shares `rp.id = "toolroll.dev"` and Apple replaces an existing passkey if the same `(rpId, user.id)` registers again, the Mac derives an opaque 32-byte `userHandle`:
  `user.id = SHA-256("toolroll-passkey-user-v1\0" || utf8(workspaceId) || "\0" || utf8(accountName))`.
  Each Mac/workspace therefore gets its own distinct passkey entry in iCloud Keychain without overwriting another Mac's credential.
- **Registration (explicit signed-in Mac act after pairing confirmation):**
  - Server issues a 32-byte random registration challenge (`TTL 120s`, single-use), stored with `(challenge, workspaceId, accountName, deviceId, recoveryGeneration, expiresAt)`, and returns creation options: `rp: { id: "toolroll.dev", name: "Toolroll" }`, `user: { id: userHandle, name: accountName, displayName: workspaceLabel }`, `pubKeyCredParams: [{ type: "public-key", alg: -7 }]` (ES256 / P-256 only), `authenticatorSelection: { residentKey: "required", userVerification: "required" }`, `attestation: "none"`.
  - Verification inside `store.transact()`:
    1. Load the pending registration challenge and verify it exists, **is not expired**, has not been consumed, and matches the authenticated session's `(workspaceId, accountName, deviceId, recoveryGeneration)`.
    2. Verify `clientDataJSON.type === "webauthn.create"`, **constant-time compare `clientDataJSON.challenge` against the issued registration challenge**, verify `clientDataJSON.origin === "https://toolroll.dev"`, and verify `authData.rpIdHash === SHA-256("toolroll.dev")`.
    3. Verify flags **`UP=1`**, **`UV=1`**, **`AT=1`**, and a valid on-curve P-256 COSE public key (`kty: 2`, `alg: -7`, `crv: 1`).
    4. Verify **`credentialId` is brand new** (reject if `credentialId` already exists in `account_passkeys`).
    5. **Atomically consume the registration challenge** and insert `{ credentialId, workspaceId, accountName, userHandle, publicKeySpki, signCount, createdAt, recoveryGeneration }` into `account_passkeys` (separate from `paired_devices`).
- **Assertion:**
  - Server MUST send `allowCredentials` listing only the active `credentialId`(s) registered for `(workspaceId, accountName)` on this Mac (preventing ambiguity when a user pairs multiple Macs under `toolroll.dev`).
  - Verification: `clientDataJSON.type === "webauthn.get"`, `clientDataJSON.challenge === base64url(SHA-256(canonicalActionChallenge))`, `clientDataJSON.origin === "https://toolroll.dev"`, `authData.rpIdHash === SHA-256("toolroll.dev")`, flags **`UP=1` AND `UV=1`**, `response.userHandle` matches the stored `userHandle` for `(workspaceId, accountName)` (required for our resident credentials), valid ECDSA-SHA256 signature over `authData || SHA-256(clientDataJSON)`, and `signCount` policy: accept `0 → 0` (standard for Apple synced passkeys), otherwise require strictly increasing `newSignCount > storedSignCount` and persist the new count.
- **Honest wording & threat limits:** iOS passkeys sync via iCloud Keychain and carry `attestation: "none"`, so `UV=1` proves only that **a passkey registered to this account reported user verification** — NOT that the key is non-exportable hardware on one specific phone, and NOT that biometrics were used (iOS `UV=1` also accepts the device passcode, so someone who observed the passcode can satisfy `UV=1`). Proof rows record the passkey credential and the transport `pairedDeviceId` separately: `{ v: 1, at, generation, digest, verb, cred, deviceId, uv: true, be, bs }`, and audit wording states *"Passkey user verification"*, never *"Face ID"* or *"hardware-proven phone"*.

## Tiered Passkey Freshness Window (Mirroring Mac `FRESH_WINDOW_MS`)

To avoid prompting Face ID / Passkey repeatedly when triaging routine work while keeping high-impact acts strictly per-ceremony, a Workspace configures a fixed **Approval prompt window** in Mac `Settings → Phone` (`Every time [0]` · `15 minutes [15, default]` · `1 hour [60]`):

- **Eligible inside the window (`outcome: "passkey-fresh"`):**
  - Routine **`Approve`** that satisfies `scope.ts:freshlyApprovable` (single approver, standard permissions, non-protected, non-release, not quarantined).
  - Clean **`Accept`** with no exception owed (`owedAcceptance !== "exception"`), non-protected result, and `publish === false`.
- **Never cached (always requires a live WebAuthn assertion right now):**
  - **`Ship`** (merge PR) and **`Land`** (mutate local branch) — compile-time and runtime restricted to live assertions only.
  - Protected scopes, escalated terms, release scopes, quarantined filings, second-approver votes, exception accepts, and `Accept + Open PR`.
- **In-memory session binding & immediate invalidation:**
  - The freshness lease lives **in memory only on the Mac daemon**, bound to `(deviceId, accountName, credentialId, accountGeneration, recoveryGeneration)` for a fixed span (never extended by use).
  - Immediately cleared on `passkey.lock` (*Lock approvals now* in iOS Settings), passkey revocation, tightening/disabling the window on Mac, device unpair, password change, backup restore, or daemon restart.
  - Audit rows honestly record `outcome: "passkey-fresh"` with `provedAt` (the original Passkey assertion timestamp) and `"summary": "Passkey session window"`.

## Considered Options

- **Custom raw keypair signing ceremony (non-WebAuthn)**: Duplicates WebAuthn challenge/origin/counter semantics, cannot hardware-back X25519 keys in Secure Enclave (P-256 only), and creates a second approval ceremony beside `"passkey"` in `src/person-proof.ts`.
- **In-app system browser sheet (`ASWebAuthenticationSession`) for every approval**: Keeps ADR 0003 unchanged, but requires every user's Mac to expose a publicly reachable HTTPS origin or forces a web redirect on every pocket decision.
- **Re-use the paired connection's Noise session key for approvals**: Collapses read/steer access and irreversible approval authority into one session key.

## Consequences

- Every user's Mac verifies passkeys bound to `rpId: "toolroll.dev"` with zero per-Mac HTTPS certificates.
- **Shared trust root & forks:** For official builds, `toolroll.dev` (AASA file + default hosted relay/push forwarder) and the official Apple Team ID form a single trust root for official app signing, `webcredentials:toolroll.dev` passkey association, and APNs delivery (though a compromised AASA alone still lacks a Workspace's pinned `macStaticPub`, `devicePsk`, `deviceRelayPriv`, and registered `credentialId`). Because Apple binds `webcredentials` and APNs `.p8` keys to a specific Team ID + Bundle ID, forks compiled under a different Apple Team ID cannot use official `toolroll.dev` passkeys or official APNs push and must configure their own Apple Team ID, AASA domain, RP ID, and APNs key. *(Apple's rules do not prevent a fork from connecting to the official WebSocket relay; whether forks are permitted there is solely governed by the relay operator's admission policy.)*
- Per [ADR 0001](0001-retire-all-credentials-on-restore.md), restoring a Workspace from backup unconditionally retires all `paired_devices`, `account_passkeys`, active Noise sessions, push subscriptions, and pending challenges.
- Over-the-air code updates (JS/bundle hot-patching) are prohibited on builds that can approve; approval UI ships exclusively inside signed App Store / TestFlight native binaries.
