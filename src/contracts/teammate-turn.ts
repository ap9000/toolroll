/**
 * A teammate's turn (teammates.ts): one schema for the JSON Schema Claude answers in (`--json-schema`) and the reader
 * that takes the answer back. One flat object with every field (a root union is refused by the API); fields a turn
 * does not use are "" (or [] for options).
 *
 * The text limits (TURN_LIMITS, from TEXT_LIMITS) are deliberately not in the schema: the CLI refuses an answer a few
 * characters over one whole, so they are checked after parsing and an answer over one is asked once to shorten
 * (teammate-work.ts), then kept whole. What the zone allows — which actions, which answers, a note for a send-back, a
 * question for an ask, a tool for a tool call — is checked after parsing too (`readTurn`), by path.
 *
 * A turn is kept as the step's decision (`flow_step_run.decision_json`) as it was read, so a saved one is this shape.
 */

import { z } from "zod";
import { parseContract, toModelSchema, type ContractResult } from "./contract.js";

/** What a teammate may do on one turn. A decision zone: approve, send back, or hand it to a person. A work zone: pick
 * where it goes, ask its person, or say it can't. v94: "use_tool" asks for one tool call. */
export const TURN_ACTIONS = ["approve", "send_back", "hand_off", "route", "ask", "cant", "use_tool"] as const;
export type TurnAction = (typeof TURN_ACTIONS)[number];

export const teammateTurnSchema = z.object({
  action: z.enum(TURN_ACTIONS),
  /** route: one of the zone's answers, exactly as written. */
  answer: z.string(),
  /** What the next zones read, or the draft as rewritten. */
  text: z.string(),
  /** A decision or send-back note. */
  note: z.string(),
  /** ask: one short question, with up to 4 options to tap. */
  question: z.string(),
  options: z.array(z.string()),
  /** One plain sentence saying why, for its manager's log. */
  reason: z.string(),
  /** use_tool: the tool's name, and its input as a JSON object written as text. */
  tool: z.string(),
  input: z.string(),
  /** v95: one short fact worth keeping for later cards ("": none). */
  remember: z.string(),
});

export type TurnAnswer = z.infer<typeof teammateTurnSchema>;

/** What Claude's `--json-schema` is for a turn: the turn schema, exactly. */
export const TURN_MODEL_SCHEMA: Readonly<Record<string, unknown>> = toModelSchema(teammateTurnSchema);

/** Older and plain-text turns default absent or non-text fields to "", and keep only string options. */
export function readTurnAnswer(value: unknown): ContractResult<TurnAnswer> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const body = { ...value } as Record<string, unknown>;
    for (const key of Object.keys(teammateTurnSchema.shape)) {
      if (key !== "action" && key !== "options" && typeof body[key] !== "string") body[key] = "";
    }
    body["options"] = Array.isArray(body["options"]) ? body["options"].filter(one => typeof one === "string") : [];
    value = body;
  }
  return parseContract(teammateTurnSchema, value);
}
