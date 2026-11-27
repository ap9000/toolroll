# Toolroll companion relay — wire protocol `v1` (normative)

A relay forwards end-to-end-encrypted Noise messages between one Mac (the **daemon**) and its paired phones. It holds
no Noise keys, never sees plaintext and cannot authorize any Toolroll act. On the Mac's own network the phone talks to
the Mac directly; the relay is the path from elsewhere (`docs/plans/companion-app/noise-relay-protocol.md` §4a).

Two implementations follow this document exactly:

- the **hosted relay**, a Cloudflare Worker with one Durable Object per machine (`relay/cloudflare/`);
- the **reference relay**, plain Node.js for self-hosting and tests (`src/companion/relay-server.ts`,
  `relay/reference/`).

One conformance suite (`relay/conformance/suite.ts`) runs against both over real HTTP and WebSockets — the reference
relay in the root unit suite, the worker under Miniflare in `npm run relay:test` (`.github/workflows/relay.yml`). A
machine-readable copy of the tables below is `test/fixtures/companion-relay-contract.json`; the numbers shared with the
Mac and the phone are in `test/fixtures/companion-wire.json`. "MUST" and "MUST NOT" are normative.

## Endpoints

| Method | Path | Auth | Body cap | Rate limits |
|---|---|---|---|---|
| GET | `/v1/health` | none | — | none |
| POST | `/v1/challenge` | none | — | register |
| POST | `/v1/machines/register` | challenge + proof of possession | 4 KiB | register |
| PUT | `/v1/machines/:machineId/devices` | daemon token, `htm`/`htu` | 16 KiB | client, then connect |
| POST | `/v1/machines/:machineId/devices` | daemon token, `htm`/`htu` | 4 KiB | client, then connect |
| DELETE | `/v1/machines/:machineId/devices/:deviceId` | daemon token, `htm`/`htu` | — | client, then connect |
| DELETE | `/v1/machines/:machineId` | daemon token, `htm`/`htu` | — | client, then connect |
| GET (upgrade) | `/v1/connect` | daemon, pair or device token, no `htm`/`htu` | — | client, then connect |

- **Health** answers `200 {ok: true, version: 1, runtime, build, configured: {...}}`; `configured` holds booleans only
  (whether the public host, the challenge secret and the rate limits are set — never values). A misconfigured or
  load-shedding relay answers `503` with `ok: false`.
- **Challenge**: `200 {challenge, expiresInSec: 60}`, opaque to the Mac. Both relays issue stateless challenges: 16
  random bytes and an expiry, HMAC-SHA256 signed. The current secret signs; the previous one is also accepted while a
  secret is being rotated (`CHALLENGE_SECRET` / `CHALLENGE_SECRET_PREVIOUS`).
- **Register**: body `{relayMachinePub, challenge, signature}`. `relayMachinePub` is a 32-byte Ed25519 key in unpadded
  base64url. `signature` covers UTF-8 `"register\0" || publicHost || "\0" || challenge`. `publicHost` is the relay's
  **configured** public host (`RELAY_PUBLIC_HOST`, lowercase) and never the request's `Host` header. The relay derives
  `machineId = base32_lower(SHA-256("toolroll-machine-id-v1\0" || relayMachinePub))[0..26]` and answers
  `200 {machineId}`. Registration is idempotent. Only registration creates a machine's storage: a request for an
  unregistered machine id writes nothing.
- **PUT devices**: body `{devices: [{deviceId, deviceRelayPub}]}`, at most 32 entries with unique ids. It replaces the
  admitted set in one atomic step. A device that leaves the set gets a tombstone holding its stored key; its open
  sockets are closed `4403`, and the daemon receives `PEER_CLOSE {reason: "device_revoked"}`. A device whose key
  changed has its open sockets closed `4409`. A device that is (re-)admitted loses its tombstone. Only rows that
  change are written. The Mac re-PUTs the full set every 10 min.
