import { describe, expect, it } from "vitest";
import {
  assessEnrollmentCapture, assessEnrollmentTransition, capturedEnrollmentNames, ENROLLMENT_RECORD_LIMIT,
  parseEnrollmentBinding, parseEnrollmentCapture, parseEnrollmentExpectation, parseEnrollmentReceipt, parseEnrollmentRoot,
} from "./central-enrollment-contract.js";

const encode = (v: unknown) => JSON.stringify(v);
const home = "/captured/home", db = "/captured/state/orders.db", uid = 501;
const names = capturedEnrollmentNames(home, db)!;
const common = { version: 1, installationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
  ownerUid: uid, databasePath: db, statePath: names.state, stateIdentity: { dev: 1, ino: 20 }, protocolVersion: 1, manifestVersion: 1,
  transactionId: "a".repeat(32) };
const expectation = { ...common, pathDigest: names.pathDigest, phase: "enrolled", services: ["console-worker"] };
const root = { ...common, recoveryGeneration: "b".repeat(32), phase: "committed" };
const receipt = { ...common, recoveryGeneration: "b".repeat(32) };
const binding = { version: 1, installationId: common.installationId, ownerUid: uid, databasePath: db, pathDigest: names.pathDigest,
  registryVersion: 1, centralRecoveryRequired: true, serviceId: "console-worker", definitionDigest: "c".repeat(64) };
const absent = (path: string) => ({ observed: "absent", path, error: "ENOENT" });
const directory = (path: string, ino = 10) => ({ observed: "directory", path, uid, mode: 0o700, dev: 1, ino });
const file = (path: string, value: unknown) => { const bytes = encode(value); return { observed: "file", path, uid, mode: 0o600,
  nlink: 1, dev: 1, ino: 30, size: Buffer.byteLength(bytes), bytes }; };
function enrolled() {
  return { version: 1, ownerUid: uid, home, databasePath: db, homeDirectory: directory(home), stateDirectory: directory(names.state, 20),
    registryDirectory: directory(names.registry), expectationsDirectory: directory(names.expectations), secretsDirectory: directory(names.secrets),
    expectation: file(names.expectation, expectation), root: file(names.root, root), binding: file("/captured/service/binding.json", binding),
    receipt: { observed: "record", bytes: encode(receipt) } };
}
function personal() {
  return { ...enrolled(), registryDirectory: absent(names.registry), expectationsDirectory: absent(names.expectations),
    secretsDirectory: absent(names.secrets), expectation: absent(names.expectation), root: absent(names.root),
    binding: absent("/captured/service/binding.json"), receipt: { observed: "absent" } };
}
function disabled(result: ReturnType<typeof assessEnrollmentCapture>) {
  expect(result.nativeProof).toBe("not-performed");
  expect(Object.values(result.capabilities)).toEqual([false, false, false, false, false]);
}

