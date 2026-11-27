# Companion Phone App — Noise `IKpsk2`, Portable Relay & E2EE Push Protocol Spec

**Status:** Design spec (pre-build, revised after independent protocol review)  
**Scope:** Transport encryption, pairing handshake, bounded RPC framing, relay admission & multi-phone routing, portable reference relay, and end-to-end encrypted push notifications.

---

## 1. Cryptographic Handshake — Noise `IKpsk2`

Both daemon (Node.js) and iOS client (Swift) implement the standard **Noise Protocol Framework (Revision 34)**:

- **Protocol name:** `Noise_IKpsk2_25519_ChaChaPoly_SHA256`
  - Pattern: `IKpsk2` (initiator knows responder's pinned static X25519 public key `rs`; 32-byte `psk` mixes in during message 2).
  - DH: `Curve25519` (X25519)
  - Cipher: `ChaChaPoly` (RFC 8439 ChaCha20-Poly1305)
  - Hash: `SHA256`

### Implementation Selection (Gate 1 Spike — Honest Library Status)
No claim of prior third-party audit is made until a specific dependency and commit SHA are selected and reviewed in Gate 1:
- **Daemon (Node.js):** Evaluate `noise-c.wasm` (WASM build of the C `noise-c` reference implementation, which directly supports `Noise_IKpsk2_25519_ChaChaPoly_SHA256`) or a Rust N-API binding over `snow` (reusing the repository's existing Rust toolchain in `tui/`). *(Note: `@chainsafe/libp2p-noise` supports only `XX`, not `IKpsk2`, and is not eligible.)*
- **iOS (Swift):** Evaluate `OuterCorner/Noise` (SPM wrapper around `noise-c`) or `swift-libp2p/swift-noise` (verifying `IKpsk2` + `SHA256` support). If neither cleanly supports `IKpsk2` + `SHA256` on iOS 17+, a minimal Noise `IKpsk2` state machine (~150 lines) built over Apple `CryptoKit` primitives (`Curve25519.KeyAgreement`, `ChaChaPoly`, `SHA256`) is acceptable **only** when independently code-reviewed and passing 100% of cross-language reference vectors. *(Note: `CryptoKit` provides cryptographic primitives, not a Noise implementation.)*

### Exact Handshake Specification

1. **Prologue bytes (exact, UTF-8, length-unambiguous via `\0` delimiters):**
   - **Pairing mode:**
     `prologue = "toolroll-noise-v1\0pair\0" || utf8(workspaceId) || "\0" || utf8(pairSessionId)`
   - **Session reconnect mode:**
     `prologue = "toolroll-noise-v1\0session\0" || utf8(workspaceId) || "\0" || utf8(deviceId) || "\0" || uint32_be(recoveryGeneration)`
   - Both sides pass identical `prologue` bytes to `Initialize("Noise_IKpsk2_25519_ChaChaPoly_SHA256", prologue, ...)`. Any mismatch in version, mode, workspace, device, or `recoveryGeneration` causes handshake authentication to fail cryptographically.
2. **Never act on handshake message 1 (`-> e, es, s, ss`).** Noise `IK` message 1 is replayable before responder ephemeral entropy (`ee`, `se`, `psk`) enters in message 2. The daemon MUST NOT execute any RPC or mutate durable state from message 1; message 1 payload carries only `{ protocolVersion: 1, mode: "pair" | "session", deviceId?, deviceName? }`.
3. **Key confirmation before RPCs.** A session enters `AUTHENTICATED` only after message 2 (`<- e, ee, se, psk`) completes AND the phone sends its first encrypted transport message (`device.hello`) verified under the initiator→responder transport cipher key.
4. **Noise message size cap (65,535 bytes).** Per Noise Protocol Framework Revision 34 §3, every Noise transport message MUST be **≤ 65,535 bytes** total ciphertext (including the 16-byte Poly1305 tag), capping each Noise transport plaintext at **≤ 65,519 bytes**. Larger logical RPC requests or responses MUST be split into bounded frames (Section 3).
5. **64-bit byte-encoded nonces & `2^64 - 1` refusal.** Transport nonces are strict monotonic `uint64` counters encoded as `0x00000000 || uint64_le(n)` using `BigInt` in TypeScript and `UInt64` in Swift (never JS `Number`). Per Noise §5.1, nonce **`2^64 - 1` (`0xFFFFFFFFFFFFFFFF`) is reserved** and MUST NEVER be used for encryption or decryption; reaching it (or any out-of-order/replayed counter) immediately terminates the session.
6. **Rekey / session lifetime rule.** Either peer MUST close the transport and trigger a fresh 1-RTT `Noise_IKpsk2` re-handshake once **either** cipher direction reaches **`2^20` (1,048,576) messages** OR **24 hours** of session age, whichever comes first. This provides periodic ephemeral forward secrecy and keeps nonces 13 orders of magnitude away from `2^64 - 1`.
7. **Same protocol everywhere & independent Mac key pinning.** Any future post-V1 local-network transport MUST run the exact same `Noise_IKpsk2` handshake (zero plaintext fallback). The phone pins `macStaticPub` per `workspaceId` independently of `relayUrl`.

---

## 2. Two-Step Pairing Ceremony & `devicePsk` Lifecycle

1. **Mac (signed-in approver):** Clicks *Pair iPhone* (or `toolroll phone pair`).
   - Generates ephemeral one-time `pairPsk = CSPRNG(32)` (TTL 5 min, single-use) and `pairSessionId = UUIDv4`.
   - Signs a short-lived **`pairConnToken`** (`role=pair`, `machineId`, `pairSessionId`, `TTL 5 min`) with the Mac's Ed25519 `relayMachinePriv` (Section 4).
   - Renders QR code: `{ v: 1, relayUrl, machineId, workspaceId, macStaticPub, pairSessionId, pairPsk, pairConnToken }`. `pairPsk` is never transmitted over the relay.
2. **iPhone:** Scans QR, generates its own X25519 static keypair (`phoneStaticPriv` stored in iOS Keychain `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) and Ed25519 relay identity keypair (`deviceRelayPriv`, also `ThisDeviceOnly`). Connects to `relayUrl` using `pairConnToken` and runs `Noise_IKpsk2` with `psk = pairPsk` and the pairing prologue.
3. **Second-handshake race abort (mandatory):**
   - If a **second** pairing handshake arrives for the same `pairSessionId` before the owner confirms (e.g., a bystander photographed the QR and raced the owner), the Mac daemon **immediately aborts the entire pairing session**, deletes `pairPsk`, drops all pending pairing sockets for `pairSessionId`, and displays: *"Multiple devices tried to use this QR code — pairing cancelled. Generate a new QR code."*
4. **Transcript confirmation code:**
   - After message 2 completes, both sides derive a 6-character code from the 32-byte Noise handshake hash `h_pair`:
     `code = base32_crockford(HKDF-SHA256(ikm = h_pair, salt = "", info = "toolroll-pair-confirm-v1", len = 8))[0..6]` (displayed as `7K4-M9P`).
   - Both screens display `7K4-M9P`. Any self-reported `deviceName` (e.g., *"Work iPhone"*) is sanitized of control/bidi characters and shown strictly as **untrusted display text**, never a trust indicator.
   - **Device remains `pending` (zero RPCs permitted)** until the signed-in approver clicks **Confirm match** on the Mac.
5. **Finalization & `devicePsk` derivation/storage:**
   - Upon Mac confirmation, the Mac generates `deviceId = UUIDv4` and `pskEntropy = CSPRNG(32)`, sends `{ deviceId, pskEntropy, pskVersion: 1 }` inside the encrypted pairing channel, and receives the phone's `deviceRelayPub`.
   - Both sides independently derive the durable 32-byte **`devicePsk`**:
     `devicePsk = HKDF-SHA256(ikm = pskEntropy, salt = h_pair, info = "toolroll-device-psk-v1:" || utf8(workspaceId) || ":" || utf8(deviceId), len = 32)`.
   - **Storage on Mac:** Both peers need the raw 32-byte `devicePsk` for every `IKpsk2` handshake (a one-way hash cannot work). On the Mac, `device_psk` is stored in SQLite (`paired_devices`, protected storage per `src/protected-storage.ts`, mode `0600`, sealed with the local workspace secret key when present, strictly outside agent fences).
   - **Storage on iPhone:** Stored in iOS Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (never synced to iCloud Keychain, never backed up).
   - **Relay registration:** Daemon registers `{ deviceId, deviceRelayPub }` with the relay (`POST /v1/machines/:id/devices`, signed with `relayMachinePriv`) and wipes `pairPsk`.
   - **Rotation:** Supported over an authenticated Noise session via two-phase commit (`device.psk.rotate` sends `newPskEntropy` + `pskVersion + 1`; daemon accepts both `current` and `next` PSK until the phone completes one `IKpsk2` handshake under `next`, then deletes `current`).
   - **Restore wipe (ADR 0001):** Backup restore unconditionally deletes all `paired_devices` rows (including `device_psk` and `phoneStaticPub`) and increments `recoveryGeneration`.

---

## 3. Bounded RPC-over-Noise Framing (Not Raw HTTP)

Every Noise transport message carries **exactly one** binary frame (total plaintext ≤ 65,519 bytes; frame header = 13 bytes; max frame payload = **60,000 bytes** / `60 KB` per frame to leave comfortable headroom under the 65,535-byte Noise ciphertext ceiling):

```text
[1B frameType][4B streamId (u32 BE)][4B seq (u32 BE)][4B payloadLen (u32 BE)][payload bytes (<= 60,000 B)]
```

| `frameType` | Direction | Semantics |
|---|---|---|
| `0x01 REQ` | Phone → Mac | Complete single-frame RPC request `{ method, params, idempotencyKey? }` (≤ 60,000 B). |
| `0x0A REQ_CHUNK` | Phone → Mac | Ordered chunk (`seq = 0, 1, ...`) of a multi-frame RPC request (max **256 KiB** logical request, max 5 chunks; terminated by `0x08 END`). |
| `0x02 RES` | Mac → Phone | Complete single-frame RPC response `{ ok, result?, error? }` (≤ 60,000 B). |
| `0x03 CHUNK` | Mac → Phone | Ordered chunk (`seq = 0, 1, ...`) of a multi-part response or live subscription (≤ 60,000 B per chunk; max **4 MiB** logical unary response). |
| `0x08 END` | Both | Clean end-of-stream marker for multi-chunk request (`REQ_CHUNK`) or response/subscription (`CHUNK`). |
| `0x09 ERROR` | Both | Terminal per-stream error `{ code, message }`; immediately closes `streamId`. |
| `0x04 CREDIT` | Phone → Mac | Flow-control credit grant (`+N` `CHUNK` frames allowed on `streamId`; initial window = 16 frames). |
| `0x05 CANCEL` | Phone → Mac | Cancels observation of `streamId` (**stops watching only**; never stops the underlying agent run). |
| `0x06 PING` / `0x07 PONG` | Both | Liveness heartbeat on `streamId = 0` (every 25s while foregrounded; 10s timeout → UI switches to `Unavailable`). |

### Stream Bounds, Deadlines & Memory Caps
- **Stream ID allocation (no reuse):** Phone allocates strictly monotonic odd `streamId` (`1, 3, 5, ...`). Reusing any previously seen `streamId` within a session is a protocol error (`ERROR(protocol_error)` + close). Approaching `2^32 - 1` triggers a clean session reconnect.
- **Concurrency caps:** Max **8 concurrent open streams** per phone session (at most **2 live watch subscriptions** + **6 unary/diff streams**). Excess streams return `ERROR(too_many_streams)`.
- **Deadlines:**
  - Multi-chunk `REQ_CHUNK` assembly deadline: **5 seconds** from chunk 0 to `END`.
  - Unary RPC execution deadline: **30 seconds**.
  - Live subscription idle deadline (no `CREDIT` or `PING/PONG`): **60 seconds** → `ERROR(idle_timeout)`.
- **Memory caps & backpressure:**
  - Per-stream buffer cap: **32 records OR 256 KiB** (whichever hits first); older live records coalesce/truncate with an explicit `{ k: "cut" }` marker.
  - **Per-phone session total buffered bytes cap: 1 MiB** across all open streams.
  - **Daemon-wide total buffered bytes cap: 4 MiB** across all connected paired phones.
- **iOS Background Suspension:** iOS suspends WebSockets within seconds of backgrounding. The app cleanly closes the socket on `scenePhase == .background` and runs a 1-RTT `Noise_IKpsk2` reconnect on foreground resume, marking cached views stale until `device.hello` succeeds.

---

## 4. Relay Admission, Multi-Phone Routing & Portable Hosting

### Pre-Upgrade Admission & Role Ownership (Zero Plaintext Trust)
1. **Machine registration (`POST /v1/machines/register`):** On first setup, the Mac generates an Ed25519 `relayMachineKey` (separate from its Noise X25519 key) and registers `relayMachinePub` (gated by proof-of-work on the public relay or invite token on private relays). The relay assigns `machineId` permanently bound to `relayMachinePub`.
2. **Daemon role ownership:** Only a `role=daemon` JWT/token **signed by `relayMachinePriv`** (`TTL 5 min`, `jti`, `machineId`, `exp`) can claim the daemon WebSocket slot (`wss://<host>/v1/connect`). Nobody else can impersonate or evict the daemon.
3. **Pairing bootstrap (`role=pair`):** The Mac signs a 5-minute `pairConnToken` (`role=pair`, `machineId`, `pairSessionId`, `exp`) with `relayMachinePriv` and embeds it in the QR code. The relay verifies the signature against `relayMachinePub` before WebSocket upgrade.
4. **Steady-state phone reconnect (`role=device`):** Upon pairing confirmation, the Mac registers `{ deviceId, deviceRelayPub }` on the relay (`POST /v1/machines/:id/devices`, authenticated by `relayMachinePriv`). Thereafter, the iPhone locally mints its own 5-minute `role=device` connection tokens signed by `deviceRelayPriv` (renewing on each foreground reconnect with zero round-trip to the Mac). On device revocation, the Mac calls `DELETE /v1/machines/:id/devices/:deviceId` so the relay blocks the phone pre-upgrade (and the Mac rejects it locally regardless).

### Multi-Phone Routing Envelope (Relay ↔ Daemon)
The daemon maintains **one** outbound WebSocket to the relay; up to **4 concurrent phone/pair sockets** connect to the same `machineId` room. The relay assigns each phone socket a 4-byte `connId` (`u32 BE`) and wraps frames on the **daemon** leg in a minimal 5-byte routing header:
- `0x01 PEER_OPEN(connId, role: pair|device, id)` — notifies daemon a peer connected
- `0x02 PEER_DATA(connId, rawNoiseMessageBytes)` — blind binary forward (≤ 65,535 B)
- `0x03 PEER_CLOSE(connId, reasonCode)` — notifies daemon peer disconnected

Phone sockets send and receive raw Noise messages (≤ 65,535 B); the relay never inspects Noise bytes.

### Rate Limits & Abuse Controls
- **Handshake deadline:** 5 seconds from WebSocket open to first valid Noise exchange (relay drops idle sockets).
- **Max binary WebSocket frame:** 65,535 bytes (phone leg) / 65,540 bytes (daemon leg including 5-byte routing header).
- **Per-phone sustained rate:** **600 frames/min (10 frames/sec)** with **120-frame burst** and **4 MiB/min** byte cap (sufficient for live run windows + diffs + heartbeats while bounding abuse).
- **Per-machine aggregate cap:** Max **4 concurrent phone sockets**, **2,400 frames/min**, **16 MiB/min**.
- **Global circuit breaker:** Hard spending/request budget cap on hosted deployments.

### Portable Reference Relay & Migration Semantics
- **Wire contract & conformance suite (`relay/PROTOCOL.md` + `relay/conformance/`):** Any relay implementation passing the conformance suite is drop-in compatible.
- **Portable Reference Implementation (`relay/reference/`):** Small Node.js/Go server + `Dockerfile` for self-hosting via `TOOLROLL_RELAY_URL`.
- **Cloudflare Durable Object Adapter (`relay/cloudflare/`):** One hosting adapter behind `wss://relay.toolroll.dev` (note: Cloudflare WS messages support up to 32 MiB; we enforce the 65,535-byte Noise cap explicitly).
- **Honest migration story:** Moving relays is **not** a pure DNS flip because `machineId → relayMachinePub` and `deviceId → deviceRelayPub` registrations live in the relay's storage. Migrating `relay.toolroll.dev` off Cloudflare requires either (a) exporting/importing that small public-key registration table before DNS cutover, or (b) automatic daemon recovery on `401 unknown_machine` (the daemon re-registers `relayMachinePub` and re-syncs active `paired_devices`' `deviceRelayPub` entries from local SQLite — zero phone re-pairing required because `macStaticPub` and `devicePsk` do not change).

---

## 5. End-to-End Encrypted Push Notifications

Extending Toolroll's RFC 8291 `aes128gcm` push encryption (`src/push.ts:119`):

1. **Key registration (`push.register`):** The iOS app generates a dedicated P-256 push keypair (`p256dh`, 65-byte uncompressed point) AND a **16-byte random `authSecret`**, storing the private key + `authSecret` in the shared **App Group Keychain** (`group.dev.toolroll.ios`, `ThisDeviceOnly`) accessible to both the main app and the **Notification Service Extension**, and sends `{ apnsToken, p256dh, authSecret }` to the Mac.
2. **Privacy default (matches `src/push.ts:8-11`):** By default (`phone.push.includeTitles: false`), even the encrypted payload contains **only** the fixed notification class phrase and opaque `taskId` — task titles, branch names, and repository names stay on the Mac. Rich titles/summaries inside E2EE push require an **explicit opt-in setting** on the Mac.
3. **Encryption & APNs envelope (≤ 4,096 bytes total):**
   - Mac encrypts compact JSON plaintext (strictly capped at **≤ 2,400 bytes** so base64url + RFC 8291 header + `aps` wrapper stays well under APNs's 4,096-byte hard limit) via `encryptWithMaterials(p256dh, authSecret, ...)`.
   - Mac posts `{ apnsToken, ciphertextB64, badge, collapseId, opaqueMachineTag }` to `POST /v1/push` (authenticated with `relayMachinePriv`).
   - Hosted push forwarder delivers to APNs (`apns-push-type: alert`, `apns-collapse-id: <collapseId>`):
     ```json
     {
       "aps": {
         "alert": { "title": "Toolroll", "body": "Open app to check your workspace." },
         "mutable-content": 1,
         "badge": 3,
         "sound": "default"
       },
       "tr": { "v": 1, "m": "<opaqueMachineTag>", "c": "<base64url(aes128gcm)>" }
     }
     ```
4. **Honest visibility:** `badge`, `apns-collapse-id`, `opaqueMachineTag`, `apnsToken`, delivery timing, and payload length travel **in the clear** to the push forwarder and APNs; only `tr.c` is end-to-end encrypted.
5. **Notification Service Extension:** Decrypts `tr.c` locally in <50 ms using the App Group Keychain private key + `authSecret` (zero outbound network fetch over the relay). If decryption fails (e.g., wiped/rotated key), falls back to the neutral generic `aps.alert`.
6. **Self-hosting push limitation:** Apple APNs requires the Team's `.p8` push key for the official App Store Bundle ID (`dev.toolroll.ios`). A self-hosted relay therefore **cannot** deliver APNs pushes directly to the official App Store app; self-hosters may either (a) use their own WebSocket relay while opting into the hosted stateless push forwarder, (b) disable push notifications, or (c) compile the iOS app under their own Apple Team ID with their own APNs `.p8` key.

---

## 6. Cross-Language Test Vectors *(First Deliverable of Gate 1)*

To be generated from a canonical Noise reference implementation (`snow` or `noise-c`) and checked into `test/fixtures/companion-noise/vectors.json` **before** writing Gate 1 transport code:
- Fixed ephemeral/static/PSK test keys and exact pairing + session prologues producing byte-exact Noise `IKpsk2` message 1, message 2, handshake hash `h`, 6-char confirmation code, derived `devicePsk`, and transport ciphertexts for nonces `0`, `1`, and `2^32 + 7` (verifying 64-bit `BigInt` / `UInt64` encoding) plus rejection vectors for `2^64 - 1`, prologue mismatch, and oversized (>65,535 B) messages.
- Both `vitest` (Node daemon) and `swift test` (iOS/Core) MUST pass identical assertions in CI.
