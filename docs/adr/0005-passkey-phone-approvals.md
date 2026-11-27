# Passkey-Backed Phone Approvals via Paired Devices

High-trust actions initiated from the native iOS companion app — approving a Task plan (`Approve`), accepting a result (`Accept`), landing onto a local branch (`Land`), and shipping/merging a pull request (`Ship`) — extend [ADR 0003](0003-browser-only-step-up-for-approvals.md) using WebAuthn Passkeys (`"passkey"` in `src/person-proof.ts`) bound to an explicitly paired device and verified locally by the Workspace inside the existing transactional approval gate (`src/scope.ts:approve()`).

Paired devices authenticate on their own `paired-device` identity over an end-to-end encrypted channel and are **never** treated as local loopback requests (`src/public-access.ts:requestFromThisComputer`). Every high-trust action requires a fresh, single-use, action-specific server challenge naming the exact action verb, target, and scope/result digest (`Approve`, `Accept`, `Land`, and `Ship` each carry distinct signed wording so one approval can never stand in for another). The server verifies the WebAuthn P-256 assertion (with `UV=1` user verification) against the registered device credential inside the approval transaction, records structured proof `{ v: 1, at, generation, digest, deviceId, credentialId, uv: true }` with `personProof("passkey") === true`, and seals under basis `"password"`. What is recorded is strictly what was proven (*"user verified on a registered device"*), never an unprovable claim such as *"Face ID"*.

## Considered Options

- **Custom raw keypair signing ceremony (non-WebAuthn)**: Duplicates WebAuthn challenge/origin/counter semantics, cannot hardware-back X25519 keys on Apple Secure Enclave (P-256 only), and adds bespoke verification code beside the already-reserved `passkey` proof in `src/person-proof.ts`.
- **In-app system browser sheet (`ASWebAuthenticationSession`) for every approval**: Keeps ADR 0003 unchanged, but requires every user's Mac to expose an HTTPS origin reachable by the system browser sheet or forces a desktop-like web redirect on every pocket decision.
- **Re-use the paired connection's bearer/session key for approvals**: Collapses read/steer access and irreversible approval authority into one long-lived session key; a stolen unlocked phone or hijacked session could silently approve or ship work.

## Consequences

- Every user's Mac verifies passkeys created against the app's Associated Domain (`webcredentials:toolroll.dev`) with zero per-Mac HTTPS certificate required.
- All existing checks inside `approve()` — scope digest binding, protected-work separation of duties, release holds, organisation policy, and single-transaction proof writing — remain the single source of truth.
- Per [ADR 0001](0001-retire-all-credentials-on-restore.md), restoring a Workspace from backup unconditionally retires all paired devices, active encrypted sessions, passkey registrations, and pending approval challenges.
- Over-the-air JS/code updates are prohibited on builds that can approve; approval UI ships exclusively inside signed App Store / TestFlight binaries.
