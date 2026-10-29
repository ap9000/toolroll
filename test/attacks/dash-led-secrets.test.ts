/**
 * A password or token that starts with "--" (0.9.76: about 1 in 4096 minted passwords; a random fixture password made
 * "held stays held until a person allows it" fail on main CI). Guard: every CLI parser takes a secret flag's value as the
 * next argument whatever it looks like, and `--token=<value>` too; newly minted secrets never start with "-". A wrong or
 * missing secret still authenticates nothing.
 */
import { afterEach, describe, expect, test } from "vitest";
import { releaseFixture, RELEASE_NOW, type ReleaseFixture } from "../release-fixture.js";
import { runReleaseCommand } from "../../src/release-cli.js";
import { runOperate } from "../../src/operate.js";
import { autoPublishHeld, holdAutoPublish } from "../../src/release-auto.js";
import { mintSecret } from "../../src/secret-mint.js";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const LATER = new Date(RELEASE_NOW.getTime() + 60_000);
const DASHED = "--Zx9-dash-led-password";

async function operate(f: ReleaseFixture, command: string, args: string[]) {
  const lines: string[] = [];
  const code = await runOperate(command, args, line => lines.push(line), { databaseFile: f.databaseFile, now: LATER });
  return { code, out: lines.join("\n") };
}
const publishOk = (f: ReleaseFixture, ...token: string[]) => runReleaseCommand(["publish-ok", f.taskId, "--as", "alex", ...token, "--json"], () => {}, { database: f.databaseFile, now: () => LATER });

describe("a secret that starts with \"--\"", () => {
  test("approves a task through `task approve`, as the next argument and as --token=<value>", async () => {
    const f = (fixture = releaseFixture({ approve: false, password: DASHED }));
    const digest = f.store.getScope(f.taskId)!.digest;
    expect((await operate(f, "task", ["approve", f.taskId, "--digest", digest, "--as", "alex", "--token", "--wrong-but-dashed", "--yes", "--json"])).code).not.toBe(0);
    expect(f.store.getScope(f.taskId)!.approvedAt ?? null).toBeNull();
    const yes = await operate(f, "task", ["approve", f.taskId, "--digest", digest, "--as", "alex", "--token", DASHED, "--yes", "--json"]);
    expect(yes.code, yes.out).toBe(0);
    expect(f.store.getScope(f.taskId)!.approvedBy).toBe("alex");
  });

  test("--token=<value> carries it too", async () => {
    const f = (fixture = releaseFixture({ approve: false, password: DASHED }));
    const digest = f.store.getScope(f.taskId)!.digest;
    const yes = await operate(f, "task", ["approve", f.taskId, "--digest", digest, "--as", "alex", `--token=${DASHED}`, "--yes", "--json"]);
    expect(yes.code, yes.out).toBe(0);
  });

  test("lets a held publication go on through `release publish-ok`, as the next argument and as --token=<value>", async () => {
    const f = (fixture = releaseFixture({ password: DASHED }));
    holdAutoPublish(f.store, { taskId: f.taskId, why: "Checks stopped passing after the merge", now: LATER });
    // A wrong dash-led secret is a wrong password, never a pass.
    expect(await publishOk(f, "--token", "--not-the-password")).not.toBe(0);
    expect(autoPublishHeld(f.store, f.taskId)).not.toBeNull();
    expect(await publishOk(f, "--token", DASHED)).toBe(0);
    expect(autoPublishHeld(f.store, f.taskId)).toBeNull();
    holdAutoPublish(f.store, { taskId: f.taskId, why: "Held again", now: LATER });
    expect(await publishOk(f, `--token=${DASHED}`)).toBe(0);
    expect(autoPublishHeld(f.store, f.taskId)).toBeNull();
  });

  test("a missing secret is still a usage error, never an empty password", async () => {
    const f = (fixture = releaseFixture({ password: DASHED }));
    holdAutoPublish(f.store, { taskId: f.taskId, why: "held", now: LATER });
    expect(await runReleaseCommand(["publish-ok", f.taskId, "--as", "alex", "--token"], () => {}, { database: f.databaseFile, now: () => LATER })).toBe(2);
    expect(autoPublishHeld(f.store, f.taskId)).not.toBeNull();
  });
});

test("minted secrets never start with \"-\", however the draw comes out", () => {
  const draws = [Buffer.from([0xfb, 0xef, 0xbe]), Buffer.from([0xf8, 0x00, 0x00]), Buffer.from([0x01, 0x02, 0x03])];
  let at = 0;
  // "+++" in base64 is "---" in base64url; 0xf8 starts with "-" too; the third draw doesn't.
  expect(mintSecret(3, () => draws[at++]!)).toBe(Buffer.from([0x01, 0x02, 0x03]).toString("base64url"));
  expect(at).toBe(3);
  for (let n = 0; n < 5000; n++) expect(mintSecret(16).startsWith("-")).toBe(false);
});
