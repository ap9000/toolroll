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

### Implementation Selection (Gate 1 Spike — Deferred Until Tested)
No specific Noise library is pre-selected or claimed Revision-34-compatible here; library choice is gated on empirical verification during the Gate 1 spike:
- **Requirement:** Any chosen Node.js and Swift implementations (for example, a Rust `snow` binding via N-API / UniFFI, a verified Revision 34 library, or — if no maintained Revision 34 Swift library exists — a minimal Revision 34 `IKpsk2` state machine over `node:crypto` and Apple `CryptoKit` primitives) MUST pass 100% of canonical Revision 34 `Noise_IKpsk2_25519_ChaChaPoly_SHA256` test vectors and undergo independent code review before Gate 1 merges.
- No prior third-party audit is claimed unless an actual published audit of the exact pinned dependency and version is cited.

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
   - The Mac UI explicitly instructs the owner: **Click Confirm ONLY if your own phone is showing the exact same code.** (If someone else raced the QR first, the owner's phone shows no code at all.)
   - **Device remains `pending` (zero RPCs permitted)** until the signed-in approver clicks **Confirm match** on the Mac.
5. **Finalization & `devicePsk` derivation/storage:**
   - Upon Mac confirmation, the Mac generates `deviceId = UUIDv4` and `pskEntropy = CSPRNG(32)`, sends `{ deviceId, recoveryGeneration, pskEntropy, pskVersion: 1 }` inside the encrypted pairing channel, and receives the phone's `deviceRelayPub`.
   - The phone persists `recoveryGeneration` alongside `workspaceId`, `deviceId`, `machineId`, `macStaticPub`, and `devicePsk` so it can construct the exact reconnect prologue on every future session.
   - Both sides independently derive the durable 32-byte **`devicePsk`**:
     `devicePsk = HKDF-SHA256(ikm = pskEntropy, salt = h_pair, info = "toolroll-device-psk-v1:" || utf8(workspaceId) || ":" || utf8(deviceId), len = 32)`.
   - **Storage on Mac (plain truth):** Both peers need the raw 32-byte `devicePsk` for every `IKpsk2` handshake (a one-way hash cannot work). On the Mac, `device_psk` is stored **unencrypted in SQLite** (`paired_devices.device_psk`), and therefore appears in Workspace backups, protected at rest by OS file permissions (`0600`) and Toolroll's agent fence (`src/agent-fence.ts`, which denies Toolroll's own state folder and SQLite database to build/agent processes). This is why ADR 0001 unconditionally wipes `paired_devices` on backup restore.
   - **Storage on iPhone:** Stored in iOS Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (never synced to iCloud Keychain, never backed up).
   - **Relay registration:** Daemon registers `{ deviceId, deviceRelayPub }` with the relay (`POST /v1/machines/:id/devices`, signed with `relayMachinePriv`) and wipes `pairPsk`.
   - **Rotation:** Supported over an authenticated Noise session via two-phase commit (`device.psk.rotate` sends `newPskEntropy` + `pskVersion + 1`; daemon accepts both `current` and `next` PSK until the phone completes one `IKpsk2` handshake under `next`, then deletes `current`).
   - **Restore wipe (ADR 0001):** Backup restore unconditionally deletes all `paired_devices` rows (including `device_psk` and `phoneStaticPub`) and increments `recoveryGeneration`.

---

## 3. Bounded RPC-over-Noise Framing (Not Raw HTTP)

Every Noise transport message carries **exactly one** binary frame (total plaintext ≤ 65,519 bytes; frame header = 13 bytes; max frame payload = **60,000 bytes** per frame to stay cleanly under the 65,535-byte Noise ciphertext ceiling):

```text
[1B frameType][4B streamId (u32 BE)][4B seq (u32 BE)][4B payloadLen (u32 BE)][payload bytes (<= 60,000 B)]
```

| `frameType` | Direction | Semantics |
|---|---|---|
| `0x01 REQ` | Phone → Mac | Complete single-frame RPC request `{ method, params, idempotencyKey? }` (≤ 60,000 B). |
| `0x0A REQ_CHUNK` | Phone → Mac | Ordered chunk (`seq = 0, 1, ...`) of a multi-frame RPC request (max **256 KiB** logical request, max 5 chunks; terminated by `0x08 END`). |
| `0x02 RES` | Mac → Phone | Complete single-frame RPC response `{ ok, result?, error? }` (≤ 60,000 B). |
| `0x03 CHUNK` | Mac → Phone | Ordered chunk (`seq = 0, 1, ...`) of a multi-part unary response (max **1 MiB** logical response, ~18 chunks) or live watch subscription (≤ 60,000 B per chunk). |
| `0x08 END` | Both | Clean end-of-stream marker for multi-chunk request (`REQ_CHUNK`) or response/subscription (`CHUNK`). |
| `0x09 ERROR` | Both | Terminal per-stream error `{ code, message }`; immediately closes `streamId`. |
| `0x04 CREDIT` | Phone → Mac | Flow-control credit grant (`+N` `CHUNK` frames allowed on `streamId`; initial window = 16 frames). |
| `0x05 CANCEL` | Phone → Mac | Cancels observation of `streamId` (**stops watching only**; never stops the underlying agent run). |
| `0x06 PING` / `0x07 PONG` | Both | Liveness heartbeat on `streamId = 0` (every 25s while foregrounded; 10s timeout → UI switches to `Unavailable`). |

