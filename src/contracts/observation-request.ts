/**
 * A focused observation request (observations.ts `parseObservationCases`): the file a builder writes to ask for one to
 * four focused test runs, each naming a criterion, base or head, one test file and one test name.
 *
 * Toolroll defines this request, so it is strict: an unknown key, at the top or in an observation, is refused, as it
 * always was. A request without `version` reads as version 1; a newer one is refused. What JSON Schema can't say —
 * a criterion the brief asked about, a normalized test path, a usable test name, one distinct observation per
 * criterion — is checked after parsing.
 */

import { z } from "zod";
import { readVersioned, versioned, type ContractResult } from "./contract.js";

export const observationCaseSchema = z.strictObject({
  criterion: z.string(),
  at: z.enum(["base", "head"]),
  testPath: z.string(),
  testName: z.string(),
});

export const observationRequestSchema = versioned(1, {
  observations: z.array(observationCaseSchema).min(1).max(4),
});

export type ObservationCase = z.infer<typeof observationCaseSchema>;
export type ObservationRequest = z.infer<typeof observationRequestSchema>;

/** A parsed request (JSON already read). A request written without `version` is read as version 1. */
export function readObservationRequest(input: unknown): ContractResult<ObservationRequest> {
  return readVersioned(observationRequestSchema, input, { 0: body => ({ ...body, version: 1 }) });
}
