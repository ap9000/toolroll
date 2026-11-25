/** Unreachable representation contract. No IO, discovery, authentication or live admission.
 * Captures are assertions supplied by an offline auditor, not native filesystem proofs.
 * Even a consistent capture NEVER permits serving, dispatch, enrollment or recovery. */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { WORKSPACE_ID_PATTERN, RECOVERY_GENERATION_PATTERN } from "./workspace-identity-schema.js";

export const ENROLLMENT_RECORD_LIMIT = 65_536;
const uuid = z.string().regex(WORKSPACE_ID_PATTERN);
const hex = z.string().regex(RECOVERY_GENERATION_PATTERN);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const path = z.string().min(2).max(4096).refine(value => value.startsWith("/") && !/[\x00-\x1f\x7f\\]/.test(value)
  && posix.normalize(value) === value && !value.endsWith("/")
  && [...value].every(char => { const code = char.codePointAt(0)!; return code < 0xd800 || code > 0xdfff; }));
const identity = z.object({ dev: integer, ino: integer }).strict();
const common = {
  version: z.literal(1), installationId: uuid, workspaceId: uuid, ownerUid: integer,
  databasePath: path, statePath: path, stateIdentity: identity, protocolVersion: z.literal(1), manifestVersion: z.literal(1), transactionId: hex,
};
const expectationSchema = z.object({ ...common, pathDigest: digest, phase: z.enum(["enrolling", "enrolled", "recovery-blocked"]),
  services: z.array(z.string().min(1).max(256)).min(1).max(8).refine(v => new Set(v).size === v.length),
}).strict();
const rootSchema = z.object({ ...common, recoveryGeneration: hex, phase: z.enum(["prepared", "committed"]) }).strict();
const receiptSchema = z.object({ ...common, recoveryGeneration: hex }).strict();
const bindingSchema = z.object({ version: z.literal(1), installationId: uuid, ownerUid: integer, databasePath: path,
  pathDigest: digest, registryVersion: z.literal(1), centralRecoveryRequired: z.literal(true),
  serviceId: z.string().min(1).max(256), definitionDigest: digest,
}).strict();
export type EnrollmentExpectation = z.infer<typeof expectationSchema>;
export type EnrollmentRoot = z.infer<typeof rootSchema>;
export type EnrollmentReceipt = z.infer<typeof receiptSchema>;
export type EnrollmentBinding = z.infer<typeof bindingSchema>;

/** Canonical JSON is intentionally required here: duplicate keys, alternate encodings,
 * trailing input and whitespace cannot conceal a second record interpretation.
 * A future filesystem adapter must bound the read BEFORE allocating the string. */
function decode<T>(raw: string, schema: z.ZodType<T>): T | null {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > ENROLLMENT_RECORD_LIMIT) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (JSON.stringify(value) !== raw) return null;
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
export const parseEnrollmentExpectation = (raw: string): EnrollmentExpectation | null => decode(raw, expectationSchema);
export const parseEnrollmentRoot = (raw: string): EnrollmentRoot | null => decode(raw, rootSchema);
export const parseEnrollmentReceipt = (raw: string): EnrollmentReceipt | null => decode(raw, receiptSchema);
export const parseEnrollmentBinding = (raw: string): EnrollmentBinding | null => decode(raw, bindingSchema);