describe("offline central enrollment representation", () => {
  it("keeps legacy personal captures separate from enrollment and never returns admission", () => {
    for (const capture of [personal(), { ...personal(), registryDirectory: directory(names.registry), expectationsDirectory: directory(names.expectations) }]) {
      const result = assessEnrollmentCapture(encode(capture));
      expect(result.classification).toBe("personal-capture"); disabled(result);
    }
    const result = assessEnrollmentCapture(encode(enrolled()));
    expect(result.classification).toBe("consistent-enrolled-capture"); disabled(result);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.capabilities)).toBe(true);
  });
  it.each([
    ["expectation", expectation, parseEnrollmentExpectation], ["root", root, parseEnrollmentRoot],
    ["receipt", receipt, parseEnrollmentReceipt], ["binding", binding, parseEnrollmentBinding],
  ] as const)("strictly bounds and versions %s records", (_name, record, parser) => {
    expect(parser(encode(record))).not.toBeNull();
    for (const raw of [encode({ ...record, version: 2 }), encode({ ...record, approved: true }), encode(record) + " ",
      encode(record).replace('{"version":1', '{"version":2,"version":1'), " ".repeat(ENROLLMENT_RECORD_LIMIT + 1), "null", "[]", "{}"])
      expect(parser(raw), raw.slice(0, 80)).toBeNull();
  });
  it("rejects malformed IDs, duplicate services, unsupported manifest and path aliases", () => {
    for (const patch of [{ installationId: common.installationId.toUpperCase().replace("1", "A") }, { workspaceId: "../../../project" },
      { transactionId: "A".repeat(32) }, { manifestVersion: 2 }, { services: ["same", "same"] }, { services: [] },
      { databasePath: "/captured/../state/orders.db" }, { databasePath: db + "\n" }, { databasePath: db + "\ud800" }, { statePath: "/captured/state/" }])
      expect(parseEnrollmentExpectation(encode({ ...expectation, ...patch }))).toBeNull();
    expect(capturedEnrollmentNames("/", db)).toBeNull();
    expect(capturedEnrollmentNames(home, "/orders.db")).toBeNull();
  });
  it("rejects fabricated safety flags and malformed or oversized captures", () => {
    for (const raw of [encode({ ...enrolled(), nativeProof: true }), encode({ ...enrolled(), approved: true }),
      encode(enrolled()).replace('{"version":1', '{"version":0,"version":1'), "x".repeat(ENROLLMENT_RECORD_LIMIT + 1)]) {
      expect(parseEnrollmentCapture(raw)).toBeNull();
      const result = assessEnrollmentCapture(raw); expect(result.classification).toBe("blocked-capture"); disabled(result);
    }
  });
  it.each([
    ["registry lost with binding", { registryDirectory: absent(names.registry), expectationsDirectory: absent(names.expectations), expectation: absent(names.expectation) }],
    ["root lost", { root: absent(names.root) }], ["pre-enrollment DB rollback", { receipt: { observed: "absent" } }],
    ["registry unreadable", { registryDirectory: { observed: "unavailable", path: names.registry, reason: "denied" } }],
    ["root without registry", { registryDirectory: absent(names.registry), expectationsDirectory: absent(names.expectations), expectation: absent(names.expectation) }],
    ["pending enrollment", { expectation: file(names.expectation, { ...expectation, phase: "enrolling" }) }],
    ["recovery blocked", { expectation: file(names.expectation, { ...expectation, phase: "recovery-blocked" }) }],
    ["root not committed", { root: file(names.root, { ...root, phase: "prepared" }) }],
    ["foreign workspace", { receipt: { observed: "record", bytes: encode({ ...receipt, workspaceId: common.installationId }) } }],
    ["old generation", { receipt: { observed: "record", bytes: encode({ ...receipt, recoveryGeneration: "d".repeat(32) }) } }],
    ["wrong transaction", { root: file(names.root, { ...root, transactionId: "d".repeat(32) }) }],
    ["renamed state directory", { stateDirectory: directory(names.state, 200) }],
    ["wrong path digest", { expectation: file(names.expectation, { ...expectation, pathDigest: "d".repeat(64) }) }],
    ["unadmitted service", { binding: file("/captured/service/binding.json", { ...binding, serviceId: "unadmitted" }) }],
    ["foreign installation", { binding: file("/captured/service/binding.json", { ...binding, installationId: common.workspaceId }) }],
  ])("blocks %s without repairing records", (_name, patch) => {
    const capture = { ...enrolled(), ...patch }, before = encode(capture);
    const result = assessEnrollmentCapture(before);
    expect(result.classification).toBe("blocked-capture"); disabled(result); expect(encode(capture)).toBe(before);
  });
  it("does not infer absent from unsafe directories, changed names or contradictory facts", () => {
    for (const patch of [{ registryDirectory: { ...directory(names.registry), mode: 0o755 } },
      { homeDirectory: { ...directory(home), uid: 999 } }, { stateDirectory: { ...directory(names.state, 20), mode: 0o777 } },
      { expectation: { ...absent(names.expectation), path: "/different" } },
      { registryDirectory: absent(names.registry), expectationsDirectory: directory(names.expectations) }])
      expect(assessEnrollmentCapture(encode({ ...personal(), ...patch })).classification).toBe("blocked-capture");
  });
  it("rejects substituted file types, hardlinks, mode, owner, bytes and name", () => {
    for (const patch of [{ observed: "fifo" }, { nlink: 2 }, { mode: 0o644 }, { uid: 999 }, { path: names.root }, { size: 0 },
      { observed: "unavailable", reason: "changed" }]) {
      const result = assessEnrollmentCapture(encode({ ...enrolled(), expectation: { ...file(names.expectation, expectation), ...patch } }));
      expect(result.classification).toBe("blocked-capture"); disabled(result);
    }
  });
  it("treats a byte-size mismatch and UTF8 oversized capture as invalid", () => {
    const c = enrolled(); c.expectation.size++;
    expect(assessEnrollmentCapture(encode(c)).classification).toBe("blocked-capture");
    expect(parseEnrollmentCapture(encode({ ...personal(), extra: "😀".repeat(ENROLLMENT_RECORD_LIMIT / 3) }))).toBeNull();
  });
  it("represents only ordered unchanged expected-record transitions, without granting the write", () => {
    const phases = ["expectation-durable", "records-prepared", "expectation-enrolled", "service-activated"];
    for (let i = 0; i < 3; i++) {
      const before = { ...expectation, phase: i < 2 ? "enrolling" : "enrolled" };
      const after = { ...expectation, phase: i + 1 < 2 ? "enrolling" : "enrolled" };
      const result = assessEnrollmentTransition(encode({ before: encode(before), after: encode(after), from: phases[i], to: phases[i + 1] }));
      expect(result.classification).toBe("consistent-transition-capture"); disabled(result);
    }
    const base = { before: encode({ ...expectation, phase: "enrolling" }), after: encode(expectation), from: "records-prepared", to: "expectation-enrolled" };
    for (const patch of [{ to: "service-activated" }, { to: "expectation-durable" }, { from: "expectation-enrolled" },
      { after: encode({ ...expectation, transactionId: "f".repeat(32) }) }, { after: encode({ ...expectation, services: ["other"] }) },
      { after: encode({ ...expectation, phase: "recovery-blocked" }) }, { approved: true }]) {
      const result = assessEnrollmentTransition(encode({ ...base, ...patch }));
      expect(result.classification).toBe("blocked-capture"); disabled(result);
    }
  });
});