- **POST devices**: body `{deviceId, deviceRelayPub}`. It admits one device. A 33rd device is refused `400`. Posting
  an already-admitted device with the same key changes nothing.
- **DELETE device**: tombstones the device with its stored key and closes its sockets `4403`. It answers `200` even
  when the device is not admitted.
- **DELETE machine**: deletes the room (devices, tombstones, replay rows, everything). The daemon socket is closed
  `1000 machine_deleted` and phones are closed `4503`. The Mac calls it when hosted access is turned off and before it
  retires its host keys on restore. Afterwards every call answers `404 machine_unknown` until the machine registers
  again.

Ids: `machineId` `/^[a-z2-7]{26}$/`; `deviceId` and `pairSessionId` `/^[A-Za-z0-9_-]{1,128}$/`.

## Refusals

Every refusal has a JSON body `{"error": "<code>"}` and the header `Toolroll-Relay-Error: <code>`, on plain HTTP and on
a refused WebSocket upgrade alike (`URLSessionWebSocketTask` exposes headers but not bodies). The set of codes is
closed: a relay MUST NOT answer any other.

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | Malformed body or params, bad key length, more than 32 devices, body over its cap, `/v1/connect` without a WebSocket upgrade, no such endpoint or method. |
| 401 | `token_invalid` | Missing or malformed token, bad signature, wrong `aud`/`htm`/`htu`, unknown or bad claims, replayed `jti`, wrong role. On registration: bad or expired challenge, bad proof of possession. |
| 401 | `token_expired` | `exp ≤ now − 30`. Sent with a `Date` header. |
| 401 | `token_not_yet_valid` | `iat > now + 30`. Sent with a `Date` header. |
| 403 | `device_revoked` | A device token that verifies against the device's tombstone key. |
| 404 | `machine_unknown` | No registration for this machine id. |
| 404 | `device_unknown` | No live row and no tombstone for the device, and a daemon is connected. |
| 429 | `rate_limited` | A rate limit, or the relay shedding load (misconfigured; reference: circuit breaker, room cap with nothing evictable). Sent with `Retry-After`. |
| 429 | `too_many_peers` | 4 phone/pair sockets are already open for the machine. Sent with `Retry-After`. |
| 429 | `replay_cache_full` | The token's principal has spent its replay budget (see "Replay"). Sent with `Retry-After`. |
| 503 | `daemon_unavailable` | A phone connects, or an unknown device asks, while no daemon is connected. |

The phone treats only `device_revoked` (and an encrypted refusal from the Mac itself) as terminal. Every other code
means "unreachable for now", and the phone retries.

### Connect order (`/v1/connect`)

1. Per-client rate limit (`429 rate_limited`).
2. Parse the token (`401 token_invalid`), then the per machine + client rate limit (`429 rate_limited`).
3. Is the machine registered? (`404 machine_unknown`)
4. Device tokens: take the live device row, else the tombstone. If there is neither: no daemon → `503
   daemon_unavailable`, otherwise `404 device_unknown`. Daemon and pair tokens use the machine key.
5. Verify the Ed25519 signature against that key (`401 token_invalid`).
6. **After the signature await**, re-read the state: same machine, same device key and same live/tombstone state,
   else `401 token_invalid`.
7. Check the claims. This writes nothing (`401 token_*`).
8. Tombstone? → `403 device_revoked`. This happens **before** the `jti` is consumed, so a revoked device never writes
   to the replay cache.
9. Consume the `jti` from its principal's budget, synchronously in the same turn (`401 token_invalid` when replayed,
   `429 replay_cache_full` when the budget is spent).
10. Phones: no live daemon → `503 daemon_unavailable`.
11. Reserve the slot, synchronously. Older sockets of the same device are closed `4409` (the daemon receives
    `PEER_CLOSE {reason: "superseded"}` and then `PEER_OPEN` for the new one). Otherwise, at 4 phone/pair sockets →
    `429 too_many_peers`. A new daemon supersedes the old one (see "Daemon").
