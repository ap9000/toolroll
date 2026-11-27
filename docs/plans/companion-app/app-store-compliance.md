# Companion Phone App — App Store Review & Distribution Compliance Plan

**Status:** Design spec (pre-build)  
**Target distribution:** Apple TestFlight → iOS App Store (native SwiftUI, iOS 17+)

---

## 1. Key App Store Review Risks & Mitigations

| Apple Guideline / Requirement | Risk for Toolroll Companion | Concrete Mitigation |
|---|---|---|
| **Guideline 4.2.7 (Remote Desktop / Companion Clients)** | Apple scrutinizes apps that control another computer to ensure they only connect to a host device **owned/controlled by the user** on a private or user-authenticated connection, and do not act as a generic cloud storefront or remote app store. | Explicitly frame the app as a **developer companion for your own local/self-hosted Toolroll installation** (approving git diffs, reviewing CI checks, messaging your own coding agents). Live Terminals / remote desktop streaming are excluded from V1. Pairing requires physical/signed-in access to the user's Mac + visual confirmation code. |
| **Guideline 2.5.2 (No Downloaded Executable Code)** | Dynamic JS/OTA code pushes that alter approval UI or app behavior risk rejection and undermine security. | **Native SwiftUI only** — zero Expo OTA / CodePush / dynamic script loading. All UI and crypto ship inside the signed App Store binary. |
| **Guideline 2.1 (App Completeness & Reviewer Login)** | Reviewers cannot pair a Mac running local CLI tools during a 5-minute App Review session. | Ship a **built-in Demo Mode** (matching `toolroll demo` — zero network calls, zero model calls, local Swift fixtures in `ToolrollCore/DemoFixtures.swift`) accessible from a quiet *"Try Demo Workspace"* button on the Welcome/Pairing screen, AND provide clear App Review notes explaining both Demo Mode and real Mac pairing. |
| **Export Compliance (Encryption — `ITSAppUsesNonExemptEncryption`)** | App uses standard Noise (`Curve25519` + `ChaCha20-Poly1305`), TLS, WebAuthn P-256 Passkeys, and RFC 8291 `aes128gcm` push decryption. | All algorithms are standard, publicly available authentication/E2EE encryption. Declare standard encryption accurately in App Store Connect (and file the routine BIS self-classification / ERN documentation if applicable for E2EE messaging/data-in-transit) rather than mis-declaring "no encryption". |
| **Associated Domains & Passkeys (`webcredentials`)** | WebAuthn Passkeys require Apple's `apple-app-site-association` (AASA) hosted over HTTPS at `https://toolroll.dev/.well-known/apple-app-site-association`. | Host AASA on `toolroll.dev` with the Apple Team ID + Bundle ID (`webcredentials.apps: ["<TEAM_ID>.dev.toolroll.ios"]`). Because the passkey RP ID is `toolroll.dev`, **every user's Mac can verify passkey assertions locally with zero per-Mac HTTPS certificates**. |
| **Push Notifications & Notification Service Extension** | Decrypting E2EE pushes requires a separate Notification Service Extension target sharing an App Group Keychain with the main app. | Configure `group.dev.toolroll.ios` App Group + Keychain Sharing entitlement across both targets; set `mutable-content: 1` on APNs payloads; strictly bound extension work to local decryption (<50 ms, zero outbound network calls). |
| **Privacy Nutrition Labels** | Accurate declaration of relay metadata and push tokens. | Declare APNs device token & relay routing IDs as *App Functionality (not linked to tracking)*; zero analytics, zero ad SDKs, zero third-party telemetry. |

---

## 2. Signing & Release Prerequisites (Owner Action Items)

Before submitting the first TestFlight build (not needed to begin Gate 1 local simulator builds):
1. Apple Developer account Team ID & Bundle IDs:
   - `dev.toolroll.ios` (main iOS app)
   - `dev.toolroll.ios.notification-service` (Notification Service Extension)
   - `group.dev.toolroll.ios` (App Group)
2. APNs `.p8` Auth Key (free from Apple Developer Portal; stored as a Cloudflare Worker secret for the hosted push relay).
3. Publish `https://toolroll.dev/.well-known/apple-app-site-association` for WebAuthn Passkeys.
4. *(Related Track 1 Mac app item)* Developer ID Application certificate + notarization credentials for `mac-release.yml` signed `.dmg` releases.

---

## 3. Rollout Sequence

1. **Internal Simulator & Physical iPhone (Gate 1 Read-Only):** Verify Noise `IKpsk2`, QR + confirmation-code pairing, E2EE push decryption on a real device, background/foreground reconnect, and truthful `Unavailable` state.
2. **TestFlight Internal (Gate 2 Passkey Approvals):** Enable after all 5 mandatory security test suites pass; verify WebAuthn Passkeys against `toolroll.dev` AASA on real iOS hardware.
3. **TestFlight External Beta → App Store:** Submit with Built-in Demo Mode + concise reviewer guide (including short screencast of Mac QR pairing + diff review).
