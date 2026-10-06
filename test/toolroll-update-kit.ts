/** Shared fixtures for the Toolroll update tests (src/toolroll-update*.test.ts): signed provenance, a scripted machine,
 * scripted launchctl and npm, and a failing health check. */
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../src/store.js";
import { updateAdmissionPaused, UPDATE_PAUSED } from "../src/desktop-update-gate.js";
import {
  checkProvenance, findSigstoreVerifier, lastCompletedUpdate, launchRuntimeUpdate, machineSystem, prepareRuntimeUpdate, pruneRuntimes, readRuntimeUpdate, releaseNotes, requestRuntimeUpdateCancel, resumeRuntimeUpdate, runtimeUpdateStatus, markWhatsNewSeen,
  startRuntimeRollback, startRuntimeUpdate, PROVENANCE_ISSUER, PROVENANCE_REPOSITORY, PROVENANCE_WORKFLOW, UPDATE_JOB_LABEL, UPDATE_STEPS, type RuntimePhase, type UpdateSystem,
} from "../src/toolroll-update.js";
import { REGISTRY, setUpdateChecks } from "../src/releases.js";
import { runUpdateCommand } from "../src/toolroll-update-cli.js";
import { updatesHtml } from "../src/toolroll-update-ui.js";
import { addApprover } from "../src/scope.js";
import { createDecisionServer } from "../src/serve.js";
import { fakePid } from "./fake-pid.js";
export const TARBALL = new TextEncoder().encode("the toolroll 0.7.0 package bytes");
export const sha512 = (bytes: Uint8Array) => createHash("sha512").update(bytes).digest();

// ---- a Sigstore bundle, as npm serves one: a DSSE envelope signed by a short-lived certificate ----
export const der = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts), n = body.length;
  return Buffer.concat([Buffer.from([tag]), Buffer.from(n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]), body]);
};
export const seq = (...parts: Buffer[]) => der(0x30, ...parts);
export const oid = (dotted: string) => {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const bytes = [a! * 40 + b!];
  for (const n of rest) { const chunk = [n & 0x7f]; for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80); bytes.push(...chunk); }
  return der(0x06, Buffer.from(bytes));
};
export const utf8 = (text: string) => der(0x0c, Buffer.from(text));
export const extension = (id: string, value: Buffer) => seq(oid(id), der(0x04, value));
export const SIGNING = generateKeyPairSync("ec", { namedCurve: "P-256" });
export const OTHER_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" });
/** The service's process, and the one a scripted launchctl starts in its place. */
export const SERVICE_PID = fakePid(1), RESTARTED_SERVICE_PID = fakePid(2);
export type Identity = { repository?: string; workflow?: string; issuer?: string };
/** A Fulcio-shaped signing certificate: the identity is in its extensions and subjectAltName. */
export function signingCertificate(identity: Identity = {}, key: { publicKey: KeyObject; privateKey: KeyObject } = SIGNING): Buffer {
  const repository = identity.repository ?? PROVENANCE_REPOSITORY, workflow = `${repository}/${identity.workflow ?? PROVENANCE_WORKFLOW}@refs/tags/v0.7.0`, issuer = identity.issuer ?? PROVENANCE_ISSUER;
  const ecdsa = seq(oid("1.2.840.10045.4.3.2"));
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), ecdsa,
    seq(der(0x31, seq(oid("2.5.4.3"), utf8("sigstore-intermediate")))), seq(der(0x17, Buffer.from("260101000000Z")), der(0x17, Buffer.from("360101000000Z"))), seq(),
    key.publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, seq(
      extension("2.5.29.17", seq(der(0x86, Buffer.from(workflow)))),
      extension("1.3.6.1.4.1.57264.1.1", Buffer.from(issuer)),
      extension("1.3.6.1.4.1.57264.1.8", utf8(issuer)),
      extension("1.3.6.1.4.1.57264.1.9", utf8(workflow)),
      extension("1.3.6.1.4.1.57264.1.12", utf8(repository)),
    )));
  return seq(tbs, ecdsa, der(0x03, Buffer.concat([Buffer.from([0]), sign("sha256", tbs, key.privateKey)])));
}

/** npm's attestations for a release. The statement always CLAIMS ap9000/toolroll's workflow; `certificate` is who
 * actually signed it, and `signer` the key that signed the envelope. */
