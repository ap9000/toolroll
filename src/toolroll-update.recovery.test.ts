/** Toolroll update: provenance, restore and rollback recovery, watch daemons and the cancel lock. Fixtures: test/toolroll-update-kit.ts. */
import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "./store.js";
import { updateAdmissionPaused, UPDATE_PAUSED } from "./desktop-update-gate.js";
import {
  checkProvenance, findSigstoreVerifier, lastCompletedUpdate, launchRuntimeUpdate, machineSystem, prepareRuntimeUpdate, pruneRuntimes, readRuntimeUpdate, releaseNotes, requestRuntimeUpdateCancel, resumeRuntimeUpdate, runtimeUpdateStatus, markWhatsNewSeen,
  releaseStalledUpdate, startRuntimeRollback, startRuntimeUpdate, updateWaitingOf, waitingUpdate, PROVENANCE_ISSUER, PROVENANCE_REPOSITORY, PROVENANCE_WORKFLOW, UPDATE_JOB_LABEL, UPDATER_START_MS, UPDATE_STEPS, type RuntimePhase, type UpdateSystem,
} from "./toolroll-update.js";
import { REGISTRY, setUpdateChecks } from "./releases.js";
import { runUpdateCommand } from "./toolroll-update-cli.js";
import { updatesHtml } from "./toolroll-update-ui.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { runOperate } from "./operate.js";
import { TARBALL, sha512, der, seq, oid, utf8, extension, SIGNING, OTHER_KEY, signingCertificate, provenance, fixture, scriptedLaunchctl, scriptedNpm, failingHealth, SERVICE_PID } from "../test/toolroll-update-kit.js";

test("r1: provenance is accepted only from a certificate naming ap9000/toolroll, its publish workflow and GitHub Actions, whatever the statement claims", async () => {
  const hex = sha512(TARBALL).toString("hex");
  expect(checkProvenance(provenance(), "0.7.0", hex)).toMatchObject({ repository: PROVENANCE_REPOSITORY, workflow: PROVENANCE_WORKFLOW, issuer: PROVENANCE_ISSUER, identity: `${PROVENANCE_REPOSITORY}/${PROVENANCE_WORKFLOW}@refs/tags/v0.7.0` });
  // The older bundle shape carries the certificate as a one-element chain.
  expect(() => checkProvenance(provenance({ chain: true }), "0.7.0", hex)).not.toThrow();
  // Every statement below claims ap9000/toolroll's publish workflow; only the certificate counts.
  for (const [certificate, message] of [
    [{ repository: "https://github.com/someone/toolroll" }, /built by https:\/\/github\.com\/someone\/toolroll\/\.github\/workflows\/publish\.yml/],
    [{ workflow: ".github/workflows/other.yml" }, /built by .*other\.yml.*not ap9000\/toolroll/],
    [{ issuer: "https://gitlab.com" }, /signed in by https:\/\/gitlab\.com/],
  ] as const) expect(() => checkProvenance(provenance({ certificate }), "0.7.0", hex)).toThrow(message);
  // A certificate that did not sign the statement vouches for nothing.
  expect(() => checkProvenance(provenance({ signer: OTHER_KEY.privateKey }), "0.7.0", hex)).toThrow(/not signed by the certificate it carries/);
  // Only Toolroll itself: a statement for another package (a dependency) is not Toolroll's.
  expect(() => checkProvenance(provenance({ version: "0.6.9" }), "0.7.0", hex)).toThrow(/different bytes/);

  const f = fixture();
  try {
    // The update hands the certificate's own identity to npm's Sigstore verifier.
    expect((await f.start()).phase).toBe("complete");
    expect(f.sigstoreChecked).toEqual([{ issuer: PROVENANCE_ISSUER, identity: `${PROVENANCE_REPOSITORY}/${PROVENANCE_WORKFLOW}@refs/tags/v0.7.0` }]);
  } finally { f.close(); }
  const refused = fixture();
  try {
    const outcome = await refused.start({ sigstore: async () => { throw new (class Refusal extends Error {})("Sigstore did not verify Toolroll's provenance: certificate chain. Nothing was changed."); } });
    expect(outcome.phase).toBe("refused");
    expect(refused.calls).toEqual([]);
  } finally { refused.close(); }
});

test("r1: the attestations must come from the npm registry's own host", async () => {
  for (const url of ["https://registry.npmjs.org.evil.example/-/npm/v1/attestations/toolroll@0.7.0", "http://registry.npmjs.org/-/npm/v1/attestations/toolroll@0.7.0", "https://evil.example/-/npm/v1/attestations/toolroll@0.7.0"]) {
    const f = fixture();
    try {
      let fetched = 0;
      const outcome = await f.start({
        release: async version => ({ version, tarball: `${REGISTRY}/toolroll/-/toolroll-${version}.tgz`, integrity: `sha512-${sha512(TARBALL).toString("base64")}`, attestations: url }),
        attestations: async () => { fetched++; return provenance(); },
      });
      expect(outcome.phase, url).toBe("refused");
      expect(outcome.message).toMatch(/not served by the npm registry/);
      expect(fetched).toBe(0);
    } finally { f.close(); }
  }
});

