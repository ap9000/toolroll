# Companion Phone App — Noise `IKpsk2`, Portable Relay & E2EE Push Protocol Spec

**Status:** Gate 1 built (2026-11-27 perfect pass). The frozen numbers are in `test/fixtures/companion-wire.json` (read by the Node and Swift tests) and the relay contract in `relay/PROTOCOL.md`; §4b lists where the code differs from the design text below.  
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
     `prologue = "toolroll-noise-v1\0session\0" || utf8(workspaceId) || "\0" || utf8(deviceId) || "\0" || utf8(recoveryGeneration)` *(where `recoveryGeneration` is Toolroll's 32-lowercase-hex-char `workspace_identity.recovery_generation`)*
   - Both sides pass identical `prologue` bytes to `Initialize("Noise_IKpsk2_25519_ChaChaPoly_SHA256", prologue, ...)`. Any mismatch in version, mode, workspace, device, or `recoveryGeneration` causes handshake authentication to fail cryptographically.
2. **Never act on handshake message 1 (`-> e, es, s, ss`).** Noise `IK` message 1 is replayable before responder ephemeral entropy (`ee`, `se`, `psk`) enters in message 2. The daemon MUST NOT execute any RPC or mutate durable state from message 1; message 1 payload carries only `{ protocolVersion: 1, mode: "pair", deviceRelayPub }` or `{ protocolVersion: 1, mode: "session", deviceId }`. The Mac remembers each message 1's ephemeral key for 15 minutes (64 per pairing or device id, 4,096 in all) and drops a repeat before any Noise work.
3. **Key confirmation before RPCs.** A session enters `AUTHENTICATED` only after message 2 (`<- e, ee, se, psk`) completes AND the phone sends its first encrypted transport message (`device.hello`) verified under the initiator→responder transport cipher key. Before hello only a framing PING is answered; anything else ends the session.
   - **Message 2 is padded:** every message 2 payload (pairing and session, every status) is JSON with a `pad` field making it exactly 160 bytes of plaintext, so the wire never tells an accepted phone from a refused one.
   - **Authenticated refusal:** a phone whose row still exists with keys but is retired, or whose account no longer stands, completes the handshake and gets `{ status: "refused", reason: "device_revoked" | "account_revoked" }`; the Mac then does exactly what an unanswered hello gets (waits for the first transport message or 10 s, then closes 4408). A live session that loses standing gets a stream-0 `ERROR { code: "device_revoked" | "account_revoked" }` and closes 4403.
4. **Noise message size cap (65,535 bytes).** Per Noise Protocol Framework Revision 34 §3, every Noise transport message MUST be **≤ 65,535 bytes** total ciphertext (including the 16-byte Poly1305 tag), capping each Noise transport plaintext at **≤ 65,519 bytes**. Larger logical RPC requests or responses MUST be split into bounded frames (Section 3).
5. **64-bit byte-encoded nonces & `2^64 - 1` refusal.** Transport nonces are strict monotonic `uint64` counters encoded as `0x00000000 || uint64_le(n)` using `BigInt` in TypeScript and `UInt64` in Swift (never JS `Number`). Per Noise §5.1, nonce **`2^64 - 1` (`0xFFFFFFFFFFFFFFFF`) is reserved** and MUST NEVER be used for encryption or decryption; reaching it (or any out-of-order/replayed counter) immediately terminates the session.
6. **Rekey / session lifetime rule.** Either peer MUST close the transport and trigger a fresh 1-RTT `Noise_IKpsk2` re-handshake once **either** cipher direction reaches **`2^20` (1,048,576) messages** OR **24 hours** of session age, whichever comes first. This provides periodic ephemeral forward secrecy and keeps nonces 13 orders of magnitude away from `2^64 - 1`. The Mac ends a session in its last minute (or 16 messages before the cap) with a stream-0 `ERROR { code: "rekey" }` and close 1000; the phone reconnects without a word.
7. **Same protocol everywhere & independent Mac key pinning.** Any future post-V1 local-network transport MUST run the exact same `Noise_IKpsk2` handshake (zero plaintext fallback). The phone pins `macStaticPub` per `workspaceId` independently of `relayUrl`.

---

## 2. Two-Step Pairing Ceremony & `devicePsk` Lifecycle

1. **Mac (signed-in approver):** Clicks *Pair iPhone* (or `toolroll phone pair`).
   - Generates ephemeral one-time `pairPsk = CSPRNG(32)` (TTL 5 min, single-use) and `pairSessionId = "pair_" + 16 hex`.
   - Signs a short-lived **`pairConnToken`** (`role=pair`, `machineId`, `pairSessionId`, `TTL 5 min`) with the Mac's Ed25519 `relayMachinePriv` (Section 4).
   - Refuses when the Mac already has 32 phones (active and pending): "This Mac already has 32 phones. Remove one first."
   - Renders QR code: `{ v: 2, paths, machineId, workspaceId, macStaticPub, pairSessionId, pairPsk, expiresAtMs, pairConnToken? }` (§4a: `paths` lists direct addresses first and the hosted relay last; `pairConnToken` only when a hosted path exists). `pairPsk` is never transmitted over the network.
2. **iPhone:** Scans QR, generates its own X25519 static keypair (`phoneStaticPriv` stored in iOS Keychain `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) and Ed25519 relay identity keypair (`deviceRelayPriv`, also `ThisDeviceOnly`). Connects over one path (§4a) — directly with no token, or to the hosted relay using `pairConnToken` — and runs `Noise_IKpsk2` with `psk = pairPsk` and the pairing prologue.
3. **Key confirmation, then the code (`pair.ready`).** Message 2 (`{ status: "awaiting_ready" }`, padded) proves nothing about the phone: anyone who saw `pairSessionId` and holds `macStaticPub` can write a message 1. Within 10 s the phone sends one framed REQ on stream 1, `pair.ready { deviceName }` (≤48 characters, sanitized of control/bidi characters on the Mac). Decrypting it proves the phone holds `pairPsk`; the **first** such phone is *attached* and only then does the Mac show the code and the device name. A bare socket open or a message 1 never changes or aborts a pairing; a socket that fails to decrypt is dropped alone.
4. **Contest rule (QR photo race).** A **second** socket that proves `pairPsk` while a phone is attached contests the pairing: both get `ERROR pairing_contested` on stream 1 and the pairing ends ("Another device used this code. Pair again."). After the keys went out (`finishing`, below) a contest retires the attached phone's row as `contested`, so that phone is refused. Anyone who can open a socket but doesn't hold the QR's PSK can't contest, evict or abort anything.
5. **Transcript confirmation code:** both sides derive a 6-character code from the Noise handshake hash `h_pair`:
   `code = base32_crockford(HKDF-SHA256(ikm = h_pair, salt = "", info = "toolroll-pair-confirm-v1", len = 8))[0..6]` (displayed as `7K4-M9P`). The owner confirms on the Mac only if their own phone shows the same code.
6. **Outcome, acknowledgement and activation.**
   - On confirm the Mac saves the phone's row **pending**, zeroizes `pairPsk`, and has every connected hosted relay admit `{ deviceId, deviceRelayPub }` (≤10 s each). It then re-checks that the pairing is still its own (not contested, cancelled or expired), the account still stands at the generation that started it, and the attached socket is still the same and open; any failure deletes the row, tells the relays to forget it, and ends the pairing `failed`.
   - The RES to `pair.ready` is the outcome: `{ ok: true, result: { deviceId, recoveryGeneration, pskEntropy } }` (deviceId = `"dev_" + 16 hex`), or `ERROR` on stream 1 with `pairing_cancelled | pairing_expired | pairing_contested | pairing_failed`. Sending it is the linearization point (`finishing`). While waiting, the phone sends a framing PING every 20 s and the Mac answers PONG.
   - The phone stores its keys and sends `pair.done { deviceId }` on stream 3; the Mac activates **that pairing's own** row atomically (pending, not retired, younger than 10 minutes, account and recovery generation unchanged, all in one transaction) and answers `{ ok: true, result: { ok: true } }`, close 1000. A lost `pair.done` is harmless: the phone's first session `device.hello` activates the row under the same conditions. A pending row nobody activates within 10 minutes is deleted.
   - Both sides independently derive the durable 32-byte **`devicePsk`**:
     `devicePsk = HKDF-SHA256(ikm = pskEntropy, salt = h_pair, info = "toolroll-device-psk-v1:" || utf8(workspaceId) || ":" || utf8(deviceId), len = 32)`.
   - **Storage on Mac (plain truth):** Both peers need the raw 32-byte `devicePsk` for every `IKpsk2` handshake (a one-way hash cannot work). On the Mac, `device_psk` is stored **unencrypted in SQLite** (`companion_paired_device.device_psk`), and therefore appears in Workspace backups, protected at rest by OS file permissions (`0600`) and Toolroll's agent fence (`src/agent-fence.ts`, which denies Toolroll's own state folder and SQLite database to build/agent processes). This is why ADR 0001 unconditionally wipes `companion_paired_device` on backup restore. A retired phone's row keeps its keys for 30 days (with why: `removed | password_changed | access_changed | restored | migration | contested | pairing_failed`) so its next connection gets the authenticated refusal; then the row is deleted.
   - **Storage on iPhone:** Stored in iOS Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (never synced to iCloud Keychain, never backed up).
   - **Rotation:** not planned. A phone's PSK lives until the phone is removed (or its account's credentials change, which retires it); re-pairing is rotation.
   - **Restore wipe (ADR 0001):** Backup restore unconditionally deletes all `companion_paired_device` rows (including `device_psk` and `phone_static_pub`) and this Mac's companion keys, and increments `recoveryGeneration`. Before the keys go, the hosted relay is asked (best effort) to forget the machine's room.

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
- **Concurrency caps:** Max **8 concurrent open streams** per phone session, at most **2** of them live watch subscriptions. Excess streams return `ERROR(too_many_streams)`.
- **Deadlines:**
  - Multi-chunk `REQ_CHUNK` assembly deadline: **5 seconds** from chunk 0 to `END`.
  - Unary RPC response deadline: **30 seconds** from when the response is ready to send (the read itself isn't timed): the phone must take it all within that. With the Mac's own downstream pacing (§4) a 1 MiB diff goes out in about 5 seconds.
  - Live subscription idle deadline (no `CREDIT` or `PING/PONG`): **60 seconds** → `ERROR(idle_timeout)`.
- **Backpressure (distinct rules for unary responses vs. live watch streams):**
  - **Unary multi-part responses (e.g., `task.diff`):** Response `CHUNK` frames are **never dropped or coalesced**. If stream credit hits `0`, the daemon pauses emission and waits for `CREDIT` (up to the 30-second unary deadline, after which it sends `ERROR(deadline_exceeded)` and closes the stream).
  - **Live watch subscriptions (`run.watch.subscribe`):** When stream credit hits `0`, the daemon buffers at most **32 records OR 256 KiB** per stream, coalescing/truncating older live records with an explicit `{ k: "cut" }` marker.
  - **Memory caps:** everything held for one phone — request assembly, unary responses until they have gone out, and live-watch buffers — counts against **1 MiB per phone session**, and against **64 MiB daemon-wide** (a backstop: phones are also capped per link, 8 per relay link and 32 direct sockets). A watch record the budget can't take is dropped and reported as a cut.
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
- `0x03 PEER_CLOSE(connId, {reason, code?})` — a peer disconnected (relay → daemon), or the daemon drops one (daemon → relay; `code` is the phone's close code, e.g. 4403)
- `0x04 HEARTBEAT([8B BE ms])` daemon → relay every 20 s; `0x05 HEARTBEAT_ACK` relay → daemon echoes the 8 bytes. The Mac reconnects after 45 s without an ACK (a half-open socket after sleep or a network change).

The Mac validates every PEER_OPEN (`role` ∈ pair|device, `id` /^[A-Za-z0-9_-]{1,128}$/) and carries at most 8 phones per relay link. It paces what it sends each phone (12 MiB/min, burst 3 MiB per connection; 48 MiB/min, burst 12 MiB per hosted link) on plaintext frames before encryption, in one ordered queue per connection, so the relay's own limits never drop a phone; control frames (PONG, ERROR, pairing outcomes) skip the buckets.

**Machine lifecycle (Mac side).** The Mac keeps the relay's admitted set equal to its live and pending phones: a full PUT on every connect and every 10 minutes, POST on a confirmed pairing, DELETE on removal (in the background: Settings never waits on the relay). It registers only when a call answers 404 `machine_unknown`, maps refusals by their `Toolroll-Relay-Error` code (and honours `Retry-After`), backs off 30 s doubling to 10 minutes when another daemon with the same keys replaces it (4409, shown in Settings), and calls `DELETE /v1/machines/:id` when hosted access is turned off and before a restore retires its keys. Every token names the relay's host (`aud`); admission calls also name their method and exact path (`htm`, `htu`); see `relay/PROTOCOL.md` §3.3.

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
- **Honest migration story:** Moving relays is **not** a pure DNS flip because `machineId → relayMachinePub` and `deviceId → deviceRelayPub` registrations live in the relay's storage. Because `machineId` is deterministically derived from `relayMachinePub`, migrating `relay.toolroll.dev` off Cloudflare works cleanly via either (a) exporting/importing that small public-key registration table before DNS cutover, or (b) automatic daemon recovery on `404 machine_unknown` — the daemon re-registers `relayMachinePub` (reclaiming the **exact same `machineId`**) and re-syncs its live and pending phones' `deviceRelayPub` entries from local SQLite, with zero phone re-pairing required because `machineId`, `macStaticPub`, and `devicePsk` do not change.

---

## 4a. Direct Path (added 2026-11-27)

The phone reaches the Mac **directly** when it can (same Wi-Fi, or the Mac's tailnet) and through the **hosted relay** otherwise. Both carry the identical Noise `IKpsk2` byte stream; only the transport differs.

- **Direct endpoint** (on the Mac, port 4199 unless `TOOLROLL_PHONE_PORT`; if that is taken, 4200–4209 in order, and the bound port is kept in `companion_access.direct_port` and tried first next time; advertised over Bonjour as `_toolroll._tcp` with TXT `m=<machineId>` while it listens — `dns-sd` on macOS, `avahi-publish-service` on Linux when installed): `GET /v1/health` → `{ ok, machineId }` (credential-free reachability probe); WebSocket `GET /v1/direct?role=pair|device&id=…` with **no** Authorization header and no browser `Origin`. Binary messages are exactly what the relay carries as `PEER_DATA` payloads. The listener binds IPv4 and admits the raw TCP socket only from loopback, RFC 1918 and Tailscale (100.64/10) ranges, before HTTP sees it. It caps sockets globally and per address, rate-limits connections and upgrades per address, and enforces a 5 s header deadline.
- **`paths`** (QR and every `device.hello` result): 1–5 entries; ≤4 `direct` (`ws://<private IPv4 literal>:<port>/v1/direct`, never a hostname), ≤1 `hosted` (`wss://…/v1/connect`), hosted last, no duplicates. The phone replaces its stored list only after a hello that passed its identity checks.
- **Dialing:** probe every direct path's health in parallel (1.2 s); exactly one handshake on the first healthy one (4 s handshake+hello budget); any failure before Noise authenticates the Mac falls back once to hosted. "Removed" comes only from an authenticated refusal (a `refused` message 2 or a stream-0 ERROR after Noise) or the hosted relay's 403 `device_revoked`; every other refusal (401, 404, 429, 503) is retried.
- **Engine:** every phone connection belongs to a link (the hosted relay socket, or one direct socket) and is keyed by link + connection id; one authenticated session per device (a newer one supersedes); a relay drop ends only that link's sessions.
- **Hosted relay** is the operator's choice when turning phone access on (`TOOLROLL_RELAY_URL` names another; `off` removes it). Admission changes are serialized and a failed change is retried while connected.

## 4b. Where the implementation differs from this spec (as of the 2026-11-27 perfect pass)

Recorded so nobody relies on the design text alone:

- **No PSK rotation** (§2): not planned; re-pairing is rotation.
- **Ids** are `pair_` / `dev_` + 16 hex characters, not UUIDv4. Tables are `companion_access`, `companion_host_keys` and `companion_paired_device` (v187 migration); there is no `device_push_tokens`, `device_idempotency` or `account_passkeys` yet (Gate 2).
- **Host keys** (`noise_static_priv`, `relay_priv`) are stored in the workspace's SQLite database like other credentials. A restore deletes them, so a restored copy gets its own machine id and Noise key.
- **Restored workspace:** an old phone can't read the restored Mac's message 2 (the prologue binds `recoveryGeneration`), so no authenticated "restored" message is possible; the phone shows a hint ("Toolroll on your Mac was reset or restored. Pair again.") when a direct `/v1/health` answers a different machine id, while it keeps retrying.
- **Paired phones are derived authority.** Any change to the account's generation (password, rotation, access or role change, revocation) retires its phones in the same transaction (`password_changed` for a credential rotation, `access_changed` otherwise).
- **`device.hello`** returns `version, workspaceId, workspaceLabel, account, deviceId, toolroll`, plus `paths` (§4a) and `consoleUrl` (this console's address for Handoff, or null).
- **`task.approval.read`** answers a fixed placeholder ("Approve on your Mac."): Gate 1 reads approval terms from the step cards.
- **No CLI** for pairing or revoking (`toolroll phone pair`, `toolroll devices revoke`): Settings → Phone does both.
- **The direct listener admits loopback, RFC 1918 and Tailscale (100.64/10) peers**, not link-local.
- **Deadlines:** the Mac's message 1 deadline is 5 s from the socket opening; the pairing phone has 10 s from message 2 for `pair.ready`, the session phone 10 s for its hello.

## 5. End-to-End Encrypted Push Notifications

> **Not implemented yet.** Push is blocked on the owner's APNs key. Nothing below is built: there is no `push.register` RPC (it was removed from the paired-device allowlist), no push-token table, and no Notification Service Extension in the app. This section is the design for when it is.

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
