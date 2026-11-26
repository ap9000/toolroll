/**
 * Why the sandbox can't start (sandbox-runtime.ts sandboxRuntimeDiagnosis and its advice): a denial never states a
 * cause (a setting this machine shows is context only), never says "install" when the programs are there, puts an administrator's
 * targeted fix before weakening a container, and points at the existing opt-in without changing who may use it.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deniedDiagnosis, noConfinementWords, sandboxAdviceLines, sandboxRemedyLines, UNCONFINED_OPT_IN, userNamespaceSettings, type SandboxDiagnosis, type SandboxIo } from "./sandbox-runtime.js";
import { runOperate } from "./operate.js";
import { openStore } from "./store.js";

/** A machine whose readable files are `files` (anything else can't be read) and that has `markers`. */
const machine = (files: Record<string, string>, markers: readonly string[] = []): SandboxIo => ({
  read: file => { const one = files[file]; if (one === undefined) throw Object.assign(Error("EACCES"), { code: "EACCES" }); return one; },
  exists: file => markers.includes(file),
});
const denied = (io: SandboxIo): SandboxDiagnosis => deniedDiagnosis("bwrap: setting up uid map: Permission denied", io);
const UNKNOWN = "this system denied the user namespace the sandbox needs; the cause isn't visible from inside this machine";
const reason = (one: SandboxDiagnosis): string => one.ok ? "" : one.why;

test.each([
  ["Ubuntu's AppArmor restriction", { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n" }, [/apparmor_restrict_unprivileged_userns = 1/]],
  ["Debian's switch off", { "/proc/sys/kernel/unprivileged_userns_clone": "0\n" }, [/kernel\.unprivileged_userns_clone = 0/]],
  ["no user namespaces at all", { "/proc/sys/user/max_user_namespaces": "0\n" }, [/user\.max_user_namespaces = 0/]],
  ["the settings allow them (an unrelated denial)", { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0\n", "/proc/sys/kernel/unprivileged_userns_clone": "1\n", "/proc/sys/user/max_user_namespaces": "15000\n" }, []],
  ["nothing readable", {}, []],
] as const)("a denial never states a cause; settings that may deny it are context: %s", (_, files, shown) => {
  const io = machine(files);
  const one = denied(io);
  expect(reason(one)).toBe(UNKNOWN);
  const settings = userNamespaceSettings(io);
  expect(settings.map(setting => setting.words)).toHaveLength(shown.length);
  shown.forEach((pattern, at) => expect(settings[at]!.words).toMatch(pattern));
});

test("contradictory evidence: a host's AppArmor setting seen in a container that denies by its own seccomp profile stays context", () => {
  const io = machine({ "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1", "/proc/self/status": "Name:\tnode\nSeccomp:\t2\n" }, ["/.dockerenv"]);
  const one = denied(io);
  expect(reason(one)).toBe(UNKNOWN);
  const advice = sandboxAdviceLines(one, io);
  expect(advice[0]).toBe("(bubblewrap said: bwrap: setting up uid map: Permission denied)");
  expect(advice[1]).toMatch(/^This machine shows kernel\.apparmor_restrict_unprivileged_userns = 1 .*, which may be what denies it; if so, an administrator can give bubblewrap an AppArmor profile/);
  expect(advice[2]).toMatch(/^In a container .* a profile for this container\. Starting it with `--security-opt seccomp=unconfined --security-opt apparmor=unconfined` also works, but weakens the container's own protection\.$/);
  expect(advice.at(-1)).toBe(UNCONFINED_OPT_IN);
  // The refusal names no cause and no setting's fix either.
  expect(noConfinementWords("an agent", "nothing was started", one)).not.toMatch(/AppArmor/);
});

test("an unrelated denial: not a container, settings allow it: no guess, just what bubblewrap said and the opt-in", () => {
  const io = machine({ "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0" });
  expect(sandboxRemedyLines(denied(io), io)).toEqual([UNCONFINED_OPT_IN]);
  // A missing program says its install line in the reason; a trust failure gets its repair (trust-repair.ts), not remedies.
  expect(sandboxRemedyLines({ ok: false, kind: "missing-tool", why: "socat is not installed" })).toEqual([]);
  expect(sandboxRemedyLines({ ok: false, kind: "trust", why: "can't be trusted" })).toEqual([]);
});

test("a refusal never says \"install\" when the programs are installed; it names the opt-in as running agents without confinement", () => {
  const words = noConfinementWords("an agent", "nothing was started", denied(machine({})));
  expect(words).toMatch(/^This machine can't confine an agent, so nothing was started: this system denied the user namespace the sandbox needs; the cause isn't visible from inside this machine\. Or an instance operator can let agents run without OS confinement/);
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