test("r1: the machine checks the bundle with the Sigstore verifier npm ships, for the certificate's identity, and adds no dependency", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-sigstore-")));
  try {
    // A stand-in for npm's own sigstore package, run by the real node as the machine runs it.
    const verifier = join(root, "npm", "node_modules", "sigstore"); mkdirSync(verifier, { recursive: true });
    writeFileSync(join(verifier, "package.json"), JSON.stringify({ name: "sigstore", main: "index.js" }));
    writeFileSync(join(verifier, "index.js"), `exports.verify = async (bundle, options) => { if (!bundle.dsseEnvelope || options.certificateIssuer !== ${JSON.stringify(PROVENANCE_ISSUER)} || options.certificateIdentityURI !== ${JSON.stringify(`${PROVENANCE_REPOSITORY}/${PROVENANCE_WORKFLOW}@refs/tags/v0.7.0`)}) throw new Error("certificate identity mismatch"); };`);
    const ran: string[][] = [];
    const exec = (command: string, args: string[], options: { input?: string; timeout?: number } = {}) => {
      ran.push([command, ...args.slice(0, 3)]);
      if (command === "npm") return { status: 0, stdout: `${root}\n`, stderr: "" };
      const done = spawnSync(command, args, { encoding: "utf8", input: options.input ?? "" });
      return { status: done.status, stdout: done.stdout, stderr: done.stderr };
    };
    // No npm on PATH and none beside this node: the global root is the last place looked.
    const machine = machineSystem(join(root, "home"), {}, { exec, execPath: join(root, "no-node", "bin", "node") });
    const bundle = checkProvenance(provenance(), "0.7.0", sha512(TARBALL).toString("hex"));
    await expect(machine.sigstore(bundle.bundle, { issuer: bundle.issuer, identity: bundle.identity })).resolves.toBeUndefined();
    expect(ran[0]).toEqual(["npm", "root", "--global", "--no-color"]);
    await expect(machine.sigstore(bundle.bundle, { issuer: bundle.issuer, identity: "https://github.com/someone/toolroll/.github/workflows/publish.yml@refs/tags/v0.7.0" })).rejects.toThrow(/Sigstore did not verify.*certificate identity mismatch/);
    // No verifier where npm keeps its own: refused, never skipped.
    rmSync(verifier, { recursive: true });
    await expect(machine.sigstore(bundle.bundle, { issuer: bundle.issuer, identity: bundle.identity })).rejects.toThrow(/could not find the Sigstore verifier/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("h1: npm's verifier is found from npm itself when the global prefix is custom (npm's fix for permission errors)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-npm-prefix-")));
  try {
    // node and npm as the nodejs.org installer or nvm lays them out; global packages under ~/.npm-global.
    const npm = join(root, "node", "lib", "node_modules", "npm");
    mkdirSync(join(npm, "bin"), { recursive: true }); mkdirSync(join(npm, "node_modules", "sigstore"), { recursive: true });
    writeFileSync(join(npm, "package.json"), JSON.stringify({ name: "npm" }));
    writeFileSync(join(npm, "bin", "npm-cli.js"), "");
    writeFileSync(join(npm, "node_modules", "sigstore", "package.json"), JSON.stringify({ name: "sigstore" }));
    mkdirSync(join(root, "node", "bin")); symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", join(root, "node", "bin", "npm"));
    const custom = join(root, ".npm-global"); mkdirSync(join(custom, "bin"), { recursive: true }); mkdirSync(join(custom, "lib", "node_modules"), { recursive: true });
    const npmRoot = () => join(custom, "lib", "node_modules");
    const verifier = join(npm, "node_modules", "sigstore");
    // The global root alone would miss it: npm does not live under the custom prefix.
    expect(existsSync(join(npmRoot(), "npm", "node_modules", "sigstore"))).toBe(false);
    expect(findSigstoreVerifier({ path: `${join(custom, "bin")}:${join(root, "node", "bin")}`, execPath: "/nowhere/bin/node", npmRoot })).toBe(verifier);
    // No npm on PATH: the npm beside node.
    expect(findSigstoreVerifier({ path: "", execPath: join(root, "node", "bin", "node"), npmRoot })).toBe(verifier);
    // Nowhere at all: none, so the update is refused rather than unchecked.
    expect(findSigstoreVerifier({ path: join(custom, "bin"), execPath: "/nowhere/bin/node", npmRoot })).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("m1: an update completed by 0.8.0 (no .last.json) survives a refused attempt: --rollback still returns from it", async () => {
  const f = fixture();
  try {
    const update = await f.start();
    expect(update.phase).toBe("complete");
    // As 0.8.0 left it: the completed update is only in the journal.
    rmSync(join(f.stateDir, "toolroll-update.last.json"), { force: true });
    const refused = await startRuntimeUpdate({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", version: "0.8.0", when: "now" }, f.system);
    expect(refused.phase).toBe("refused");
    expect(lastCompletedUpdate(f.stateDir)).toMatchObject({ id: update.journal!.id, phase: "complete" });
    const rollback = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, f.system);
    expect(rollback.phase).toBe("complete");
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
  } finally { f.close(); }
});

test("r2: a failed restore stop never leaves the commands on the failed version", async () => {
  const f = fixture();
  try {
    let stops = 0;
    const outcome = await f.start({
      stopService: async () => { f.calls.push("stop"); if (++stops === 2) throw new Error("launchctl did not stop com.toolroll.browser; the service is still loaded. Nothing was replaced."); },
      processAlive: () => false,
      healthy: async () => false,
    });
    expect(outcome.phase).toBe("needs-attention");
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    expect(readFileSync(f.unit, "utf8")).toBe(f.unitText);
  } finally { f.close(); }
});

test("r3: a command folder that cannot be written refuses the update before anything changes", async () => {
  const f = fixture();
  const bin = dirname(f.links[0]!);
  try {
    fs.chmodSync(bin, 0o555);
    const outcome = await f.start();
    expect(outcome.phase).toBe("refused");
    expect(outcome.message).toMatch(new RegExp(`${bin} cannot be written.*Nothing was changed`));
    expect(f.calls).toEqual(["install"]);
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    expect(f.paused()).toBe(false);
  } finally { fs.chmodSync(bin, 0o755); f.close(); }
});

test("r3: a link the restore cannot write is skipped and named; the database is restored and the service restarted", async () => {
  const f = fixture();
  const bin = dirname(f.links[0]!);
  try {
    let restarts = 0;
    const outcome = await f.start({
      restartService: async () => { f.calls.push("restart"); if (++restarts === 1) f.write("T-new"); },
      healthy: async () => { fs.chmodSync(bin, 0o555); return false; },
    });
    expect(outcome.phase).toBe("needs-attention");
    expect(outcome.message).toMatch(/and its database were restored/);
    expect(outcome.message).toContain(`${f.links[0]} (`);
    expect(outcome.message).toMatch(/could not be pointed back at 0\.6\.0.*toolroll update --resume/);
    expect(f.tasks()).toEqual(["T-1"]);
    expect(f.calls.slice(-2)).toEqual(["stop", "restart"]);
    expect(readFileSync(f.unit, "utf8")).toBe(f.unitText);
    // Once the folder can be written, --resume finishes pointing the commands back, without restoring again.
    fs.chmodSync(bin, 0o755); f.write("T-after");
    const resumed = await resumeRuntimeUpdate(f.stateDir, { ...f.system, healthy: async () => false });
    expect(resumed.phase).toBe("restored");
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    expect(f.tasks()).toEqual(["T-1", "T-after"]);
  } finally { fs.chmodSync(bin, 0o755); f.close(); }
});

test("r4: a live database that cannot be read is left aside whole, and the backup restored anyway", async () => {
  const f = fixture();
  try {
    let restarts = 0;
    const outcome = await f.start({
      restartService: async () => {
        f.calls.push("restart");
        if (++restarts > 1) return;
        for (const suffix of ["-wal", "-shm"]) rmSync(f.databaseFile + suffix, { force: true });
        writeFileSync(f.databaseFile, "this is not a database any more");
      },
      healthy: async () => false,
    });
    expect(outcome.phase).toBe("restored");
    const j = outcome.journal!;
    expect(j.keptAsideUnreadable).toBe(true);
    expect(outcome.message).toContain(`The live database could not be read, so it was left as it was at ${j.keptAside}.`);
    expect(readFileSync(j.keptAside!, "utf8")).toBe("this is not a database any more");
    expect(f.tasks()).toEqual(["T-1"]);
    expect(f.paused()).toBe(false);
  } finally { f.close(); }
});

/** The new version writes T-new, and then (optionally) leaves the live database unreadable, and is never healthy. */
test("f1: a live database that is only busy is never moved aside: the restore stops with it in place, and a resume finishes", async () => {
  const f = fixture();
  let holder: DatabaseSync | null = null;
  try {
    const failing = failingHealth(f);
    const outcome = await f.start({
      ...failing,
      processAlive: () => false,
      stopService: async () => {
        f.calls.push("stop");
        if (f.calls.filter(c => c === "stop").length !== 2) return;
        // Something outside the service holds the database exclusively while the restore runs.
        holder = new DatabaseSync(f.databaseFile);
        holder.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO task(id,title,state,created_at,updated_at) VALUES('T-held','held','queued','x','x'); COMMIT;");
      },
    });
    expect(outcome.phase).toBe("needs-attention");
    expect(outcome.message).toContain("could not be copied aside before the restore");
    expect(outcome.journal!.kept ?? []).toEqual([]);
    expect(outcome.journal!.restoredDatabase).toBeUndefined();
    (holder as DatabaseSync | null)?.close(); holder = null;
    expect(f.tasks()).toEqual(["T-1", "T-held", "T-new"]);
    const resumed = await resumeRuntimeUpdate(f.stateDir, { ...f.system, ...failing });
    expect(resumed.phase).toBe("restored");
    expect(f.tasks()).toEqual(["T-1"]);
    expect(f.tasks(resumed.journal!.keptAside!)).toEqual(["T-1", "T-held", "T-new"]);
  } finally { (holder as DatabaseSync | null)?.close(); f.close(); }
});

test("f1: a changed backup or too little room stops the restore before the unreadable live database moves", async () => {
  for (const problem of ["backup changed", "no room"] as const) {
    const f = fixture();
    try {
      const outcome = await f.start({
        ...failingHealth(f, true),
        ...(problem === "no room" ? { freeBytes: () => 1024 } : {}),
        checkpoint: phase => { if (phase === "rolling-back" && problem === "backup changed") writeFileSync(readRuntimeUpdate(f.stateDir)!.backupPath!, "tampered"); },
      });
      expect(outcome.phase).toBe("needs-attention");
      expect(outcome.message).toMatch(problem === "backup changed" ? /backup changed\. Nothing was put back; the live database is as it was/ : /free and the restore needs .* Nothing was put back/);
      expect(readFileSync(f.databaseFile, "utf8")).toBe("this is not a database any more");
      expect(outcome.journal!.kept ?? []).toEqual([]);
    } finally { f.close(); }
  }
});

test("f1: a backup that cannot be put back after the live database moved aside puts the live database back", async () => {
  const f = fixture();
  try {
    let blocked = true;
    const failing = failingHealth(f, true);
    const outcome = await f.start({
      ...failing,
      checkpoint: phase => { if (phase === "kept-aside" && blocked) fs.chmodSync(readRuntimeUpdate(f.stateDir)!.backupPath!, 0o000); },
    });
    expect(outcome.phase).toBe("needs-attention");
    // Never empty and never a fresh database: the live path holds what it held.
    expect(readFileSync(f.databaseFile, "utf8")).toBe("this is not a database any more");
    expect(outcome.journal!.kept ?? []).toEqual([]);
    blocked = false; fs.chmodSync(outcome.journal!.backupPath!, 0o600);
    const resumed = await resumeRuntimeUpdate(f.stateDir, { ...f.system, ...failing, checkpoint: () => {} });
    expect(resumed.phase).toBe("restored");
    expect(f.tasks()).toEqual(["T-1"]);
    expect(resumed.journal!.kept).toEqual([{ path: resumed.journal!.keptAside, unreadable: true }]);
    expect(readFileSync(resumed.journal!.keptAside!, "utf8")).toBe("this is not a database any more");
  } finally { f.close(); }
});

test("f1: every copy kept aside stays named: a resumed restore adds one and keeps the pointer to the first", async () => {
  const f = fixture();
  try {
    const failing = failingHealth(f);
    let attempts = 0;
    const first = await f.start({ ...failing, checkpoint: phase => { if (phase === "kept-aside" && ++attempts === 1) throw Error("The disk went away."); } });
    expect(first.phase).toBe("needs-attention");
    const [earlier] = first.journal!.kept!;
    expect(f.tasks(earlier!.path)).toEqual(["T-1", "T-new"]);
    // A 0.8.1 journal names only its newest copy: it is carried into the list.
    const saved = JSON.parse(readFileSync(join(f.stateDir, "toolroll-update.json"), "utf8"));
    delete saved.kept; writeFileSync(join(f.stateDir, "toolroll-update.json"), JSON.stringify(saved));
    const resumed = await resumeRuntimeUpdate(f.stateDir, { ...f.system, ...failing });
    expect(resumed.phase).toBe("restored");
    expect(resumed.journal!.kept!.map(one => one.path)).toEqual([earlier!.path, resumed.journal!.keptAside]);
    expect(resumed.message).toContain(`kept in ${earlier!.path} and ${resumed.journal!.keptAside}`);
  } finally { f.close(); }
});

test("r5: the stop waits as long as toolroll up takes to exit, and a stop that times out leaves the label enabled", async () => {
  const f = fixture();
  try {
    const launch = (printsUntilGone: number) => {
      const log: string[] = []; let pending = -1;
      const run = async (_file: string, args: readonly string[]) => {
        log.push(args[0]!);
        if (args[0] === "bootout") pending = printsUntilGone;
        if (args[0] === "print") return pending === 0 ? { code: 113, stdout: "", stderr: "", timedOut: false } : (pending > 0 && pending--, { code: 0, stdout: `state = running\n\tpid = ${SERVICE_PID}\n`, stderr: "", timedOut: false });
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      };
      return { log, run };
    };
    // A watch daemon's up takes 30 s to exit: longer than the 5 s launchd default, within 45 s.
    const slow = launch(300);
    await expect(machineSystem(join(f.root, "home"), {}, { run: slow.run as never, sleep: async () => {} }).stopService(f.unit)).resolves.toBeUndefined();
    const never = launch(Number.MAX_SAFE_INTEGER);
    await expect(machineSystem(join(f.root, "home"), {}, { run: never.run as never, sleep: async () => {} }).stopService(f.unit)).rejects.toThrow(/did not stop/);
    expect(never.log.filter(verb => verb !== "print")).toEqual(["disable", "bootout", "enable"]);
    expect(never.log.filter(verb => verb === "print").length).toBe(450);
  } finally { f.close(); }
});

test("r6: each repo's watch daemon is stopped, switched and restarted with the service, and put back on a failure", async () => {
  for (const healthy of [true, false]) {
    const f = fixture();
    try {
      const watch = join(f.root, "com.toolroll.watch.app-1234.plist"), watchText = `<plist><string>${f.oldDist}/controller-service.js</string><string>${f.oldDist}/bin.js</string><string>watch</string></plist>`;
      writeFileSync(watch, watchText);
      const units: string[] = [];
      const outcome = await f.start({
        watchUnits: from => readFileSync(watch, "utf8").includes(from.dist) ? [watch] : [],
        stopService: async unit => { units.push(`stop ${basename(unit)}`); },
        restartService: async unit => { units.push(`restart ${basename(unit)}`); },
        processAlive: () => false,
        healthy: async () => healthy,
      });
      const j = outcome.journal!;
      expect(outcome.phase).toBe(healthy ? "complete" : "restored");
      expect(units.slice(0, 4)).toEqual(["stop com.toolroll.browser.plist", "stop com.toolroll.watch.app-1234.plist", "restart com.toolroll.browser.plist", "restart com.toolroll.watch.app-1234.plist"]);
      expect(readFileSync(watch, "utf8")).toBe(healthy ? watchText.replaceAll(f.oldDist, j.to.dist) : watchText);
      if (!healthy) expect(units.slice(4)).toEqual(units.slice(0, 4));
    } finally { f.close(); }
  }
});

test("f9: a watch daemon the person had unloaded is switched but never stopped or started by the update", async () => {
  for (const healthy of [true, false]) {
    const f = fixture();
    try {
      const watches = ["app-1", "app-2"].map(name => join(f.root, `com.toolroll.watch.${name}.plist`));
      for (const watch of watches) writeFileSync(watch, `<plist><string>${f.oldDist}/bin.js</string><string>watch</string></plist>`);
      const units: string[] = [];
      const outcome = await f.start({
        watchUnits: from => watches.filter(watch => readFileSync(watch, "utf8").includes(from.dist)),
        serviceLoaded: async unit => !unit.includes("app-2"),
        stopService: async unit => { units.push(`stop ${basename(unit)}`); },
        restartService: async unit => { units.push(`restart ${basename(unit)}`); },
        processAlive: () => false,
        healthy: async () => healthy,
      });
      expect(outcome.phase).toBe(healthy ? "complete" : "restored");
      expect(units.filter(one => one.includes("app-2"))).toEqual([]);
      expect(units).toContain("restart com.toolroll.watch.app-1.plist");
      expect(outcome.journal!.watches!.map(w => [w.unit, w.loaded])).toEqual([[watches[0], true], [watches[1], false]]);
      if (healthy) expect(readFileSync(watches[1]!, "utf8")).toContain(outcome.journal!.to.dist);
    } finally { f.close(); }
  }
});

test("r6: a toolroll up started while the new version ran keeps the restore from putting the database back under it", async () => {
  const f = fixture();
  try {
    let restarts = 0;
    const outcome = await f.start({
      restartService: async () => {
        f.calls.push("restart");
        if (++restarts > 1) return;
        f.write("T-new");
        const d = f.db(); try { d.prepare("INSERT INTO watch_lease(runner,repo,owner,generation,started_at,expires_at,heartbeat_at) VALUES('laptop','/code/app','fg',1,'x','2999-01-01T00:00:00Z','x')").run(); } finally { d.close(); }
      },
      healthy: async () => false,
    });
    expect(outcome.phase).toBe("needs-attention");
    expect(outcome.message).toMatch(/toolroll up is running for \/code\/app \(laptop\)\. The database was not put back under it/);
    expect(f.tasks()).toEqual(["T-1", "T-new"]);
    expect(outcome.journal!.restoredDatabase).toBeUndefined();
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
  } finally { f.close(); }
});

test("r7: a refused attempt after a completed update leaves --rollback working", async () => {
  const f = fixture();
  try {
    const update = await f.start();
    expect(update.phase).toBe("complete");
    // A later attempt is refused (its provenance is for 0.7.0, not 0.8.0) and becomes the saved journal.
    const refused = await startRuntimeUpdate({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", version: "0.8.0", when: "now" }, f.system);
    expect(refused.phase).toBe("refused");
    expect(readRuntimeUpdate(f.stateDir)).toMatchObject({ phase: "refused", to: { version: "0.8.0" } });
    const lines: string[] = [];
    expect(await runUpdateCommand(["--rollback"], line => lines.push(line), { system: f.system, current: update.journal!.to, databaseFile: f.databaseFile, method: { kind: "managed", updateCommand: "toolroll update" } })).toBe(0);
    expect(lines[0]).toMatch(/^Roll back 0\.7\.0 → 0\.6\.0/);
    const rollback = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, f.system);
    expect(rollback.phase).toBe("complete");
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    // Rolled back: there is nothing left to roll back.
    expect((await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: f.current, actor: "ada", when: "when-idle" }, f.system)).message).toBe("There is no completed update to roll back.");
  } finally { f.close(); }
});

test("f8: Settings → Updates offers --rollback from the last completed update, even after a refused attempt", async () => {
  const f = fixture();
  try {
    const update = await f.start();
    await startRuntimeUpdate({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", version: "0.8.0", when: "now" }, f.system);
    const status = runtimeUpdateStatus(f.stateDir);
    expect(status.journal!.phase).toBe("refused");
    expect(status.lastUpdate).toEqual({ from: "0.6.0", to: "0.7.0" });
    const html = updatesHtml({ current: "0.7.0", latest: { version: "0.7.0" }, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" }, journal: status.journal, running: false, whatsNew: null, rollbackTo: status.lastUpdate!.from, csrf: "x" }, {});
    expect(html).toContain("To go back to 0.6.0: <code>toolroll update --rollback</code>");
    // Rolled back: nothing is offered.
    await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, f.system);
    expect(runtimeUpdateStatus(f.stateDir).lastUpdate).toBeNull();
  } finally { f.close(); }
});

test("r8: the console's update job looks for toolroll where it is usually linked", async () => {
  const f = fixture();
  try {
    const run = async (_file: string, args: readonly string[]) => ({ code: args[0] === "print" ? 113 : 0, stdout: "", stderr: "", timedOut: false });
    const home = join(f.root, "home");
    await launchRuntimeUpdate({ databaseFile: f.databaseFile, id: randomUUID(), dist: f.oldDist }, { home, run: run as never, platform: "darwin", npmBin: async () => "/Users/a/.npm-global/bin" });
    const plist = readFileSync(join(home, "Library", "LaunchAgents", `${UPDATE_JOB_LABEL}.plist`), "utf8");
    const path = /<key>PATH<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)![1]!.split(":");
    expect(path).toEqual(expect.arrayContaining([dirname(process.execPath), "/Users/a/.npm-global/bin", join(home, ".local", "bin"), join(home, "bin"), join(home, "Library", "pnpm"), "/usr/local/bin", "/opt/homebrew/bin"]));
  } finally { f.close(); }
});

test("r9: the job asks npm for its global folder without blocking the console", async () => {
  const f = fixture();
  try {
    const asked: string[][] = [];
    const run = async (file: string, args: readonly string[]) => {
      asked.push([file, ...args]);
      return { code: args[0] === "print" ? 113 : 0, stdout: file === "npm" ? "/Users/b/.npm-prefix\n" : "", stderr: "", timedOut: false };
    };
    const home = join(f.root, "home");
    await launchRuntimeUpdate({ databaseFile: f.databaseFile, id: randomUUID(), dist: f.oldDist }, { home, run: run as never, platform: "darwin" });
    expect(asked[0]).toEqual(["npm", "prefix", "--global", "--no-color"]);
    const plist = readFileSync(join(home, "Library", "LaunchAgents", `${UPDATE_JOB_LABEL}.plist`), "utf8");
    expect(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)![1]!.split(":")).toContain("/Users/b/.npm-prefix/bin");
  } finally { f.close(); }
});

test("--cancel with no updater running lifts the pause and cancels", async () => {
  const f = fixture();
  try {
    f.startRun();
    // The updater dies while it waits for running work, leaving new work paused.
    await expect(f.start({ sleep: async () => { throw Object.assign(Error("crash"), { simulatedCrash: true }); } }, "when-idle")).rejects.toThrow("crash");
    expect(f.paused()).toBe(true);
    expect(requestRuntimeUpdateCancel(f.stateDir)).toBe("Cancelled the update to 0.7.0. Nothing was switched; new work resumes.");
    expect(f.paused()).toBe(false);
    expect(readRuntimeUpdate(f.stateDir)?.phase).toBe("cancelled");
    expect(f.ledger().map(e => e.action)).toEqual(["toolroll update cancelled"]);
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
  } finally { f.close(); }
});

test("f3: --cancel reads the update again under the lock, and leaves one that moved on or was replaced alone", async () => {
  for (const change of ["moved on", "replaced", "finished"] as const) {
    const f = fixture();
    try {
      f.startRun();
      await expect(f.start({ sleep: async () => { throw Object.assign(Error("crash"), { simulatedCrash: true }); } }, "when-idle")).rejects.toThrow("crash");
      const file = join(f.stateDir, "toolroll-update.json");
      const staged = readRuntimeUpdate(f.stateDir)!;
      mkdirSync(join(staged.stageDir, "runtime"), { recursive: true });
      const words = requestRuntimeUpdateCancel(f.stateDir, new Date(), {
        // Between the first read and the lock, an updater carried on (or another update replaced this one).
        locked: () => writeFileSync(file, JSON.stringify(change === "replaced" ? { ...staged, id: randomUUID() } : { ...staged, phase: change === "moved on" ? "switching" : "complete" })),
      });
      expect(words).toBe(change === "moved on" ? "The update to 0.7.0 is past the point it can be cancelled (switching); it will finish or restore on its own."
        : change === "replaced" ? "A different update was saved while cancelling. Nothing was cancelled." : "No update is in progress.");
      expect(readRuntimeUpdate(f.stateDir)!.phase).toBe(change === "moved on" ? "switching" : change === "replaced" ? "draining" : "complete");
      expect(existsSync(join(staged.stageDir, "runtime"))).toBe(true);
      expect(existsSync(join(staged.stageDir, "cancel-request.json"))).toBe(false);
      expect(f.paused()).toBe(true);
      expect(f.ledger()).toEqual([]);
    } finally { f.close(); }
  }
});

test("pruning never deletes a folder holding a kept-aside database", () => {
  const f = fixture();
  try {
    const staged = join(f.stateDir, "staged-upgrades");
    for (const [name, startedAt] of [["release-0.6.7-aaaaaaaa", "2026-01-01T00:00:00Z"], ["release-0.6.8-bbbbbbbb", "2026-02-01T00:00:00Z"], ["release-0.6.9-cccccccc", "2026-03-01T00:00:00Z"]] as const) {
      mkdirSync(join(staged, name), { recursive: true }); writeFileSync(join(staged, name, "update.json"), JSON.stringify({ startedAt }));
    }
    writeFileSync(join(staged, "release-0.6.7-aaaaaaaa", "orders.kept.1a2b3c4d.db"), "what 0.6.7 wrote");
    expect(pruneRuntimes(f.stateDir, [])).toEqual([]);
    expect(existsSync(join(staged, "release-0.6.7-aaaaaaaa", "orders.kept.1a2b3c4d.db"))).toBe(true);
  } finally { f.close(); }
});

test("npm's output is read without colour, so a verified attestation is recognised", async () => {
  const f = fixture();
  try {
    const npm = scriptedNpm();
    // npm colours "verified" unless told not to.
    const exec = (command: string, args: string[], options: { cwd?: string } = {}) => {
      const answer = npm.exec(command, args, options);
      return args[0] === "audit" && !args.includes("--no-color") ? { ...answer, stdout: answer.stdout.replaceAll("verified", "\u001b[1mverified\u001b[22m") } : answer;
    };
    const outcome = await f.start({ install: machineSystem(join(f.root, "home"), {}, { exec }).install });
    expect(outcome.phase).toBe("complete");
    for (const call of npm.calls) expect(call.args).toContain("--no-color");
  } finally { f.close(); }
});

test("the Toolroll app is never offered an npm update", async () => {
  const f = fixture();
  try {
    const lines: string[] = [];
    expect(await runUpdateCommand(["--yes"], line => lines.push(line), { system: f.system, current: f.current, databaseFile: f.databaseFile, latest: async () => ({ version: "0.7.0" }), method: { kind: "desktop", updateCommand: "Update from the Toolroll app" } })).toBe(1);
    expect(lines).toEqual(["This Toolroll is the Toolroll app, which updates as a whole app. Update it from the Toolroll app."]);
    expect(f.calls).toEqual([]);
    expect(readRuntimeUpdate(f.stateDir)).toBeNull();
  } finally { f.close(); }
});

// ---- a finished run's leftover process record never strands an update ----

/** A finished run with a process record that has no pid (a spawn refused, say, out of memory). `withExitedGroup`: the
 * run's other process started, ran and exited, so the reconcile can prove nothing of it is alive. */
function leftoverRecord(f: ReturnType<typeof fixture>, withExitedGroup: boolean): number {
  const d = f.db();
  try {
    const at = new Date().toISOString();
    d.exec("INSERT OR IGNORE INTO task_ref(backend,external_id) VALUES('built-in','T-1')");
    const ref = Number(d.prepare("SELECT id FROM task_ref WHERE external_id='T-1'").get()!["id"]);
    const run = Number(d.prepare("INSERT INTO run(task_ref,lease_id,runner,role,started_at,outcome,finished_at) VALUES(?,'lease-c','fixture','reviewer',?,'failed',?)").run(ref, at, at).lastInsertRowid);
    if (withExitedGroup) {
      const gone = spawnSync("true").pid!;
      d.prepare("INSERT INTO run_process(run,pid,host,process_group,observed_at,exited_at) VALUES(?,?,?,1,?,?)").run(run, gone, hostname(), at, at);
    }
    d.prepare("INSERT INTO run_process(run,pid,host,process_group,observed_at) VALUES(?,NULL,?,1,?)").run(run, hostname(), at);
    return run;
  } finally { d.close(); }
}
const openRecords = (f: ReturnType<typeof fixture>) => { const d = f.db(); try { return Number(d.prepare("SELECT count(*) n FROM run_process WHERE exited_at IS NULL").get()!["n"]); } finally { d.close(); } };
const stillInTheWay = (f: ReturnType<typeof fixture>) => (run: number) => { const s = openStore(f.databaseFile); try { return s.stopQuiescenceProblem(run) !== null; } finally { s.close(); } };

test("u1: the update settles a finished run's leftover record itself, then updates", async () => {
  const f = fixture();
  try {
    leftoverRecord(f, true);
    const outcome = await f.start();
    expect(outcome.phase).toBe("complete");
    expect(openRecords(f)).toBe(0);
    const d = f.db();
    try { expect(d.prepare("SELECT outcome FROM action_ledger WHERE action='process witness settled'").all().map(r => r["outcome"])).toEqual(["never started"]); } finally { d.close(); }
    expect(readRuntimeUpdate(f.stateDir)!.waiting).toBeUndefined();
  } finally { f.close(); }
});

test("u1: a record nothing can prove: within 2 minutes it stops waiting, new work resumes, and it says the one command", async () => {
  const f = fixture();
  try {
    const run = leftoverRecord(f, false);
    const seen: string[] = [];
    // The real clock never moves here: only the update's own waits do.
    const outcome = await f.start({ sleep: async ms => {
      expect(f.paused()).toBe(true);
      const waiting = updateWaitingOf(f.stateDir, stillInTheWay(f));
      seen.push(waiting!.words);
      await f.system.sleep(ms);
    } });
    expect(outcome.phase).toBe("refused");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThanOrEqual(61);
    expect(seen[0]).toBe(`Update to 0.7.0 is waiting: Run #${run} finished, but Toolroll has no process ID for one of its processes, so it can't confirm that process ended. If nothing of it is running, run toolroll run settle ${run} --why "it is not running".`);
    expect(outcome.message).toBe(`Stopped waiting after 2 minutes. Run #${run} finished, but Toolroll has no process ID for one of its processes, so it can't confirm that process ended. If nothing of it is running, run toolroll run settle ${run} --why "it is not running", then update again. New work resumed; nothing was changed.`);
    expect(f.paused()).toBe(false);
    const j = readRuntimeUpdate(f.stateDir)!;
    for (const words of [outcome.message, j.detail, ...seen, ...j.steps.map(s => s.phase)]) expect(words).not.toMatch(/witness|unproven/i);
    // Status and the console say the same thing while it is still in the way.
    expect(updateWaitingOf(f.stateDir, stillInTheWay(f))).toMatchObject({ stopped: true, run, action: `toolroll run settle ${run} --why "it is not running"` });
    const html = updatesHtml({ current: "0.6.0", latest: { version: "0.7.0" }, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" }, journal: j, running: false, whatsNew: null, rollbackTo: null, csrf: "x" }, {});
    expect(html).toContain(`Update to 0.7.0 stopped: run #${run} is in the way`);
    expect(html).toContain(`<code>toolroll run settle ${run} --why &quot;it is not running&quot;</code>`);
    expect(html).not.toMatch(/witness|unproven/i);
    // Once settled, nothing is in the way and nothing more is said.
    const s = openStore(f.databaseFile);
    try { expect(s.settleRunWitnessesByApprover({ runId: run, by: "ada", why: "it is not running" }, new Date()).ok).toBe(true); } finally { s.close(); }
    expect(updateWaitingOf(f.stateDir, stillInTheWay(f))).toBeNull();
    expect((await f.start()).phase).toBe("complete");
  } finally { f.close(); }
});

test("u1: --now settles what it can, and otherwise refuses at once in plain words", async () => {
  const f = fixture();
  try {
    const run = leftoverRecord(f, false);
    const outcome = await f.start({}, "now");
    expect(outcome.phase).toBe("refused");
    expect(outcome.message).toBe(`Run #${run} finished, but Toolroll has no process ID for one of its processes, so it can't confirm that process ended. If nothing of it is running, run toolroll run settle ${run} --why "it is not running", then update again. Nothing was changed.`);
    expect(f.paused()).toBe(false);
  } finally { f.close(); }
});

test("u2: toolroll status and every console page show a waiting update, what it waits on and the action", async () => {
  const f = fixture();
  const store = openStore(f.databaseFile);
  const alex = addApprover(store, "alex", new Date());
  if (!alex.ok) throw new Error("alex");
  const server = createDecisionServer({ store, evidenceRoot: join(f.root, "evidence") });
  try {
    const run = leftoverRecord(f, false);
    expect((await f.start()).phase).toBe("refused");
    const lines: string[] = [];
    expect(await runOperate("status", [], line => lines.push(line), { databaseFile: f.databaseFile, releaseIo: { fetch: async () => { throw new Error("offline"); } } } as never)).toBe(0);
    expect(lines.join("\n").split("\n")[0]).toBe(`Update to 0.7.0 stopped waiting: Run #${run} finished, but Toolroll has no process ID for one of its processes, so it can't confirm that process ended. If nothing of it is running, run toolroll run settle ${run} --why "it is not running", then update again.`);
    const json: string[] = [];
    await runOperate("status", ["--json"], line => json.push(line), { databaseFile: f.databaseFile, releaseIo: { fetch: async () => { throw new Error("offline"); } } } as never);
    expect(JSON.parse(json.join("\n")).updateWaiting).toMatchObject({ version: "0.7.0", stopped: true, run, action: `toolroll run settle ${run} --why "it is not running"` });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alex.token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toContain(`Update to 0.7.0 stopped: run #${run} is in the way. If nothing of it is running, run toolroll run settle ${run} --why &quot;it is not running&quot;, then update again.`);
    // Settings → Updates says it once, in its card, not again in a banner.
    const updates = await (await fetch(`${base}/settings/updates`, { headers: { cookie } })).text();
    expect(updates).toContain(`Update to 0.7.0 stopped: run #${run} is in the way`);
    expect(updates).not.toContain("update-waiting");
  } finally {
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    store.close(); f.close();
  }
}, 30_000);

test("u1: an updater that ends while work finishes never leaves new work paused: status, the console and the worker lift it", async () => {
  for (const by of ["status", "worker", "console"] as const) {
    const f = fixture();
    try {
      f.startRun();
      // While the updater is alive nothing is lifted under it.
      await expect(f.start({ sleep: async () => {
        expect(releaseStalledUpdate(f.stateDir, new Date())).toBeNull();
        throw Object.assign(Error("crash"), { simulatedCrash: true });
      } }, "when-idle")).rejects.toThrow("crash");
      expect(f.paused()).toBe(true);
      expect(updateWaitingOf(f.stateDir, () => true)?.words).toBe("Update to 0.7.0 is waiting for running work to finish. New work is paused.");
      const said = "The update to 0.7.0 stopped: its updater ended before running work finished. Nothing was changed; new work resumed. Run toolroll update to try again.";
      if (by === "status") {
        const lines: string[] = [];
        expect(await runOperate("status", [], line => lines.push(line), { databaseFile: f.databaseFile, releaseIo: { fetch: async () => { throw new Error("offline"); } } } as never)).toBe(0);
        expect(lines.join("\n")).not.toMatch(/New work is paused|Update to 0\.7\.0/);
      } else if (by === "worker") {
        const lines: string[] = [];
        await runOperate("reconcile", ["--json"], line => lines.push(line), { databaseFile: f.databaseFile } as never);
      } else expect(waitingUpdate(f.databaseFile, () => true, new Date(), [])).toBeNull();
      expect(f.paused()).toBe(false);
      const j = readRuntimeUpdate(f.stateDir)!;
      expect([j.phase, j.detail]).toEqual(["refused", said]);
      expect(existsSync(join(j.stageDir, "runtime"))).toBe(false);
      expect(f.ledger().map(e => [e.action, e.outcome])).toEqual([["toolroll update stopped", "refused"]]);
      for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
      // A later resume finds nothing to continue; a new update starts clean.
      expect((await resumeRuntimeUpdate(f.stateDir, f.system)).message).toBe("No update is in progress.");
    } finally { f.close(); }
  }
}, 30_000);

test("u1: Settings → Updates still opens when a stalled update cannot be released", async () => {
  const f = fixture();
  const store = openStore(f.databaseFile);
  const alex = addApprover(store, "alex", new Date());
  if (!alex.ok) throw new Error("alex");
  const server = createDecisionServer({ store, evidenceRoot: join(f.root, "evidence"), updates: { latest: async () => ({ version: "0.7.0" }), current: "0.6.0", dist: f.oldDist } });
  try {
    f.startRun();
    await expect(f.start({ sleep: async () => { throw Object.assign(Error("crash"), { simulatedCrash: true }); } }, "when-idle")).rejects.toThrow("crash");
    const stage = () => readRuntimeUpdate(f.stateDir)!.stageDir;
    // Its saved copy cannot be replaced: releasing the update fails.
    rmSync(join(stage(), "update.json")); mkdirSync(join(stage(), "update.json", "in-the-way"), { recursive: true });
    expect(() => releaseStalledUpdate(f.stateDir, new Date())).toThrow();
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alex.token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const page = await fetch(`${base}/settings/updates`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("New work is paused. Waiting for running T-1 (Keep my work) to finish.");
  } finally {
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    store.close(); f.close();
  }
}, 30_000);

test("u1: a job launched or a resume starting on a draining update is never released under it", async () => {
  for (const by of ["launched", "resuming"] as const) {
    const f = fixture();
    try {
      f.startRun();
      await expect(f.start({ sleep: async () => { throw Object.assign(Error("crash"), { simulatedCrash: true }); } }, "when-idle")).rejects.toThrow("crash");
      const j = readRuntimeUpdate(f.stateDir)!;
      const at = new Date();
      if (by === "launched") {
        const run = async (_file: string, args: readonly string[]) => ({ code: args[0] === "print" ? 113 : 0, stdout: "", stderr: "", timedOut: false });
        await launchRuntimeUpdate({ databaseFile: f.databaseFile, id: j.id, dist: f.oldDist }, { home: join(f.root, "home"), run: run as never, platform: "darwin", now: () => at });
      } else {
        // The resume takes the lock and drains; a poll from status or the console then finds the lock held.
        await expect(resumeRuntimeUpdate(f.stateDir, { ...f.system, now: () => at, sleep: async () => {
          expect(releaseStalledUpdate(f.stateDir, at)).toBeNull();
          throw Object.assign(Error("crash"), { simulatedCrash: true });
        } }, j.id)).rejects.toThrow("crash");
        // Its mark went once it held the lock: an updater that dies after that is released at once.
        expect(releaseStalledUpdate(f.stateDir, at)).not.toBeNull();
        expect(f.paused()).toBe(false);
        continue;
      }
      // Launched, not yet started by launchd: nothing is lifted, however often status or the console polls.
      expect(releaseStalledUpdate(f.stateDir, at)).toBeNull();
      expect(releaseStalledUpdate(f.stateDir, new Date(at.getTime() + UPDATER_START_MS - 1000))).toBeNull();
      expect(f.paused()).toBe(true);
      expect(readRuntimeUpdate(f.stateDir)!.phase).toBe("draining");
      // A job that never started is not waited on forever.
      expect(releaseStalledUpdate(f.stateDir, new Date(at.getTime() + UPDATER_START_MS))).not.toBeNull();
      expect(f.paused()).toBe(false);
      // And a job that starts after all finds the update stopped and does not drive it.
      const late = await resumeRuntimeUpdate(f.stateDir, f.system, j.id);
      expect(late.message).toBe("No update is in progress.");
      expect(f.paused()).toBe(false);
    } finally { f.close(); }
  }
}, 30_000);
