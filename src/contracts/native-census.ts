/**
 * The macOS process census the recovery helper prints (docs/plans/zod-revamp.md, item 19): `schema: 1`, the boot,
 * the collector, and one identity per process. The parser in process-recovery-native.ts reads it with these schemas
 * and keeps its fail-closed reason codes: a top-level problem is `malformed-native-census`, one in a process row
 * `malformed-process-identity`. Duplicate pids and unique ids, the 64-bit bound on ids and completeness run in plain
 * code after parsing. Unknown keys are dropped, and each identity is rebuilt in its sealed key order.
 */

import { z } from "zod";

export const NATIVE_CENSUS_ERRORS = ["kernel-process-table-unreadable", "process-membership-unreadable", "process-identity-unreadable", "boot-identity-unreadable", "coalition-counters-unreadable", "coalition-counters-changed", "coalition-count-mismatch", "anchor-identity-unreadable"] as const;

/** A kernel unique id: a decimal unsigned 64-bit integer as text (the bound itself is checked after parsing). */
const kernelId = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const count = z.int().min(0);
const version32 = z.int().min(0).max(0xffffffff);

export const darwinProcessIdentitySchema = z.object({
  pid: z.int().min(1),
  ppid: count.nullable(),
  uid: count.nullable(),
  birthMs: z.number().positive().nullable(),
  uniqueId: kernelId.nullable(),
  parentUniqueId: kernelId.nullable(),
  traced: z.boolean().nullable(),
  executable: z.string().max(4096).regex(/^[^\x00-\x1f\x7f]*$/).nullable(),
  originalParentVersion: version32.nullable(),
  pidVersion: version32.exactOptional(),
});
export type DarwinProcessIdentity = z.infer<typeof darwinProcessIdentitySchema>;

/** Top level only: process rows are read one by one, so a bad row gets its own reason. */
export const darwinNativeCensusSchema = z.object({
  schema: z.literal(1),
  bootId: z.string().regex(/^[a-fA-F0-9-]{36}$/).nullable(),
  collectorPid: z.int().min(2),
  complete: z.boolean(),
  processes: z.array(z.unknown()).max(100_000),
  errors: z.array(z.enum(NATIVE_CENSUS_ERRORS)),
});

/** A kernel id within 64 bits (the schema checks the digits). */
export const kernelIdInRange = (id: string): boolean => BigInt(id) <= 0xffffffffffffffffn;