### Stream Bounds, Flow Control, Deadlines & Memory Caps
- **Stream ID allocation (no reuse):** Phone allocates strictly monotonic odd `streamId` (`1, 3, 5, ...`). Reusing any previously seen `streamId` within a session is a protocol error (`ERROR(protocol_error)` + close). Approaching `2^32 - 1` triggers a clean session reconnect.
- **Concurrency caps:** Max **8 concurrent open streams** per phone session (at most **2 live watch subscriptions** + **6 unary/diff streams**). Excess streams return `ERROR(too_many_streams)`.
- **Deadlines:**
  - Multi-chunk `REQ_CHUNK` assembly deadline: **5 seconds** from chunk 0 to `END`.
  - Unary RPC response deadline: **30 seconds** total. Because max unary response is **1 MiB** (~18 chunks) and the relay grants a **2 MiB burst / 4 MiB/min sustained** budget per phone, a maximum-size 1 MiB diff completes well inside the 30-second window.
  - Live subscription idle deadline (no `CREDIT` or `PING/PONG`): **60 seconds** → `ERROR(idle_timeout)`.
- **Backpressure (distinct rules for unary responses vs. live watch streams):**
  - **Unary multi-part responses (e.g., `task.diff`):** Response `CHUNK` frames are **never dropped or coalesced**. If stream credit hits `0`, the daemon pauses emission and waits for `CREDIT` (up to the 30-second unary deadline, after which it sends `ERROR(deadline_exceeded)` and closes the stream).
  - **Live watch subscriptions (`run.watch.subscribe`):** When stream credit hits `0`, the daemon buffers at most **32 records OR 256 KiB** per stream, coalescing/truncating older live records with an explicit `{ k: "cut" }` marker.
  - **Global memory caps:** Max **1 MiB total buffered bytes across all streams per phone session**, and max **4 MiB daemon-wide** across all connected paired phones.
- **iOS Background Suspension:** iOS suspends WebSockets within seconds of backgrounding. The app cleanly closes the socket on `scenePhase == .background` and runs a 1-RTT `Noise_IKpsk2` reconnect on foreground resume, marking cached views stale until `device.hello` succeeds.

---

## 4. Relay Admission, Multi-Phone Routing & Portable Hosting

### Pre-Upgrade Admission, Deterministic `machineId` & Role Ownership
1. **Deterministic `machineId` & registration (`POST /v1/machines/register`):**
   - On first relay setup, the Mac generates an Ed25519 `relayMachineKey` (separate from its Noise X25519 key).
   - `machineId` is derived **deterministically from `relayMachinePub`** (never randomly assigned by the relay):
     `machineId = base32_lower(SHA-256("toolroll-machine-id-v1\0" || relayMachinePub))[0..26]` (130 bits, URL-safe).
   - To register (or reclaim `machineId` on a fresh/migrated relay), the daemon submits `relayMachinePub` + a fresh Ed25519 proof-of-possession signature over `("register\0" || relayHost || "\0" || relayChallenge)` (plus PoW on the public relay or an invite token on private relays). The relay computes `machineId` from `relayMachinePub` and binds `machineId → relayMachinePub`.
2. **Daemon role ownership:** Only a `role=daemon` token **signed by `relayMachinePriv`** (`TTL 5 min`, `jti`, `machineId`, `exp`) can claim the daemon WebSocket slot (`wss://<host>/v1/connect`). Nobody else can impersonate or evict the daemon.
3. **Pairing bootstrap (`role=pair`):** The Mac signs a 5-minute `pairConnToken` (`role=pair`, `machineId`, `pairSessionId`, `exp`) with `relayMachinePriv` and embeds it in the QR code. The relay verifies the signature against `relayMachinePub` before WebSocket upgrade.
4. **Steady-state phone reconnect (`role=device`):** Upon pairing confirmation, the Mac registers `{ deviceId, deviceRelayPub }` on the relay (`POST /v1/machines/:id/devices`, authenticated by `relayMachinePriv`). Thereafter, the iPhone locally mints its own 5-minute `role=device` connection tokens signed by `deviceRelayPriv` (renewing on each foreground reconnect with zero round-trip to the Mac). On device revocation, the Mac calls `DELETE /v1/machines/:id/devices/:deviceId` so the relay blocks the phone pre-upgrade (and the Mac rejects it locally regardless).

### Multi-Phone Routing Envelope (Relay ↔ Daemon)
The daemon maintains **one** outbound WebSocket to the relay; up to **4 concurrent phone/pair sockets** connect to the same `machineId` room. The relay assigns each phone socket a 4-byte `connId` (`u32 BE`) and wraps frames on the **daemon** leg in a minimal 5-byte routing header:
- `0x01 PEER_OPEN(connId, role: pair|device, id)` — notifies daemon a peer connected
- `0x02 PEER_DATA(connId, rawNoiseMessageBytes)` — blind binary forward (≤ 65,535 B)
- `0x03 PEER_CLOSE(connId, reasonCode)` — notifies daemon peer disconnected

