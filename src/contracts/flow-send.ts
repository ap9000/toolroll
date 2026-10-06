/**
 * What a "Send to me" or "Person chooses" visit sends its person (docs/plans/zod-revamp.md, item 8): worked out once
 * per visit and kept (`flow_send.content_json`), so every chat app and the card show the same (src/flow-send.ts).
 *
 * - `flowSendPayloadSchema`: a send's — the title, summary, links, screenshots and a research report's items.
 * - `flowChoosePayloadSchema`: a choice's — the same, with the options as they were offered and whether a reply is taken.
 * - `flowChoiceAnswerSchema`: the person's answer to a choice, by whichever door it comes (chooseFlowCard).
 *
 * Kept before this contract (version 0), a visit's content had no `version`; it reads as the 0.9.36 reader read it:
 * a title, a summary and a list of links make it readable, items that can't be shown are left out, and a link or
 * option that isn't one is skipped.
 */

import { z } from "zod";
import { parseContract, readVersioned, versioned, type ContractResult } from "./contract.js";

/** A link the message carries: a page of Toolroll's (a button) or the one outside page, a pull request. */
export const flowSendLinkSchema = z.union([
  z.strictObject({ label: z.string(), path: z.string().regex(/^\//, { error: "must be a path in Toolroll, starting with /" }) }),
  z.strictObject({ label: z.string(), url: z.string().regex(/^https:\/\/[^\s<>"]+$/, { error: "must be an https:// address" }) }),
]);

/** One item of a research report, as the message lists it (flow-items.ts). */
export const flowSendItemSchema = z.strictObject({
  title: z.string(),
  why: z.string(),
  url: z.string().regex(/^https?:\/\//, { error: "must be a web address" }),
  /** Where the link goes, by name: "Mobbin", "Linear", "Apple". */
  source: z.string(),
  /** One line: how it plugs in (from the why, else the image's own caption). */
  plug: z.string(),
  /** The item's screenshot (its evidence id in the report's run), when it has one. */
  shot: z.int().nullable(),
});

export type FlowSendLink = z.infer<typeof flowSendLinkSchema>;
export type FlowSendItem = z.infer<typeof flowSendItemSchema>;

export const FLOW_SEND_VERSION = 1;

const sendShape = {
  /** The card's title and the step it comes from. */
  title: z.string(),
  /** The step it comes from, when known. */
  from: z.string().optional(),
  summary: z.string(),
  links: z.array(flowSendLinkSchema),
  /** The build's result whose screenshots go with it, when it saved any. */
  shots: z.strictObject({ taskId: z.string(), run: z.int() }).nullable(),
  /** After research: the report's items, numbered in this order in every message and screenshot caption. */
  items: z.array(flowSendItemSchema).min(1).optional(),
};

export const flowChoiceOptionSchema = z.strictObject({ choice: z.int().min(0), label: z.string() });

export const flowSendPayloadSchema = versioned(FLOW_SEND_VERSION, sendShape);
export const flowChoosePayloadSchema = versioned(FLOW_SEND_VERSION, {
  ...sendShape,
  /** The options as they were offered, by place. */
  options: z.array(flowChoiceOptionSchema),
  /** Whether a reply is taken instead (the zone has somewhere replies go). */
  reply: z.boolean(),
});

export type FlowSendPayload = z.infer<typeof flowSendPayloadSchema>;
export type FlowChoosePayload = z.infer<typeof flowChoosePayloadSchema>;
/** A visit's content as the console and chat apps read it: a send's, or a choice's with its options. */
export type FlowSendContent = Omit<FlowSendPayload, "version"> & { options?: FlowChoosePayload["options"]; reply?: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A kept item as 0.9.36 read it: its five words (a web link), and a screenshot id only when it is a whole number. */
const savedItemSchema = z.object({ ...flowSendItemSchema.shape, shot: z.unknown() });
export function readFlowItems(raw: unknown): FlowSendItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(one => {
    const read = savedItemSchema.safeParse(one);
    if (!read.success) return [];
    const shot = read.data.shot;
    return [{ ...read.data, shot: typeof shot === "number" && Number.isSafeInteger(shot) ? shot : null }];
  });
}

/** Version 0: content kept before it carried `version`, in this contract's shape (what can't be read is left for the schema to refuse by path). */
export function upgradeSavedSend(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body["title"] !== "string" || typeof body["summary"] !== "string" || !Array.isArray(body["links"])) return body;
  const items = readFlowItems(body["items"]);
  const shots = sendShape.shots.safeParse(body["shots"]);
  const out: Record<string, unknown> = {
    version: FLOW_SEND_VERSION, title: body["title"], ...(typeof body["from"] === "string" ? { from: body["from"] } : {}), summary: body["summary"],
    links: body["links"].filter(one => flowSendLinkSchema.safeParse(one).success), shots: shots.success ? shots.data : null,
    ...(body["items"] === undefined || items.length === 0 ? {} : { items }),
  };
  if (Array.isArray(body["options"])) {
    out["options"] = body["options"].filter(one => flowChoiceOptionSchema.safeParse(one).success);
    out["reply"] = body["reply"] === true;
  }
  return out;
}

/** Read a visit's kept content: a choice's when it carries options, else a send's; version 0 upgraded, newer refused. */
export function readFlowSendPayload(input: unknown): ContractResult<FlowSendContent> {
  const choose = isRecord(input) && Object.prototype.hasOwnProperty.call(input, "options");
  const read = choose ? readVersioned(flowChoosePayloadSchema, input, { 0: upgradeSavedSend }) : readVersioned(flowSendPayloadSchema, input, { 0: upgradeSavedSend });
  if (!read.ok) return read;
  const { version: _version, ...content } = read.value;
  return { ok: true, value: content };
}

/** A visit's content as it is kept: the payload of its kind, with the current version. */
export function flowSendForStore(content: FlowSendContent): string {
  const payload = { version: FLOW_SEND_VERSION, ...content };
  return JSON.stringify(content.options === undefined ? flowSendPayloadSchema.parse(payload) : flowChoosePayloadSchema.parse(payload));
}

// ------------------------------------------------------------------ the person's choice

/** A person's answer to a choice: an option by its place (and the words and zone they saw), or a reply (`choice` null)
 * that becomes the note for where replies go. `entry` is the visit they saw; without it, the card's current one. */
export const flowChoiceAnswerSchema = z.strictObject({
  card: z.int().min(1),
  entry: z.int().min(1).optional(),
  choice: z.int().min(0).nullable(),
  label: z.string().optional(),
  to: z.string().optional(),
  note: z.string().nullable(),
});

export type FlowChoiceAnswer = z.infer<typeof flowChoiceAnswerSchema>;

export function readFlowChoiceAnswer(input: unknown): ContractResult<FlowChoiceAnswer> {
  return parseContract(flowChoiceAnswerSchema, input);
}