12. `101`.

Steps 6 to 11 run with no await in between. Admission calls (PUT/POST/DELETE) follow the same shape: rate limits →
token → machine (`404`) → signature → re-read → claims with `htm`/`htu` → `jti` → body (`400`) → one atomic write.

**Residual oracle (accepted):** without credentials a caller can tell whether a machine id or a device id exists.
Ids are random (the machine id is a key hash; a device id is 64 random bits) and carry no data.

## Tokens

```
token = base64url(JSON claims) "." base64url(Ed25519 signature over "tr-relay-v1." || part1)
```

- Unpadded base64url. The claims part is at most 1024 bytes. The signature is 64 bytes.
- Claims are **exactly** these keys; any other key → `token_invalid`:
  - `v` = 1
  - `role` ∈ `daemon` | `pair` | `device`
  - `machineId`
  - `aud` = the relay's configured public host, lowercase, exact string match
  - `jti` `/^[A-Za-z0-9_-]{16,64}$/`
  - `iat`, `exp`: integer seconds, `0 < exp − iat ≤ 300`, `iat ≤ now + 30`, `exp > now − 30`
  - `deviceId` (device tokens only, required) / `pairSessionId` (pair tokens only, required)
  - HTTP admission calls only: `htm` ∈ `PUT` | `POST` | `DELETE` and `htu` = the exact request path (no query, no
    trailing slash). Admission calls take only daemon tokens. WebSocket tokens MUST NOT carry `htm`/`htu`.
- Keys: daemon and pair tokens verify against `relayMachinePub`; device tokens verify against the admitted (or
  tombstoned) `deviceRelayPub`.
- A token minted for one relay is refused by every other one (`aud`). A token for one call is refused for any other
  call (`htm`/`htu`).

### Replay

- Daemon and device `jti`s are single use. Pair `jti`s allow at most 3 uses: the token rides in the QR code, the phone
  may retry, and two phones may scan one code (the Mac decides which one wins).
- Ids are remembered **per principal** (the daemon, one `deviceId` or one `pairSessionId`) until 30 s after the
  token's `exp`. Each principal has its own budget, so no principal can fill the cache for another:

  | Principal | Own budget | Class total |
  |---|---|---|
  | daemon | 512 rows, reserved | 512 |
  | each `deviceId` | 64 rows | 32 × 64 |
  | each `pairSessionId` | 16 rows | 4 × 16 |

  Over a budget (after dropping expired rows), the relay answers `429 replay_cache_full` to that principal only.
- Hosted relay: a Durable Object SQLite table `jti(principal, kind, id, exp, uses, PRIMARY KEY (principal, id))`,
  indexed on `exp` and `kind`. A token is consumed in one synchronous statement. Expired rows are pruned by
  `DELETE … WHERE exp < now − 30` in the alarm (and inline before a refusal). Reference relay: per-room maps with the
  same keys and budgets.
- Cost note: a healthy Mac mints about one daemon token per (re)connect plus one per admission call. A phone mints one
  per connect. A phone that reconnects more than 64 times within one token lifetime (+30 s) waits for its oldest rows
  to expire.

## Daemon-leg envelope

Phone sockets carry raw binary Noise messages (≤ 65,535 B). The daemon socket carries binary envelopes with a 5-byte
header `[1B op][4B connId, big-endian][payload]`:

| Op | Name | Direction | Payload |
|---|---|---|---|
| `0x01` | `PEER_OPEN` | relay → daemon | UTF-8 JSON `{"role": "pair" \| "device", "id": "<pairSessionId or deviceId>"}` |
| `0x02` | `PEER_DATA` | both | one Noise message ≤ 65,535 B |
| `0x03` | `PEER_CLOSE` | both | UTF-8 JSON `{"reason": "<string>"}` |
| `0x04` | `HEARTBEAT` | daemon → relay | connId 0, 8-byte big-endian millisecond timestamp |
| `0x05` | `HEARTBEAT_ACK` | relay → daemon | connId 0, the heartbeat's 8 bytes echoed |