const unavailable = z.object({ observed: z.literal("unavailable"), path, reason: z.enum(["denied", "changed", "invalid", "unknown"]) }).strict();
const absent = z.object({ observed: z.literal("absent"), path, error: z.literal("ENOENT") }).strict();
const directory = z.object({ observed: z.literal("directory"), path, uid: integer, mode: integer, dev: integer, ino: integer }).strict();
const file = z.object({ observed: z.literal("file"), path, uid: integer, mode: integer, nlink: integer,
  dev: integer, ino: integer, size: integer, bytes: z.string().max(ENROLLMENT_RECORD_LIMIT),
}).strict();
const node = z.discriminatedUnion("observed", [unavailable, absent, directory, file]);
const receipt = z.discriminatedUnion("observed", [
  z.object({ observed: z.literal("absent") }).strict(),
  z.object({ observed: z.literal("unavailable") }).strict(),
  z.object({ observed: z.literal("record"), bytes: z.string().max(ENROLLMENT_RECORD_LIMIT) }).strict(),
]);
const captureSchema = z.object({ version: z.literal(1), ownerUid: integer, home: path, databasePath: path,
  homeDirectory: node, stateDirectory: node, registryDirectory: node, expectationsDirectory: node,
  secretsDirectory: node, expectation: node, root: node, binding: node, receipt,
}).strict();
export type EnrollmentCapture = z.infer<typeof captureSchema>;
/** This parser validates representation only. There is deliberately no 'proved' flag/brand. */
export const parseEnrollmentCapture = (raw: string): EnrollmentCapture | null => decode(raw, captureSchema);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Computes proposed names from captured OS-home/path facts; it does NOT discover them. */
export function capturedEnrollmentNames(home: string, databasePath: string): {
  registry: string; expectations: string; expectation: string; state: string; secrets: string; root: string; pathDigest: string;
} | null {
  if (!path.safeParse(home).success || !path.safeParse(databasePath).success) return null;
  const registry = `${home}/.toolroll-central`, state = posix.dirname(databasePath), pathDigest = hash(databasePath);
  if (!path.safeParse(state).success) return null;
  return { registry, expectations: `${registry}/expectations`, expectation: `${registry}/expectations/${pathDigest}.json`,
    state, secrets: `${state}/.toolroll-secrets`, root: `${state}/.toolroll-secrets/central-recovery.json`, pathDigest };
}
type Node = z.infer<typeof node>;
const privateDirectory = (n: Node, expected: string, uid: number): boolean => n.observed === "directory"
  && n.path === expected && n.uid === uid && n.mode === 0o700;
const privateFile = (n: Node, expected: string, uid: number): string | null => n.observed === "file" && n.path === expected
  && n.uid === uid && n.mode === 0o600 && n.nlink === 1 && n.size === Buffer.byteLength(n.bytes, "utf8") ? n.bytes : null;
const missing = (n: Node, expected: string): boolean => n.observed === "absent" && n.path === expected;
const inaccessible = (n: Node): boolean => n.observed === "unavailable";

export type EnrollmentAssessment = Readonly<{
  classification: "personal-capture" | "blocked-capture" | "consistent-enrolled-capture" | "consistent-transition-capture";
  reason: string; nativeProof: "not-performed";
  capabilities: Readonly<{ admission: false; enrollment: false; recoveryReady: false; remoteReads: false; dispatch: false }>;
}>;
const assessment = (classification: EnrollmentAssessment["classification"], reason: string): EnrollmentAssessment => Object.freeze({
  classification, reason, nativeProof: "not-performed", capabilities: Object.freeze({ admission: false, enrollment: false,
    recoveryReady: false, remoteReads: false, dispatch: false }),
});
/** Accepts raw input so forged typed objects cannot skip strict shape validation.
 * Results classify captures only: callers cannot turn a capture into native standing. */
