/**
 * A Teams button tap (teams-chat.ts `receiveTeams`): an Adaptive Card `Action.Submit` arrives as a message activity
 * whose `value` is the data Toolroll put on the button, `{ so: <one-time token> }`. The activity is Microsoft's (read
 * by `receiveTeams`); only `value.so` is read, as before, and extra submit keys are ignored. A tap from the paired person whose data can't be read
 * is answered with why (`value.so: must be a Toolroll button token`), and nothing is done.
 */

import { z } from "zod";
import { parseContract, type ContractResult } from "./contract.js";

export const teamsSubmitSchema = z.object({ so: z.string().regex(/^[a-f0-9]{32}$/, { error: "must be a Toolroll button token" }) });
export type TeamsSubmit = z.infer<typeof teamsSubmitSchema>;

/** A submit's one-time token. */
export function readTeamsSubmit(value: unknown): ContractResult<string> {
  const read = parseContract(z.object({ value: teamsSubmitSchema }), { value });
  return read.ok ? { ok: true, value: read.value.value.so } : read;
}