- A `connId` is never reused while the room exists, so a late `PEER_CLOSE` can't name a newer phone.
- The relay sends `PEER_CLOSE` at most once per phone, only to the daemon that saw its `PEER_OPEN`. It is never sent
  for a close the daemon initiated, and never sent to a newer daemon for phones of an older one.
- A frame the daemon sends for a phone that is gone is dropped silently. So is anything a phone sends after the relay
  or the daemon dropped it.
- From the daemon, any other opcode, `PEER_OPEN`/`HEARTBEAT_ACK`, a malformed heartbeat, a text frame, or a frame
  shorter than 5 B or longer than 65,540 B closes the daemon `4400`.

## Close codes

| Code | Reason(s) | Meaning |
|---|---|---|
| 4400 | `binary_only`, `oversize`, `protocol` | Text frame, frame over the cap, bad envelope or opcode. |
| 4403 | `device_revoked` | The device was removed (DELETE or PUT). |
| 4408 | `first_frame_timeout`, `idle_timeout`, `heartbeat_timeout` | A deadline passed (see "Limits", "Daemon"). |
| 4409 | `superseded` | A newer socket for the same device, or a newer daemon. A device whose key changed also gets it. |
| 4429 | `rate_limited` | The phone went over a byte or frame budget. |
| 4503 | `daemon_gone` | The phone's daemon left, was superseded, went silent or its machine was deleted. |
| 1000 | `closed_by_daemon`, `machine_deleted` | The daemon closed the phone; the daemon's own machine was deleted. |

