/**
 * Post-deploy smoke test for a relay (`npm run relay:smoke -- https://relay-staging.toolroll.dev`). Against the given
 * relay, with a throwaway machine key: health (and build id, when given), challenge + registration, daemon socket +
 * heartbeat, device admission, a device socket round trip both ways, revocation, then DELETE of the machine (the
 * throwaway room is gone afterwards). Exits non-zero on the first failure.
 *
 *   tsx relay/cloudflare/scripts/smoke.ts <relay base URL> [expected build id]
 */
import { RelayOp } from "../../../src/companion/relay-auth.js";
import {
  admin,
  admit,
  closeOf,
  connectDaemon,
  newPhone,
  openPhone,
  refusedWith,
  register,
  deviceToken,
  type RelayTarget,
} from "../../conformance/client.js";

const [base, expectedBuild] = process.argv.slice(2);
if (base === undefined || !/^https?:\/\//.test(base)) {
  console.error("usage: smoke.ts <relay base URL, e.g. https://relay-staging.toolroll.dev> [expected build id]");
  process.exit(2);
}
const url = new URL(base);
const target: RelayTarget = {
  name: url.host,
  url: url.origin,
  wsUrl: `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}/v1/connect`,
  publicHost: url.host.toLowerCase(),
  timing: { phoneFirstFrameMs: 10_000, phoneIdleMs: 90_000, daemonSilenceMs: 60_000 },
  replayRows: async () => 0,
  close: async () => {},
};

async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

await step("health", async () => {
  const res = await fetch(`${target.url}/v1/health`);
  const body = (await res.json()) as { ok?: boolean; version?: number; build?: string };
  check(res.status === 200 && body.ok === true && body.version === 1, `health answered ${res.status} ${JSON.stringify(body)}`);
  if (expectedBuild !== undefined) check(body.build === expectedBuild, `build ${body.build}, expected ${expectedBuild}`);
});

const machine = await register(target).catch(error => { console.error(`FAIL register: ${error instanceof Error ? error.message : error}`); process.exit(1); });
console.log("ok   challenge + register");
const daemon = await connectDaemon(target, machine).catch(error => { console.error(`FAIL daemon socket: ${error instanceof Error ? error.message : error}`); process.exit(1); });
console.log("ok   daemon socket + heartbeat");
const phone = newPhone("smoke_device");

await step("device admission + round trip", async () => {
  await admit(target, machine, [phone]);
  const p = await openPhone(target, machine, daemon, phone);
  daemon.data(p.connId, Buffer.from("pong"));
  check((await p.inbox.next("the downstream frame")).toString("utf8") === "pong", "downstream frame mismatch");
  const res = await admin(target, machine, "DELETE", `/v1/machines/${machine.machineId}/devices/${phone.deviceId}`);
  check(res.status === 200, `DELETE device answered ${res.status}`);
  check((await closeOf(p.ws)).code === 4403, "revoked phone not closed 4403");
  check((await daemon.expect(RelayOp.PEER_CLOSE)).connId === p.connId, "no PEER_CLOSE for the revoked phone");
  const refused = await refusedWith(target, deviceToken(target, machine, phone));
  check(refused.status === 403 && refused.code === "device_revoked", `revoked device answered ${refused.status} ${refused.code}`);
});

await step("delete the throwaway machine", async () => {
  const res = await admin(target, machine, "DELETE", `/v1/machines/${machine.machineId}`);
  check(res.status === 200, `DELETE machine answered ${res.status}`);
  await closeOf(daemon.ws);
});
console.log(`smoke passed: ${target.url}`);
