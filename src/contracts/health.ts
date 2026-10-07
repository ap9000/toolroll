import { z } from 'zod';
import { ROUTE_FAMILIES } from '../server-telemetry.js';

const count = z.number().int().nonnegative();
const milliseconds = z.number().nonnegative();
export const latencySummarySchema = z.looseObject({ count, p50Ms: milliseconds.nullable(), p99Ms: milliseconds.nullable(), maxMs: milliseconds.nullable(), totalMs: milliseconds });
export const healthSnapshotSchema = z.looseObject({
  version: z.literal(1), windowSeconds: z.literal(300), uptimeSeconds: z.number().nonnegative(),
  requests: latencySummarySchema, routes: z.partialRecord(z.enum(ROUTE_FAMILIES), latencySummarySchema), eventLoop: latencySummarySchema,
  writes: z.looseObject({ wait: latencySummarySchema, hold: latencySummarySchema, statement: latencySummarySchema }),
  streams: z.looseObject({ open: count, queuedBytes: count, maxQueuedBytes: count }), budgetRefusals: count,
});