export function provenance(options: { version?: string; bytes?: Uint8Array; certificate?: Identity; signer?: KeyObject; chain?: boolean } & Identity = {}) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `pkg:npm/toolroll@${options.version ?? "0.7.0"}`, digest: { sha512: sha512(options.bytes ?? TARBALL).toString("hex") } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: { buildDefinition: { externalParameters: { workflow: { ref: "refs/tags/v0.7.0", repository: PROVENANCE_REPOSITORY, path: PROVENANCE_WORKFLOW } } } },
  };
  const payload = Buffer.from(JSON.stringify(statement)), payloadType = "application/vnd.in-toto+json";
  const sig = sign("sha256", Buffer.concat([Buffer.from(`DSSEv1 ${payloadType.length} ${payloadType} ${payload.length} `), payload]), options.signer ?? SIGNING.privateKey).toString("base64");
  const rawBytes = signingCertificate({ repository: options.repository, workflow: options.workflow, issuer: options.issuer, ...options.certificate }).toString("base64");
  return { attestations: [
    { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", bundle: { dsseEnvelope: { payload: "" } } },
    { predicateType: "https://slsa.dev/provenance/v1", bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: options.chain ? { x509CertificateChain: { certificates: [{ rawBytes }] }, tlogEntries: [] } : { certificate: { rawBytes }, tlogEntries: [] },
      dsseEnvelope: { payloadType, payload: payload.toString("base64"), signatures: [{ keyid: "", sig }] },
    } },
  ] };
}
export function fixture(options: { coding?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-update-"))), stateDir = join(root, "state");
  mkdirSync(stateDir);
  const databaseFile = join(stateDir, "orders.db");
  const store = openStore(databaseFile);
  const at = new Date().toISOString();
  store.raw().prepare("INSERT INTO task(id,title,state,created_at,updated_at) VALUES('T-1','Keep my work','queued',?,?)").run(at, at);
  store.close();
  const codingFile = `${databaseFile}.coding.sqlite`;
  if (options.coding) {
    const d = new DatabaseSync(codingFile);
    d.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE coding_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL, pid INTEGER NOT NULL, native_pid INTEGER, clean INTEGER NOT NULL);
      CREATE TABLE coding_session (id TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL, repo TEXT NOT NULL, document TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE coding_item (session TEXT NOT NULL, id TEXT NOT NULL, position INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, UNIQUE(session,id));
      CREATE TABLE coding_request (token TEXT PRIMARY KEY, session TEXT NOT NULL, rpc_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE coding_submission (session TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, error TEXT, PRIMARY KEY(session,key));
      INSERT INTO coding_owner VALUES(1,'',0,NULL,1);
      INSERT INTO coding_session(id,owner,generation,repo,document) VALUES('coding-before','fixture',1,'/repo','{"status":"ready"}');
      INSERT INTO coding_item(session,id,payload) VALUES('coding-before','item-before','{}');`);
    d.close();
  }
  const oldDist = join(root, "global", "lib", "node_modules", "toolroll", "dist");
  mkdirSync(oldDist, { recursive: true }); writeFileSync(join(oldDist, "bin.js"), "// 0.6.0");
  const bin = join(root, "bin"); mkdirSync(bin);
  const links = ["toolroll", "standing-orders"].map(name => { const path = join(bin, name); symlinkSync(join(oldDist, "bin.js"), path); return path; });
  const unit = join(root, "com.toolroll.browser.plist");
  const unitText = `<plist><string>${oldDist}/controller-service.js</string><string>${oldDist}/cli.js</string></plist>`;
  writeFileSync(unit, unitText);
  const calls: string[] = [], phases: RuntimePhase[] = [], sigstoreChecked: { issuer: string; identity: string }[] = [];
  let clock = Date.parse("2026-09-29T20:00:00Z");
  // The service: running until stopped, with one process that exits when it stops.
  let serviceRunning = true;
  const system: UpdateSystem = {
    now: () => new Date(clock),
    sleep: async ms => { clock += ms; },
    release: async version => ({ version, tarball: `https://registry.npmjs.org/toolroll/-/toolroll-${version}.tgz`, integrity: `sha512-${sha512(TARBALL).toString("base64")}`, attestations: `https://registry.npmjs.org/-/npm/v1/attestations/toolroll@${version}` }),
    download: async () => TARBALL,
    attestations: async () => provenance(),
    install: async (runtime: string) => {
      const dist = join(runtime, "node_modules", "toolroll", "dist");
      mkdirSync(dist, { recursive: true }); writeFileSync(join(dist, "bin.js"), "// 0.7.0");
      writeFileSync(join(runtime, "node_modules", "toolroll", "CHANGELOG.md"), "# Changelog\n\n## 0.7.0 — 2026-10-01\n\n- **Updates from the console.** Details.\n\n- **Faster chat.** More.\n\n## 0.6.0\n\n- **Old.**\n");
      calls.push("install"); return dist;
    },
    rehearse: async (_dist, copy) => { calls.push("rehearse"); const db = new DatabaseSync(copy); try { db.exec("CREATE TABLE IF NOT EXISTS added_by_new_version(x)"); } finally { db.close(); } },
    sigstore: async (_bundle, identity) => { sigstoreChecked.push(identity); },
    commands: () => links,
    serviceUnit: from => readFileSync(unit, "utf8").includes(from.dist) ? unit : null,
    watchUnits: () => [],
    servicePids: async () => serviceRunning ? [SERVICE_PID] : [],
    serviceLoaded: async () => true,
    restartService: async () => { calls.push("restart"); serviceRunning = true; },
    stopService: async () => { calls.push("stop"); serviceRunning = false; },
    processAlive: () => serviceRunning,
    healthy: async () => { calls.push("health"); return true; },
    healthTimeoutMs: 3000,
    checkpoint: phase => { phases.push(phase); },
  };
  const db = () => new DatabaseSync(databaseFile);
  const ledger = () => { const d = db(); try { return d.prepare("SELECT action, outcome, detail, actor FROM action_ledger WHERE action LIKE 'toolroll %' ORDER BY id").all() as { action: string; outcome: string; detail: string; actor: string }[]; } finally { d.close(); } };
  const tasks = (file = databaseFile) => { const d = new DatabaseSync(file); try { return d.prepare("SELECT id FROM task ORDER BY id").all().map(r => String(r["id"])); } finally { d.close(); } };
  const coding = (sql: string) => { const d = new DatabaseSync(codingFile); try { return d.prepare(sql).all().map(r => Object.values(r).join(",")); } finally { d.close(); } };
  const gates = () => [...coding("SELECT name FROM sqlite_master WHERE type='trigger'"), ...(() => { const d = db(); try { return d.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'so_*update_*'").all().map(r => String(r["name"])); } finally { d.close(); } })()];
  const paused = () => { const d = db(); try { return updateAdmissionPaused(d as never); } finally { d.close(); } };
  const current = { version: "0.6.0", dist: oldDist };
  const start = (overrides: Partial<UpdateSystem> = {}, when: "now" | "when-idle" | "at" = "when-idle", at: string | null = null, actor = "ada") =>
    startRuntimeUpdate({ stateDir, databaseFile, current, actor, version: "0.7.0", when, at }, { ...system, ...overrides });
  const startRun = () => {
    const d = db();
    try {
      d.exec("INSERT INTO task_ref(backend,external_id) VALUES('built-in','T-1')");
      const ref = d.prepare("SELECT id FROM task_ref WHERE external_id='T-1'").get()!["id"];
      return Number(d.prepare("INSERT INTO run(task_ref,lease_id,runner,role,started_at) VALUES(?,'lease','fixture','reviewer',?)").run(ref as number, at).lastInsertRowid);
    } finally { d.close(); }
  };
  const finishRun = (id: number) => { const d = db(); try { d.prepare("UPDATE run SET outcome='interrupted', finished_at=? WHERE id=?").run(new Date().toISOString(), id); } finally { d.close(); } };
  const write = (id: string, file = databaseFile) => { const d = new DatabaseSync(file); try { d.prepare("INSERT INTO task(id,title,state,created_at,updated_at) VALUES(?,?,'queued','x','x')").run(id, id); } finally { d.close(); } };
  return { root, stateDir, databaseFile, codingFile, oldDist, links, unit, unitText, calls, phases, sigstoreChecked, system, db, ledger, tasks, coding, gates, write, paused, current, start, startRun, finishRun, close: () => rmSync(root, { recursive: true, force: true }) };
}


export function scriptedLaunchctl() {
  const state = { loaded: true, pid: SERVICE_PID, pendingPrints: 0, log: [] as string[] };
  const run = async (file: string, args: readonly string[]) => {
    const ok = { code: 0, stdout: "", stderr: "", timedOut: false };
    // The service's children: none in this script (pgrep exits 1 when it finds none).
    if (file === "pgrep") return { ...ok, code: 1 };
    state.log.push(args[0]!);
    if (args[0] === "print") {
      if (state.pendingPrints > 0 && --state.pendingPrints === 0) state.loaded = false;
      return state.loaded ? { ...ok, stdout: `com.toolroll.browser = {\n\tstate = running\n\tpid = ${state.pid}\n}` } : { ...ok, code: 113 };
    }
    if (args[0] === "bootout") state.pendingPrints = 2;
    if (args[0] === "bootstrap") { state.loaded = true; state.pid = RESTARTED_SERVICE_PID; state.pendingPrints = 0; }
    return ok;
  };
  return { state, run };
}


export function scriptedNpm(options: { integrity?: string; audit?: { status: number; stdout: string } } = {}) {
  const calls: { args: string[]; spec: unknown }[] = [];
  const exec = (_command: string, args: string[], opts: { cwd?: string } = {}) => {
    const cwd = opts.cwd!;
    calls.push({ args, spec: (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies });
    if (args[0] === "install") {
      const dist = join(cwd, "node_modules", "toolroll", "dist"); mkdirSync(dist, { recursive: true }); writeFileSync(join(dist, "bin.js"), "// 0.7.0");
      writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ packages: { "node_modules/toolroll": { version: "0.7.0", resolved: `${REGISTRY}/toolroll/-/toolroll-0.7.0.tgz`, integrity: options.integrity ?? `sha512-${sha512(TARBALL).toString("base64")}` } } }));
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "audited 1 package in 1s\n\n1 package has a verified registry signature\n\n1 package has a verified attestation\n", stderr: "", ...options.audit };
  };
  return { exec, calls };
}


export const failingHealth = (f: ReturnType<typeof fixture>, unreadable = false) => {
  let restarts = 0;
  return {
    restartService: async () => {
      f.calls.push("restart");
      if (++restarts > 1) return;
      f.write("T-new");
      if (!unreadable) return;
      for (const suffix of ["-wal", "-shm"]) rmSync(f.databaseFile + suffix, { force: true });
      writeFileSync(f.databaseFile, "this is not a database any more");
    },
    healthy: async () => false,
  };
};
