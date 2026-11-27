# Companion Phone App — App Store Review & Distribution Compliance Plan

**Status:** Design spec (pre-build, revised after independent review)  
**Target distribution:** Apple TestFlight → iOS App Store (native SwiftUI, iOS 17+)

---

## 1. App Positioning & Key App Store Review Risks

| Apple Guideline / Requirement | Risk for Toolroll Companion | Concrete Mitigation |
|---|---|---|
| **Category Positioning (Avoid Guideline 4.2.7 Remote Desktop)** | **Guideline 4.2.7 applies to remote-desktop clients that mirror specific software running on a host device, and 4.2.7(a) requires both host and client to be connected on a local, LAN-based network.** Because Toolroll Companion connects over an internet relay, falling into 4.2.7 would violate 4.2.7(a). | In App Review, our position is that Toolroll Companion is a **native client for the user's own Toolroll developer service** (viewing task status, reviewing code diffs, sending text feedback, and authorizing build/merge actions via typed API/RPC — not a remote-desktop client mirroring host software). To keep this distinction clean, V1 strictly excludes screen mirroring, remote desktop streaming, and live PTY/terminals. |
| **Guideline 2.5.2 (No Downloaded Executable Code)** | Dynamic JS/OTA code pushes that alter approval UI or app behavior risk rejection and undermine security. | **Native SwiftUI only** — zero Expo OTA / CodePush / dynamic script loading. All UI and crypto ship inside the signed App Store binary. |
| **Guideline 2.1 (App Completeness & Reviewer Login)** | Reviewers cannot pair a Mac running local CLI tools during a 5-minute App Review session. | Ship a **built-in Demo Mode** (matching `toolroll demo` — zero network calls, zero model calls, local Swift fixtures in `ToolrollCore/DemoFixtures.swift`) accessible from a quiet *"Try Demo Workspace"* button on the Welcome/Pairing screen, AND provide clear App Review notes + short screencast of real Mac pairing and diff review. |
| **Export Compliance (`ITSAppUsesNonExemptEncryption`)** | App uses standard Noise (`Curve25519` + `ChaCha20-Poly1305`), TLS, WebAuthn P-256 Passkeys, and RFC 8291 `aes128gcm` push decryption. | Declare standard encryption accurately in App Store Connect (and file routine BIS self-classification / ERN documentation if applicable for E2EE data-in-transit) rather than mis-declaring "no encryption". |
| **Associated Domains & Passkeys (`webcredentials`)** | WebAuthn Passkeys require Apple's `apple-app-site-association` (AASA) hosted over HTTPS at `https://toolroll.dev/.well-known/apple-app-site-association`. | Host AASA on `toolroll.dev` (`webcredentials.apps: ["<TEAM_ID>.dev.toolroll.ios"]`). The AASA authorizes the iOS app to invoke `ASAuthorizationController` for `rpId: "toolroll.dev"`; **all cryptographic verification runs locally on the user's Mac** (zero per-Mac HTTPS certificates required). |
| **Push Notifications & Notification Service Extension** *(not built yet: push waits on the APNs key; the first submission ships without the extension or `aps-environment`)* | Decrypting E2EE pushes requires a separate Notification Service Extension target sharing an App Group Keychain with the main app. | Configure `group.dev.toolroll.ios` App Group + Keychain Sharing entitlement across both targets; set `mutable-content: 1` and generic fallback `aps.alert` on APNs payloads (≤ 4,096 B total); strictly bound extension work to local decryption (<50 ms, zero outbound network calls). |
| **Privacy Nutrition Labels** | Accurate declaration of relay metadata and push tokens. | Declare APNs device token & opaque relay routing IDs as *App Functionality (not linked to tracking)*; zero analytics, zero ad SDKs, zero third-party telemetry. |

---

## 2. Trust Root & Fork Distribution Boundaries

- **Official Trust Root:** For the official App Store build, `toolroll.dev` (AASA file + default hosted relay/push forwarder) and the official Apple Developer Team ID jointly control official binary signing, `webcredentials:toolroll.dev` passkey association, and APNs delivery.
- **Community Forks (Apple constraints vs. relay policy):**
  - **Apple platform constraints:** Because Apple binds Associated Domains (`webcredentials`) and APNs `.p8` push keys to a specific Team ID + Bundle ID, forks compiled under a different Apple Team ID **cannot** use official `toolroll.dev` passkeys or official APNs push; they must configure their own Apple Team ID, Bundle ID, AASA domain / RP ID, and APNs `.p8` key.
  - **Relay admission policy (not an Apple restriction):** Apple's rules do **not** prevent a forked build from connecting to the official WebSocket relay (`wss://relay.toolroll.dev`); whether forks are admitted to the hosted relay is solely a matter of the relay operator's admission policy (and forks can always point `TOOLROLL_RELAY_URL` at their own self-hosted relay).

---

## 3. Signing & Release Prerequisites (Owner Action Items)

Before submitting the first TestFlight build (not needed to begin Gate 1 local simulator builds):
1. Apple Developer account Team ID & Bundle IDs:
   - `dev.toolroll.ios` (main iOS app)
   - `dev.toolroll.ios.notification-service` (Notification Service Extension)
   - `group.dev.toolroll.ios` (App Group)
2. APNs `.p8` Auth Key (free from Apple Developer Portal; stored as a secret on the hosted push forwarder).
3. Publish `https://toolroll.dev/.well-known/apple-app-site-association` for `webcredentials`.
4. *(Related Track 1 Mac app item)* Developer ID Application certificate + notarization credentials for `mac-release.yml` signed `.dmg` releases.

---

## 4. Rollout Sequence

1. **Internal Simulator & Physical iPhone (Gate 1 Read-Only):** Pass all Gate 1 security test suites (Noise vectors, pairing race abort, ADR 0001 restore wipe, revocation, loopback isolation, flow control & memory caps) before shipping internal read-only pilot.
2. **TestFlight Internal (Gate 2 Passkey Approvals):** Pass all Gate 2 security test suites (WebAuthn registration & verification, per-verb transactional wiring, idempotency states, uncertain outcomes); verify Passkeys against `toolroll.dev` AASA on real iOS hardware.
3. **TestFlight External Beta → App Store:** Submit with Built-in Demo Mode + concise reviewer guide framing the app as a native developer companion client (not remote desktop).
