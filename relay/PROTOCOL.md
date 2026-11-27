# Toolroll Portable Companion Relay Wire Protocol (`v1`)

A relay forwards end-to-end-encrypted Noise messages between one Mac (the daemon) and its paired phones. It holds no Noise keys and never sees plaintext. Both implementations in this repo speak exactly this contract and are tested against it: the Node reference relay (`src/companion/relay-server.ts`, run by `src/companion/relay-conformance.test.ts` and `service.test.ts`) and the Cloudflare Worker (`relay/cloudflare/`, checked end to end with the same Mac code before each deploy).

The relay is the phone's path **from elsewhere**. On the Mac's own network the phone connects to the Mac directly (no relay; `docs/plans/companion-app/noise-relay-protocol.md` §4a).

## Endpoints

1. **`GET /v1/health`** → `200 { "ok": true, "version": 1, ... }`
2. **`POST /v1/challenge`** → `200 { "challenge": "<string>", "expiresInSec": 60 }`: a registration challenge. It is opaque to the Mac. The reference relay issues single-use random ones; the Cloudflare relay issues stateless HMAC-signed ones valid for 60 s.
3. **`POST /v1/machines/register`**
   - Body: `{ "relayMachinePub": "<base64url(32B Ed25519)>", "challenge": "<string>", "signature": "<base64url(64B Ed25519)>" }`
   - Signature covers UTF-8 `"register\0" || host || "\0" || challenge`, where `host` is the relay's public host (`relay.toolroll.dev`).
   - Relay derives `machineId = base32_lower(SHA-256("toolroll-machine-id-v1\0" || relayMachinePub))[0..26]` and returns `200 { "machineId": "<26-char>" }`. The id is derived from the key, so nobody can take over another machine's id.
4. **`PUT /v1/machines/:machineId/devices`** (`Authorization: Bearer <role=daemon token>`)
   - Body: `{ "devices": [{ "deviceId": "<string ≤128>", "deviceRelayPub": "<base64url(32B Ed25519)>" }, ...] }` (at most 32).
   - Replaces the machine's whole admitted set and closes any phone socket whose device left the set. The Mac sends it after every connect and after any change that didn't reach the relay, so a relay that restarted empty or missed a removal ends up with the right set.
5. **`POST /v1/machines/:machineId/devices`** (`Authorization: Bearer <role=daemon token>`)
   - Body: `{ "deviceId": "<string ≤128>", "deviceRelayPub": "<base64url(32B Ed25519)>" }`: admits one phone (a pairing made through the relay).
6. **`DELETE /v1/machines/:machineId/devices/:deviceId`** (`Authorization: Bearer <role=daemon token>`)
   - Removes the device and closes any socket it has open.
7. **`WS /v1/connect`** (`Authorization: Bearer <token>`, verified BEFORE the WebSocket upgrade)
   - `role=daemon`: verified against `relayMachinePub`. One daemon per machine; a new one replaces the old.
   - `role=pair`: verified against `relayMachinePub`. Must carry `pairSessionId`.
   - `role=device`: verified against the admitted `deviceRelayPub` for `(machineId, deviceId)`.
   - Token: `base64url(JSON claims) "." base64url(Ed25519 signature over "tr-relay-v1." || part 1)`. Claims are `v: 1`, `role`, `machineId`, `jti` (string), `iat` and `exp` (TTL ≤ 300 s), plus `deviceId` or `pairSessionId` (strings ≤128) for those roles. Anything else is refused.
   - A phone that connects while no daemon is connected may be refused with `503` (Cloudflare) or held until a daemon connects (reference). The Mac handles both.

## Multi-Phone Routing Envelope (daemon leg only)

- Phone sockets send and receive raw binary Noise messages (`≤ 65,535 B`).
- The daemon socket sends and receives binary envelopes with a 5-byte prefix:
  - `0x01 PEER_OPEN`  `[4B connId BE][UTF-8 JSON { "role": "pair" | "device", "id": "<pairSessionId or deviceId>" }]`
  - `0x02 PEER_DATA`  `[4B connId BE][raw Noise message ≤ 65,535 B]`
  - `0x03 PEER_CLOSE` `[4B connId BE][UTF-8 JSON { "reason": "<string>" }]`
- A `connId` is never reused while the relay holds the machine, so a late `PEER_CLOSE` can't name a newer phone.

## Abuse controls

- Tokens are verified before the upgrade, and requests are rate limited per client address (Cloudflare: Workers Rate Limiting, IPv6 keyed by /64).
- Phone sockets must send their first message within 10 s and are closed after 90 s of silence (the app pings well within that).
- Frames are capped at 65,535 B on the phone leg (65,540 B on the daemon leg) and must be binary.
- Each machine has at most 4 concurrent phone/pair sockets and at most 32 admitted devices.
- Each phone is limited to 600 frames/min and 4 MiB/min. Each machine is limited to 32 MiB/min on Cloudflare; the reference relay uses its own buckets. A phone over a limit is closed. The daemon's replies are paced by the Mac's flow control and never get the daemon closed because of a phone.
- Storage is written only when something changes (registration, the admitted set, the connection counter).
- The reference relay also has a global circuit breaker and holds at most 1,000 machines.
