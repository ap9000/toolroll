/**
 * Why the sandbox can't start (sandbox-runtime.ts sandboxRuntimeDiagnosis and its advice): a denial names its cause
 * only from a setting this machine shows, never says "install" when the programs are there, puts an administrator's
 * targeted fix before weakening a container, and points at the existing opt-in without changing who may use it.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noConfinementWords, sandboxAdviceLines, sandboxRemedyLines, UNCONFINED_OPT_IN, userNamespaceCause, type SandboxDiagnosis, type SandboxIo } from "./sandbox-runtime.js";
import { runOperate } from "./operate.js";
import { openStore } from "./store.js";

/** A machine whose readable files are `files` (anything else can't be read) and that has `markers`. */
const machine = (files: Record<string, string>, markers: readonly string[] = []): SandboxIo => ({
  read: file => { const one = files[file]; if (one === undefined) throw Object.assign(Error("EACCES"), { code: "EACCES" }); return one; },
  exists: file => markers.includes(file),
});
const denied = (io: SandboxIo): SandboxDiagnosis => {
  const cause = userNamespaceCause(io);
  return { ok: false, kind: "sandbox-denied", cause, detail: "bwrap: setting up uid map: Permission denied", why: cause === null ? "denied; the cause isn't visible from inside this machine" : `denied: ${cause.words}` };
};

test.each([
  ["Ubuntu's AppArmor restriction", { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n" }, /AppArmor restricts/],
  ["Debian's switch off", { "/proc/sys/kernel/unprivileged_userns_clone": "0\n" }, /kernel\.unprivileged_userns_clone = 0/],
  ["no user namespaces at all", { "/proc/sys/user/max_user_namespaces": "0\n" }, /user\.max_user_namespaces = 0/],
  ["the settings allow them (so something else denies it)", { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0\n", "/proc/sys/kernel/unprivileged_userns_clone": "1\n", "/proc/sys/user/max_user_namespaces": "15000\n" }, null],
  ["nothing readable", {}, null],
] as const)("a denial's cause comes only from a readable setting: %s", (_, files, words) => {
  const cause = userNamespaceCause(machine(files));
  if (words === null) expect(cause).toBeNull();
  else expect(cause?.words).toMatch(words);
});

test("the advice: the evidenced fix first; in a container a targeted profile before flags that weaken it; the opt-in last", () => {
  const evidenced = sandboxAdviceLines(denied(machine({ "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1" })), machine({}));
  expect(evidenced[0]).toBe("(bubblewrap said: bwrap: setting up uid map: Permission denied)");
  expect(evidenced[1]).toMatch(/AppArmor profile that allows user namespaces/);
  expect(evidenced.at(-1)).toBe(UNCONFINED_OPT_IN);
  const container = machine({ "/proc/self/status": "Name:\tnode\nSeccomp:\t2\n" });
  const contained = sandboxRemedyLines(denied(container), container);
  expect(contained[0]).toMatch(/^In a container .* a profile for this container\. Starting it with `--security-opt seccomp=unconfined --security-opt apparmor=unconfined` also works, but weakens the container's own protection\.$/);
  expect(contained.at(-1)).toBe(UNCONFINED_OPT_IN);
  // Not a container, cause unknown: no guess, just the opt-in.
  expect(sandboxRemedyLines(denied(machine({})), machine({}))).toEqual([UNCONFINED_OPT_IN]);
  // A missing program says its install line in the reason; a trust failure gets its repair (trust-repair.ts), not remedies.
  expect(sandboxRemedyLines({ ok: false, kind: "missing-tool", why: "socat is not installed" })).toEqual([]);
  expect(sandboxRemedyLines({ ok: false, kind: "trust", why: "can't be trusted" })).toEqual([]);
});

test("a refusal never says \"install\" when the programs are installed; it names the opt-in as running agents without confinement", () => {
  const words = noConfinementWords("an agent", "nothing was started", denied(machine({})));
  expect(words).toMatch(/^This machine can't confine an agent, so nothing was started: denied; the cause isn't visible from inside this machine\. Or an instance operator can let agents run without OS confinement/);
  expect(words).not.toMatch(/[Ii]nstall/);
  expect(noConfinementWords("an agent", "nothing was started", { ok: false, kind: "trust", why: "the seccomp helper can't be trusted" })).toContain("`toolroll doctor` prints the exact fix.");
  expect(noConfinementWords("an agent", "nothing was started", { ok: false, kind: "missing-tool", why: "socat is not installed (sudo apt install socat)" })).toContain("socat is not installed (sudo apt install socat).");
});

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "so-sandbox-optin-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("the opt-in's authority is unchanged: no password refuses, local mode refuses, and diagnosing never turns it on", async () => {
  const file = join(dir, "orders.db");
  openStore(file).close();
  const lines: string[] = [];
  expect(await runOperate("config", ["unconfined-agents", "allow"], line => lines.push(line), { databaseFile: file })).toBe(3);
  expect(lines.join("\n")).toMatch(/instance operator changes this, with their password/);
  noConfinementWords("an agent", "nothing was started", denied(machine({})));
  const store = openStore(file);
  try { expect(store.unfencedAgentsAllowed()).toBe(false); } finally { store.close(); }
});