Phone sockets send and receive raw Noise messages (≤ 65,535 B); the relay holds zero Noise keys and never inspects Noise bytes.

### Deadlines, Rate Limits & Abuse Controls
- **Separated connection deadlines (relay has no Noise keys):**
  - **Relay enforces:** a **5-second first-frame deadline** (newly upgraded peer socket must send its first binary frame within 5s) and a **60-second idle timeout** (no frame in either direction).
  - **Mac daemon enforces:** a **5-second Noise handshake completion deadline** from `PEER_OPEN` until `Noise_IKpsk2` completes AND `device.hello` is verified; on timeout, the daemon sends `PEER_CLOSE(connId)` to drop the peer.
- **Max binary WebSocket frame:** 65,535 bytes (phone leg) / 65,540 bytes (daemon leg including 5-byte routing header).
- **Per-phone rate & byte limits:** **600 frames/min sustained (10 frames/sec)** with **120-frame burst**, and **4 MiB/min sustained** with **2 MiB burst** (accommodating a max 1 MiB diff well inside the 30-second response deadline).
- **Per-machine aggregate cap:** Max **4 concurrent phone sockets**, **2,400 frames/min**, **16 MiB/min**.
- **Global circuit breaker:** Hard spending/request budget cap on hosted deployments.

### Portable Reference Relay & Migration Semantics
- **Wire contract & conformance suite (`relay/PROTOCOL.md` + `relay/conformance/`):** Any relay implementation passing the conformance suite is drop-in compatible.
- **Portable Reference Implementation (`relay/reference/`):** Small Node.js/Go server + `Dockerfile` for self-hosting via `TOOLROLL_RELAY_URL`.
- **Cloudflare Durable Object Adapter (`relay/cloudflare/`):** One hosting adapter behind `wss://relay.toolroll.dev` (note: Cloudflare WS messages support up to 32 MiB; we enforce the 65,535-byte Noise cap explicitly).
- **Honest migration story:** Moving relays is **not** a pure DNS flip because `machineId → relayMachinePub` and `deviceId → deviceRelayPub` registrations live in the relay's storage. Because `machineId` is deterministically derived from `relayMachinePub`, migrating `relay.toolroll.dev` off Cloudflare works cleanly via either (a) exporting/importing that small public-key registration table before DNS cutover, or (b) automatic daemon recovery on `401 unknown_machine` — the daemon re-registers `relayMachinePub` (reclaiming the **exact same `machineId`**) and re-syncs active `paired_devices`' `deviceRelayPub` entries from local SQLite, with zero phone re-pairing required because `machineId`, `macStaticPub`, and `devicePsk` do not change.

---

## 5. End-to-End Encrypted Push Notifications

Extending Toolroll's RFC 8291 `aes128gcm` push encryption (`src/push.ts:154` `encryptPushPayload`, which wraps the 5-argument `encryptWithMaterials` at `src/push.ts:119`):

1. **Key registration (`push.register`):** The iOS app generates a dedicated P-256 push keypair (`p256dh`, 65-byte uncompressed point) AND a **16-byte random `authSecret`**, storing the private key + `authSecret` in the shared **App Group Keychain** (`group.dev.toolroll.ios`, `ThisDeviceOnly`) accessible to both the main app and the **Notification Service Extension**, and sends `{ apnsToken, p256dh, authSecret }` to the Mac.
2. **Privacy default (matches `src/push.ts:8-11`):** By default (`phone.push.includeTitles: false`), even the encrypted payload contains **only** the fixed notification class phrase and opaque `taskId` — task titles, branch names, and repository names stay on the Mac. Rich titles/summaries inside E2EE push require an **explicit opt-in setting** on the Mac.
3. **Encryption & APNs envelope (≤ 4,096 bytes total):**
   - Mac encrypts compact JSON plaintext (strictly capped at **≤ 2,400 bytes** so base64url + RFC 8291 header + `aps` wrapper stays ~3.5 KB, safely under APNs's 4,096-byte hard limit) via `encryptPushPayload(p256dh, authSecret, plaintext)` (`src/push.ts:154`).
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

To be generated from a canonical Noise Revision 34 reference implementation and checked into `test/fixtures/companion-noise/vectors.json` **before** writing Gate 1 transport code:
- Fixed ephemeral/static/PSK test keys and exact pairing + session prologues producing byte-exact Noise `IKpsk2` message 1, message 2, handshake hash `h`, 6-char confirmation code, derived `devicePsk`, and transport ciphertexts for nonces `0`, `1`, and `2^32 + 7` (verifying 64-bit `BigInt` / `UInt64` encoding) plus rejection vectors for `2^64 - 1`, prologue mismatch, and oversized (>65,535 B) messages.
- Both `vitest` (Node daemon) and `swift test` (iOS/Core) MUST pass identical assertions in CI.