export function assessEnrollmentCapture(raw: string): EnrollmentAssessment {
  const c = parseEnrollmentCapture(raw), blocked = (why: string) => assessment("blocked-capture", why);
  if (c === null) return blocked("invalid-capture");
  const n = capturedEnrollmentNames(c.home, c.databasePath);
  if (n === null) return blocked("invalid-path");
  if (c.homeDirectory.observed !== "directory" || c.homeDirectory.path !== c.home || c.homeDirectory.uid !== c.ownerUid
    || (c.homeDirectory.mode & 0o022) !== 0 || !privateDirectory(c.stateDirectory, n.state, c.ownerUid)) return blocked("unsafe-anchor-capture");
  if ([c.registryDirectory, c.expectationsDirectory, c.secretsDirectory, c.expectation, c.root, c.binding].some(inaccessible)
    || c.receipt.observed === "unavailable") return blocked("indeterminate-capture");
  const registryAbsent = missing(c.registryDirectory, n.registry);
  const registryPresent = privateDirectory(c.registryDirectory, n.registry, c.ownerUid);
  const expectationsAbsent = missing(c.expectationsDirectory, n.expectations);
  const expectationsPresent = privateDirectory(c.expectationsDirectory, n.expectations, c.ownerUid);
  const secretsAbsent = missing(c.secretsDirectory, n.secrets);
  const secretsPresent = privateDirectory(c.secretsDirectory, n.secrets, c.ownerUid);
  if ((!registryAbsent && !registryPresent) || (!expectationsAbsent && !expectationsPresent) || (!secretsAbsent && !secretsPresent)
    || (registryAbsent && !expectationsAbsent)) return blocked("unsafe-directory-capture");
  const noExpectation = missing(c.expectation, n.expectation), noRoot = missing(c.root, n.root);
  if (registryAbsent && !noExpectation || expectationsAbsent && !noExpectation || secretsAbsent && !noRoot) return blocked("contradictory-capture");
  if (noExpectation && noRoot && c.binding.observed === "absent" && c.receipt.observed === "absent") {
    return assessment("personal-capture", "no-enrollment-evidence-in-capture");
  }
  if (!registryPresent || !expectationsPresent || !secretsPresent) return blocked("expected-records-missing");
  const eRaw = privateFile(c.expectation, n.expectation, c.ownerUid), rRaw = privateFile(c.root, n.root, c.ownerUid);
  // Service binding location/installation is deliberately not proved by this offline module.
  const bRaw = privateFile(c.binding, c.binding.path, c.ownerUid);
  const e = eRaw === null ? null : parseEnrollmentExpectation(eRaw), r = rRaw === null ? null : parseEnrollmentRoot(rRaw);
  const b = bRaw === null ? null : parseEnrollmentBinding(bRaw);
  const d = c.receipt.observed === "record" ? parseEnrollmentReceipt(c.receipt.bytes) : null;
  if (e === null || r === null || b === null || d === null) return blocked("missing-or-invalid-record");
  const s = c.stateDirectory;
  if (s.observed !== "directory") return blocked("unsafe-state");
  for (const record of [e, r, d]) {
    if (record.ownerUid !== c.ownerUid || record.databasePath !== c.databasePath || record.statePath !== n.state
      || record.stateIdentity.dev !== s.dev || record.stateIdentity.ino !== s.ino || record.installationId !== e.installationId
      || record.workspaceId !== e.workspaceId || record.transactionId !== e.transactionId) return blocked("record-mismatch");
  }
  if (e.pathDigest !== n.pathDigest || b.pathDigest !== n.pathDigest || b.ownerUid !== c.ownerUid || b.databasePath !== c.databasePath
    || b.installationId !== e.installationId || !e.services.includes(b.serviceId) || r.recoveryGeneration !== d.recoveryGeneration) return blocked("binding-mismatch");
  if (e.phase !== "enrolled" || r.phase !== "committed") return blocked("incomplete-transaction");
  return assessment("consistent-enrolled-capture", "requires-native-exclusion-and-retirement-proof");
}

const phases = ["expectation-durable", "records-prepared", "expectation-enrolled", "service-activated"] as const;
export type EnrollmentPhase = typeof phases[number];
const transitionSchema = z.object({ before: z.string().max(ENROLLMENT_RECORD_LIMIT), after: z.string().max(ENROLLMENT_RECORD_LIMIT),
  from: z.enum(phases), to: z.enum(phases),
}).strict();
/** Checks an offline expected-record transition, never authorizes the write.
 * No epoch/path/identity/service change or enrolled->personal transition is expressible. */
export function assessEnrollmentTransition(raw: string): EnrollmentAssessment {
  const input = decode(raw, transitionSchema), blocked = (why: string) => assessment("blocked-capture", why);
  if (input === null) return blocked("invalid-transition");
  const before = parseEnrollmentExpectation(input.before), after = parseEnrollmentExpectation(input.after);
  if (before === null || after === null) return blocked("invalid-expected-record");
  const from = phases.indexOf(input.from), to = phases.indexOf(input.to);
  if (to !== from + 1) return blocked("nonsequential-transition");
  const expectedBefore = from < 2 ? "enrolling" : "enrolled", expectedAfter = to < 2 ? "enrolling" : "enrolled";
  if (before.phase !== expectedBefore || after.phase !== expectedAfter) return blocked("phase-mismatch");
  const { phase: _beforePhase, ...oldFields } = before, { phase: _afterPhase, ...newFields } = after;
  // Parsed schema fixes property order; equality is exact, including service order and identity.
  if (JSON.stringify(oldFields) !== JSON.stringify(newFields)) return blocked("expected-record-changed");
  return assessment("consistent-transition-capture", "transition-represented-only-no-write-authority");
}
