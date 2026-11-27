# Companion Phone App — Noise `IKpsk2`, Portable Relay & E2EE Push Protocol Spec

**Status:** Design spec (pre-build, for independent protocol review)  
**Scope:** Transport encryption, pairing handshake, RPC framing, portable reference relay, and end-to-end encrypted push notifications.

---

## 1. Cryptographic Handshake — Noise `IKpsk2`

We do **not** invent a custom handshake. Both daemon (Node.js) and iOS client (Swift) use audited implementations of the standard **Noise Protocol Framework** (Revision 34):

- **Protocol name:** `Noise_IKpsk2_25519_ChaChaPoly_SHA256`
  - Pattern: `IKpsk2` (phone knows Mac's pinned static X25519 public key `rs` from pairing; pre-shared key `psk` mixes in during message 2 so even a passive compromise of static keys cannot decrypt sessions without the PSK).
  - DH: `Curve25519` (X25519)
  - Cipher: `ChaChaPoly` (RFC 8439 ChaCha20-Poly1305)
  - Hash: `SHA256`
- **Libraries (pinned, audited):**
  - Daemon (Node.js): audited Noise implementation (e.g., `@chainsafe/libp2p-noise` / `noise-handshake` verified against official Cacophony/Snow `IKpsk2` test vectors — chosen during Gate 1 spike and locked with cross-language vectors).
  - iOS (Swift): `swift-noise` / `CryptoKit` (`Curve25519.KeyAgreement` + `ChaChaPoly` + `SHA256`) verified byte-for-byte against the **exact same test vector suite** checked into `test/fixtures/companion-noise/vectors.json`.

### Critical Protocol Rules
1. **Never act on handshake message 1 (`-> e, es, s, ss`).** Noise `IK` message 1 is vulnerable to replay before the responder contributes ephemeral entropy (`ee`, `se`) in message 2. The daemon MUST NOT execute any RPC or mutate state from message 1's payload; message 1 carries only `{ protocolVersion, deviceId, mode: "pair" | "session" }`.
2. **Key confirmation before RPCs.** A session transitions to `AUTHENTICATED` only after message 2 (`<- e, ee, se, psk`) completes AND the phone sends its first encrypted transport message (`device.hello`) verified with the responder's transport key.
3. **64-bit byte-encoded nonces (never JS `Number`).** ChaChaPoly transport nonces are strict monotonic `uint64` counters encoded as `0x00000000 || uint64_le(n)` using `BigInt` in TypeScript and `UInt64` in Swift. Overflow or any out-of-order/replayed counter immediately terminates the session.
4. **Same protocol everywhere.** If local-network transport is ever added post-V1, it MUST run the identical `Noise_IKpsk2_25519_ChaChaPoly_SHA256` session — zero plaintext fallback.
5. **Independent Mac key pinning.** The phone pins `macStaticPub` per `workspaceId` independently of `relayUrl`. Changing `relayUrl` (e.g., migrating off Cloudflare or switching to a self-hosted relay) can never silently alter the trusted Mac public key.

---

## 2. Two-Step Pairing Ceremony (Defeating QR Photo Races)

1. **Mac (signed-in approver):** Clicks *Pair iPhone* (or `toolroll phone pair`).
   - Generates ephemeral one-time `pairPsk` (32 random bytes, TTL 5 min, single-use) and `pairSessionId`.
   - Renders QR code containing JSON/URI: `{ v: 1, relayUrl, machineId, macStaticPub, pairSessionId, pairPsk }`.
   - Never transmits `pairPsk` over the relay.
2. **iPhone:** Scans QR, generates its own X25519 static keypair (`phoneStaticPub` stored in iOS Keychain `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), connects to `relayUrl` for `machineId`, and runs `Noise_IKpsk2` with `psk = pairPsk`, `mode = "pair"`.
3. **Transcript confirmation code:** After Noise message 2 completes, both Mac and iPhone derive a 6-character confirmation code from the Noise handshake hash `h`:
   `code = base32_crockford(HKDF-SHA256(h, "toolroll-pair-confirm-v1"))[0..6]` (e.g., `7K4-M9P`).
   - Both screens display `7K4-M9P` and the phone's self-reported device name (*"Alex's iPhone"*).
   - **Device stays `pending` (zero RPCs allowed)** until the signed-in owner explicitly clicks **Confirm match** on the Mac.
4. **Finalization:** Upon Mac confirmation:
   - Mac derives a per-device durable `devicePsk` (32 bytes, HKDF from Noise `h` + fresh CSPRNG entropy sent inside the encrypted channel), persists `{ deviceId, accountName, phoneStaticPub, devicePskHash/sealed, status: "active" }` in SQLite, and clears `pairPsk`.
   - Reconnects use `Noise_IKpsk2` with `psk = devicePsk` (no QR required).
   - Wrong/rejected code or 5-minute timeout permanently invalidates `pairPsk`.

---

## 3. RPC-over-Noise Framing (Not Raw HTTP)

Inside the Noise transport cipher, messages are length-prefixed binary frames:

```text
[1B frameType][4B streamId (u32 BE)][4B seq (u32 BE)][4B payloadLen (u32 BE)][payload bytes]
```

| `frameType` | Direction | Semantics |
|---|---|---|
| `0x01 REQ` | Phone → Mac | Single typed RPC request `{ id, method, params, idempotencyKey? }`. Max payload 256 KB. |
| `0x02 RES` | Mac → Phone | Single RPC response `{ id, ok, result?, error? }`. Large diffs chunked with `0x03 CHUNK`. |
| `0x03 CHUNK` | Mac → Phone | Ordered chunk of a multi-part response or live stream (`seq` strictly monotonic per `streamId`). |
| `0x04 CREDIT` | Phone → Mac | Flow-control credit grant (`+N` frames allowed on `streamId`; initial window = 16 frames). |
| `0x05 CANCEL` | Phone → Mac | Cancels observation of `streamId` (**stops watching only**; never stops the underlying agent run). |
| `0x06 PING` / `0x07 PONG` | Both | Liveness heartbeat (every 25s while foregrounded; 10s timeout → UI switches to `Unavailable`). |

### Flow Control & iOS Background Behavior
- **Backpressure:** If a stream's credit hits `0`, the daemon buffers at most 32 live records per stream, coalescing/truncating older records with an explicit `{ k: "cut" }` marker rather than growing unbounded memory.
- **iOS Background Suspension:** iOS suspends WebSockets within seconds of backgrounding. The app cleanly closes the socket on `scenePhase == .background` and immediately runs a 1-RTT `Noise_IKpsk2` reconnect on foreground resume, re-fetching `work.rows` and marking any cached view stale until `device.hello` succeeds.

---

## 4. Portable Reference Relay & Hosting Adapters

To make **"no vendor lock-in"** real rather than aspirational:

1. **Wire contract (`relay/PROTOCOL.md` + conformance test suite):**
   - Plain RFC 6455 WebSocket endpoint `wss://<host>/v1/connect`.
   - **Pre-upgrade admission (prevents unauthenticated socket floods):**
     - Machine registration endpoint (`POST /v1/machines/register` with proof-of-work or signed invite token) mints a `machineId` + `machineAuthSecret`.
     - Both daemon and paired phone present short-lived HMAC/JWT connection tokens (`Authorization: Bearer <connToken>`, 5-min TTL) before WebSocket upgrade.
   - **Per-connection limits:** 5-second handshake deadline (relay drops idle un-paired sockets), max 256 KB binary frame, per-machine rate limit (e.g., 120 frames/min burst), max 4 concurrent phone sockets per `machineId`, and global spending/quota circuit breaker.
   - Relay forwards binary frames blindly between `role=daemon` and `role=device` in the same `machineId` room; zero application parsing, zero plaintext storage.
2. **Portable Reference Implementation (`relay/reference/`):**
   - Small, zero-lock-in Node.js (or Go) server + `Dockerfile` passing the full relay conformance test suite. Any team or individual can self-host via `docker run` and set `TOOLROLL_RELAY_URL`.
3. **Cloudflare Durable Object Adapter (`relay/cloudflare/`):**
   - One hosting option implementing the exact same conformance suite using DO WebSocket Hibernation (note: current Cloudflare WS message limit is 32 MiB; we still cap at 256 KB for abuse control and stream responsiveness).
   - Hosted behind `wss://relay.toolroll.dev` so moving to the portable reference relay later requires only a DNS change — zero app updates, zero re-pairing.

---

## 5. End-to-End Encrypted Push Notifications

Extending Toolroll's existing RFC 8291 `aes128gcm` push encryption (`src/push.ts`):

1. When the iOS app registers for push (`push.register`), it generates a dedicated P-256 push decryption keypair + 16-byte `authSecret` stored in a shared **App Group Keychain** (accessible to both the main app and the **Notification Service Extension**).
2. When an event fires (`needs_you`, `finished`, `failed`, `question`), the Mac daemon encrypts a compact JSON notification payload (`{ kind, taskId, title, summary, badge }`, capped under 2 KB) directly to the phone's P-256 push key using RFC 8291 `aes128gcm`.
3. The Mac posts `{ apnsToken, ciphertextB64, badge, collapseId }` to the stateless push endpoint (`POST /v1/push` on the relay). **Apple APNs, Google FCM, and the relay see only opaque ciphertext.**
4. On receipt, the iOS **Notification Service Extension** decrypts `ciphertextB64` locally in <50 ms using the App Group Keychain private key and renders the real title & summary on the lock screen — **with zero network fetch over the relay**, so rich private notifications work even if the Mac went offline 1 second after sending.
5. Fallback if decryption fails (e.g. rotated/wiped key): displays neutral *"Toolroll: Open app to check your workspace."*

---

## 6. Cross-Language Test Vectors (Required Before Coding Gate 1)

Check into `test/fixtures/companion-noise/vectors.json`:
- Fixed ephemeral/static/PSK test keys producing byte-exact Noise `IKpsk2` message 1, message 2, handshake hash `h`, 6-char confirmation code, and transport ciphertext for nonces `0`, `1`, and `2^32 + 7` (verifying 64-bit `BigInt` / `UInt64` encoding).
- Both `vitest` (Node daemon) and `swift test` (iOS/Core) MUST pass identical vector assertions in CI.
