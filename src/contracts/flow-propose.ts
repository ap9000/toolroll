/**
 * The lead's `propose_flow` input (docs/plans/zod-revamp.md, item 3): one schema, built from the flow contract's own
 * step and trigger schemas, that is both the JSON Schema the lead is given and the check its call is read with
 * (mate-tools.ts). The lead-tools contract (item 5) imports it from here rather than restating it.
 */

import { z } from "zod";
import { LIMITS } from "../decision.js";
import { STARTER_IDS } from "../flow-starters.js";
import { FLOW_TEMPLATES } from "../flows.js";
import { KITS } from "../kits.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { toModelSchema } from "./contract.js";
import { flowStepsSchema, leadTriggerSchema, SCRIPT_LANGUAGES, SCRIPT_NAME } from "./flow.js";

export const PROPOSE_FLOW_OPERATIONS = ["create", "edit", "add_card", "move_card", "approve", "send_back", "choose", "cancel_card", "comment", "assign", "follow", "unfollow", "save_script", "add_trigger", "pause_trigger", "resume_trigger", "remove_trigger", "kit", "starter"] as const;

const id = z.int().min(1);
const enumOf = (values: readonly string[]) => z.enum(values as [string, ...string[]]);

export const proposeFlowInputSchema = z.strictObject({
  operation: z.enum(PROPOSE_FLOW_OPERATIONS),
  /** A project as list_repos names it (r1, r2). */
  repo: z.string().regex(/^r[0-9]{1,3}$/, { error: "must be a project from list_repos, like r1" }).optional(),
  flow: id.optional(), card: id.optional(),
  kit: enumOf(KITS.map(one => one.id)).optional(),
  starter: z.enum(STARTER_IDS).optional(),
  name: z.string().max(TEXT_LIMITS.flowName).optional(),
  template: enumOf(FLOW_TEMPLATES.map(one => one.id)).optional(),
  steps: flowStepsSchema.shape.steps.optional(),
  title: z.string().max(TEXT_LIMITS.flowCardTitle).optional(),
  description: z.string().max(TEXT_LIMITS.flowCardDescription).optional(),
  zone: z.string().max(TEXT_LIMITS.flowRef).optional(),
  note: z.string().max(LIMITS.note).describe(`At most ${LIMITS.note} characters; longer is refused with its length, not cut.`).optional(),
  choice: z.int().min(1).max(4).optional(),
  trigger: id.optional(),
  owner: z.string().max(TEXT_LIMITS.flowDecider).optional(),
  script: z.strictObject({
    name: z.string().regex(SCRIPT_NAME, { error: "must be a script's name: lowercase letters, numbers and dashes" }).optional(), about: z.string().max(TEXT_LIMITS.flowScriptAbout).optional(), body: z.string().max(TEXT_LIMITS.flowScriptInline).optional(),
    timeoutMinutes: z.int().min(1).max(60).optional(), language: z.enum(SCRIPT_LANGUAGES).optional(), file: z.string().max(TEXT_LIMITS.flowScriptFile).optional(),
  }).optional(),
  settings: leadTriggerSchema.optional(),
});
export type ProposeFlowInput = z.infer<typeof proposeFlowInputSchema>;

/** What the lead is told propose_flow takes: exactly the schema its call is read with. */
export const PROPOSE_FLOW_MODEL_SCHEMA: Readonly<Record<string, unknown>> = toModelSchema(proposeFlowInputSchema);
