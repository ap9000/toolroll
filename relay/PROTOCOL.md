# Toolroll Portable Companion Relay Wire Protocol (`v1`)

Any relay implementation passing `relay/conformance/relay-conformance.test.ts` is drop-in compatible with Toolroll daemons and the native iOS Companion App.

## Endpoints

1. **`GET /v1/health`** → `200 { "ok": true, "version": 1 }`
2. **`POST /v1/challenge`** → `200 { "challenge": "<base64url(32B)>", "expiresInSec": 60 }` (single-use registration challenge)
3. **`POST /v1/machines/register`**
   - Body: `{ "relayMachinePub": "<base64url(32B Ed25519)>", "challenge": "<string>", "signature": "<base64url(64B Ed25519)>" }`
   - Signature covers UTF-8 `"register\0" || host || "\0" || challenge`.
   - Relay derives `machineId = base32_lower(SHA-256("toolroll-machine-id-v1\0" || relayMachinePub))[0..26]` deterministically and returns `200 { "machineId": "<26-char>" }`.
4. **`POST /v1/machines/:machineId/devices`** (requires `Authorization: Bearer <role=daemon token>`)
   - Body: `{ "deviceId": "<string>", "deviceRelayPub": "<base64url(32B Ed25519)>" }`
   - Registers a paired phone's relay key for pre-upgrade admission.
5. **`DELETE /v1/machines/:machineId/devices/:deviceId`** (requires `Authorization: Bearer <role=daemon token>`)
   - Immediately removes the device's relay key and closes any active socket for `deviceId`.
6. **`WS /v1/connect`** (requires `Authorization: Bearer <token>` BEFORE WebSocket upgrade)
   - `role=daemon`: verified against `relayMachinePub`. Owns the single daemon slot for `machineId`.
   - `role=pair`: verified against `relayMachinePub`. Must include `pairSessionId`.
   - `role=device`: verified against registered `deviceRelayPub` for `(machineId, deviceId)`.

## Multi-Phone Routing Envelope (Daemon Leg Only)

- Phone sockets send/receive raw opaque binary Noise messages (`<= 65,535 B`).
- Daemon socket sends/receives 5-byte prefixed binary envelopes:
  - `0x01 PEER_OPEN`  `[4B connId BE][UTF-8 JSON { role, deviceId?, pairSessionId? }]`
  - `0x02 PEER_DATA`  `[4B connId BE][raw binary Noise message <= 65,535 B]`
  - `0x03 PEER_CLOSE` `[4B connId BE][UTF-8 JSON { reason }]`

## Mandatory Abuse Controls

- Pre-upgrade Ed25519 token verification (max 5-minute TTL).
- Relay enforces 5-second first-frame deadline & 60-second idle timeout (relay holds zero Noise keys).
- Max 65,535 B binary frame on phone leg (65,540 B on daemon leg).
- Max 4 concurrent phone/pair sockets per `machineId`.
- Per-phone rate limit: 600 frames/min sustained (120 burst) and 4 MiB/min sustained (2 MiB burst).
- Per-machine aggregate cap: 2,400 frames/min and 16 MiB/min.
- Global frame/spend circuit breaker returning `503` when exceeded.
