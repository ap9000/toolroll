/**
 * A flow card's state (docs/plans/zod-revamp.md, item 8): what the flow engine, its steps and its Send to me and
 * Person chooses zones read and write (flow-engine.ts, flow-steps.ts, flow-send.ts), as the store keeps it in
 * `flow_card`. Its columns are versioned by the database's own schema version; the one payload in it, what finished
 * zones handed on (`outputs_json`), carries its own version (stage-output.ts).
 *
 * `flowCardSchema` is the card as read; `flowCardChangeSchema` what one update may change. Where it came from
 * (`source_json`, written by triggers) keeps its own type in the store.
 */

import { z } from "zod";
import { cardOutputsSchema } from "./stage-output.js";

export const FLOW_CARD_STATES = ["active", "done", "cancelled"] as const;
export type FlowCardState = (typeof FLOW_CARD_STATES)[number];

export const flowCardSchema = z.strictObject({
  id: z.int().min(1),
  flow: z.int().min(1),
  title: z.string(),
  description: z.string().nullable(),
  /** The zone it is in, and which visit to that zone this is (each move is a fresh one). */
  stage: z.string(),
  entry: z.int().min(1),
  state: z.enum(FLOW_CARD_STATES),
  /** The task its zone filed this visit, and the card's main build. */
  task: z.string().nullable(),
  primaryTask: z.string().nullable(),
  /** The latest note it was sent back or replied to with ({{note}}). */
  note: z.string().nullable(),
  /** What it waits for, in words. */
  waiting: z.string().nullable(),
  /** What finished zones handed on ({{stage.…}}), and any too long to pass on, whole. */
  outputs: cardOutputsSchema.shape.outputs,
  attached: cardOutputsSchema.shape.attached,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  owner: z.string().nullable(),
});

export type FlowCardFields = z.infer<typeof flowCardSchema>;

/** What one update of a card may change; whatever is left out stays as it is. Outputs replace the card's whole;
 * an attachment goes with the output it belongs to. */
export const flowCardChangeSchema = z.strictObject({
  task: flowCardSchema.shape.task.optional(),
  primaryTask: z.string().optional(),
  waiting: flowCardSchema.shape.waiting.optional(),
  outputs: flowCardSchema.shape.outputs.optional(),
  attached: flowCardSchema.shape.attached.optional(),
  state: z.enum(["done", "cancelled"]).optional(),
});

export type FlowCardChange = z.infer<typeof flowCardChangeSchema>;