Frames far beyond the cap (over 128 KiB on the reference relay; over the runtime's message limit on Cloudflare) may be
refused by the WebSocket layer itself with `1009`.

### Clients send first

Both clients MUST send a frame right after the upgrade: the phone sends its Noise message 1, and the Mac sends its first
`HEARTBEAT`. workerd (the Cloudflare runtime, also under Miniflare) never delivers a server-initiated close frame to a
hibernated WebSocket that has not yet delivered a message to the object. Without that first frame, a phone or daemon
closed early (superseded, revoked, timed out) would not hear its close code. Client-initiated closes are always
answered: the client gets its own code back.

## Daemon

- One daemon per machine. A new daemon socket (which proved the machine key) supersedes the old one: the old one is
  closed `4409`, and its phones are closed `4503` with no `PEER_CLOSE` to anyone. The relay only ever routes to the
  current daemon, never to an older socket still closing. The Mac backs off on `4409`, from 30 s doubling to 10 min.
- **Heartbeat** (application level, both relays): the Mac sends `HEARTBEAT` every 20 s (the first one right after the
  upgrade) and reconnects after 45 s without an ACK. The relay answers each with `HEARTBEAT_ACK`. It closes a daemon
  `4408 heartbeat_timeout` after 60 s with no frame of any kind from it. WebSocket protocol pings do not count: the
  hosted runtime answers them without waking the object. No `setWebSocketAutoResponse`.
- When the daemon leaves, its phones are closed `4503`.

## Limits

| Limit | Value |
|---|---|
| Phone first frame | 10 s after the upgrade, else `4408 first_frame_timeout` |
| Phone idle | 90 s without a frame **in either direction**, else `4408 idle_timeout` |
| Daemon silence | 60 s without a frame from it, else `4408 heartbeat_timeout` |
| Phone/pair sockets per machine | 4 (only open sockets the relay hasn't dropped count) |
| Admitted devices per machine | 32 |
| Tombstones per machine | 256 (oldest dropped), each kept 30 days |
| Phone up | 600 frames/min (burst 120), 4 MiB/min (burst 1 MiB) |
| Phone down | 16 MiB/min (burst 4 MiB) |
| Machine up (all phones → daemon) | 32 MiB/min (burst 8 MiB) |
| Machine down (daemon → all phones) | 64 MiB/min (burst 16 MiB) |
| Rate limit: client | 600/min per client address across all machines, on connects and admission calls, checked first |
| Rate limit: connect | 120/min per machine id + client address, on connects and admission calls |
| Rate limit: register | 20/min per client address, challenges and registrations together |

- Byte and frame limits are token buckets: the burst is the capacity, and it refills at the per-minute rate. Over any
  of them, the offending **phone** is closed `4429` (a downstream frame over budget is not sent). The daemon is never
  closed for a phone's traffic. The Mac paces its downstream below the phone-down budget (12 MiB/min, burst 3 MiB per
  phone).
- A client address is the IPv4 address or the IPv6 /64. The hosted relay reads it from `CF-Connecting-IP`. The
  reference relay reads the socket address, or the last `X-Forwarded-For` entry when `TRUST_PROXY=1`.
- Hosted relay: Workers Rate Limiting bindings `RL_CLIENT`, `RL_CONNECT` and `RL_REGISTER` are all checked in the
  Worker before any Durable Object is touched. Their windows are approximate and per location; `Retry-After: 60`.
  Reference relay: in-memory token buckets with the same rates and an exact `Retry-After`.
- Tests may shorten the three deadlines: `RELAY_PHONE_FIRST_FRAME_MS`, `RELAY_PHONE_IDLE_MS` and
  `RELAY_DAEMON_SILENCE_MS` on the worker, or options on the reference relay. An override can never lengthen one.

## Machine lifecycle

- A room exists from registration until `DELETE /v1/machines/:id`, or until **90 days** pass without a daemon connect.
  The hosted relay records the last daemon connect at most once a day; its alarm deletes the room. The reference relay
  deletes it in an hourly sweep.
- Tombstones (written by DELETE device, and by PUT for devices that left the set) keep the stored key for 30 days, so
  a removed phone hears `403 device_revoked`. After that, the device is simply unknown.
- **Hosted relay, hibernation:** every per-socket deadline and bucket lives in the socket's attachment. The first frame
  is written at once; the rest is at most 1 s behind. A fresh object after eviction therefore decides exactly as the
  evicted one would have. The alarm is set to the earliest upcoming deadline across sockets plus the far housekeeping
  deadlines (expired `jti` rows, tombstone expiry, the 90-day GC). Once no sockets remain, only the housekeeping alarm
  is left.
- **Reference relay, extra limits for self-hosting:** at most 1,000 rooms (`MAX_ROOMS`). At the cap, only the oldest
  idle room (no daemon, no phones) that holds **no admitted devices and no tombstones** makes way; a room holding
  either is evicted only once it has been idle past the 90-day window. With nothing evictable, registration answers
  `429 rate_limited`. A registration flood therefore never erases a real machine's phones or revocations. Also: 64
  open sockets per client address, short header and request timeouts, and an optional circuit breaker
  (`globalFramesPerMin`). The breaker is a per-minute window that closes again on its own; while it is open the relay
  answers `429 rate_limited` and health answers `503`. All state is in memory: after a restart, the Mac sees `404
  machine_unknown`, registers again and re-PUTs its devices.

## Operating the hosted relay

- `npm run relay:deploy` runs typecheck and the relay tests, then deploys to staging (`relay-staging.toolroll.dev`,
  its own counters and secrets) with `BUILD_ID` = the commit, then smoke-tests staging (`relay/cloudflare/scripts/
  smoke.ts`: health and build, registration, daemon heartbeat, device round trip, revocation, machine delete), then
  production, then smoke-tests production. `--plan` prints the steps without running them.
- Workers Logs are on. The relay logs one JSON line per open, refusal and close: route, status, code, role and a short
  machine-id prefix. It never logs tokens, keys, challenges or full ids.
- Not built (see `docs/plans/companion-app/noise-relay-protocol.md`): proof of work on registration and a hard
  spending cap. Recommended instead: a Cloudflare usage alert on the account.
