/**
 * What Slack, Discord and Teams keep between steps (chat-delivery-state.ts): one schema for a received event's body
 * (`chat_event.payload`, by the event's kind) and one for a planned message part (`chat_part.payload`), the message a
 * button rides and the content a delivery repaints. Both are saved with `version`; a body or part saved before they
 * carried one reads as it did then (its known fields; a reader then passed any others by unread).
 *
 * An event body lives only until the event is handled (then it is `{}`); a part lives as long as its message.
 */

import { z } from "zod";
import { parseContract, readVersioned, versioned, type ContractResult } from "./contract.js";

const id = z.int().min(1);
const link = z.strictObject({ label: z.string(), path: z.string() });

/** One planned message part, as delivery reads it. */
export const chatContentShape = {
  text: z.string(),
  /** Where the part is sent when not the binding's own DM: a room's channel. */
  channel: z.string().optional(),
  proposal: id.optional(),
  image: z.strictObject({ taskId: z.string(), run: z.int(), artifact: z.int(), sha256: z.string() }).optional(),
  /** A screenshot sent with a result (result-shots.ts): it follows that result's message part, in its thread when
   * the app allows; a refused upload becomes one plain line, and one removed by retention goes quietly. */
  shot: z.strictObject({ follows: z.int().nullable() }).optional(),
  task: z.string().optional(),
  run: z.int().optional(),
  edit: z.string().optional(),
  phase: z.literal("armed").optional(),
  link: link.optional(),
  /** More link buttons after `link`: [Look first] beside [Merge] or [Accept and finish]. */
  also: z.array(link).optional(),
  /** A flow decision's buttons ride this part (v88): minted when it is planned. */
  flow: z.strictObject({ card: id, entry: z.int(), actions: z.array(z.enum(["approve", "edit", "send-back"])) }).optional(),
  /** A flow's "Person chooses" buttons ride this part: minted when it is planned. */
  choose: z.strictObject({ card: id, entry: z.int(), options: z.array(z.strictObject({ choice: z.int(), label: z.string() })) }).optional(),
  /** "Use this as your note?" Yes / No about the person's message `held` (an event id), for one choice's visit. */
  note: z.strictObject({ card: id, entry: z.int(), held: z.string() }).optional(),
  /** A teammate's question's buttons ride this part (v93): each option, then one to answer in words (choice null). */
  question: z.strictObject({ id, choices: z.array(z.strictObject({ choice: z.string().nullable(), label: z.string() })) }).optional(),
  /** The lead's question to its owner rides this part: its options, then "Something else". */
  ask: z.strictObject({ turn: id, options: z.array(z.string()) }).optional(),
  /** The lead's own reply, already shaped (reply-shape.ts): the channel renders its bold anchors and labelled links in its own format. */
  voice: z.literal(true).optional(),
};

export const chatContentSchema = z.strictObject(chatContentShape);
export type ChatContent = z.infer<typeof chatContentSchema>;

export const CHAT_PART_VERSION = 1;
export const savedChatPartSchema = versioned(CHAT_PART_VERSION, chatContentShape);

/** A saved body or part from before `version`, as version `version`: the fields its schema knows, nothing else. */
function knownFields(version: number, fields: readonly string[]) {
  return (body: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { version };
    for (const field of fields) if (Object.hasOwn(body, field)) out[field] = body[field];
    return out;
  };
}

const PART_UPGRADES = { 0: knownFields(CHAT_PART_VERSION, Object.keys(chatContentShape)) } as const;

/** JSON text, then the schema; `payload: not JSON` for bytes that aren't. */
function fromJson<T>(raw: string, read: (body: unknown) => ContractResult<T>): ContractResult<T> {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, issues: [{ path: "payload", kind: "invalid", line: "payload: not JSON" }] };
  }
  return read(body);
}

/** A saved part's content (`version` is the saved form's, not the content's). */
export function readChatPart(raw: string): ContractResult<ChatContent> {
  const read = fromJson(raw, body => readVersioned(savedChatPartSchema, body, PART_UPGRADES));
  if (!read.ok) return read;
  const { version: _version, ...content } = read.value;
  return { ok: true, value: content };
}

/** A part as it is saved. */
export function savedChatPart(content: ChatContent): string {
  return JSON.stringify({ version: CHAT_PART_VERSION, ...content });
}

// ---- event bodies ------------------------------------------------------------------------------------------------

export const CHAT_EVENT_VERSION = 1;

/** `pair <code>`: only the code's hash is kept. */
export const chatPairBodySchema = versioned(CHAT_EVENT_VERSION, { hash: z.string() });

/**
 * A message: its words (cut at the lead's limit, `originalLength` saying how long it was), or a plain line to answer
 * with instead (`unsupported`: a file the app can't take). A room's or notice's carrier event has none. `about` is the
 * task its turn is about, once chosen; `lead` is a held message passed to the lead as it was (chat-flow.ts).
 */
export const chatMessageBodySchema = versioned(CHAT_EVENT_VERSION, {
  text: z.string().optional(),
  originalLength: z.int().min(0).optional(),
  unsupported: z.string().optional(),
  about: z.strictObject({ task: z.string(), run: z.int().nullable() }).optional(),
  lead: z.literal(true).optional(),
});

/**
 * A button: the one-time token it carried, or, when the app's callback came from the paired person but its data
 * couldn't be read, the path-named line saying why — answered plainly, and nothing is done.
 */
export const chatTokenBodySchema = versioned(CHAT_EVENT_VERSION, { token: z.string().regex(/^[a-f0-9]{32}$/, { error: "must be a Toolroll button token" }) });
export const chatProblemBodySchema = versioned(CHAT_EVENT_VERSION, { problem: z.string().min(1) });
export const chatActionBodySchema = z.union([chatTokenBodySchema, chatProblemBodySchema]);

/** A notice carries its parts, not a body. */
export const chatNoticeBodySchema = versioned(CHAT_EVENT_VERSION, {});

export type ChatPairBody = z.infer<typeof chatPairBodySchema>;
export type ChatMessageBody = z.infer<typeof chatMessageBodySchema>;
export type ChatActionBody = z.infer<typeof chatActionBodySchema>;

/** What a writer hands `ChatState.enqueue`: a body of the event's kind, without `version` (it is stamped on saving). */
export type ChatEventBody =
  | Omit<ChatPairBody, "version">
  | Omit<ChatMessageBody, "version">
  | { token: string }
  | { problem: string }
  | Record<string, never>;

export function savedChatEventBody(body: ChatEventBody): string {
  return JSON.stringify({ version: CHAT_EVENT_VERSION, ...body });
}

const upgradeBody = (fields: readonly string[]) => ({ 0: knownFields(CHAT_EVENT_VERSION, fields) }) as const;

/** A pair event's body. */
export function readChatPairBody(raw: string): ContractResult<ChatPairBody> {
  return fromJson(raw, body => readVersioned(chatPairBodySchema, body, upgradeBody(["hash"])));
}

/** A message event's body. */
export function readChatMessageBody(raw: string): ContractResult<ChatMessageBody> {
  return fromJson(raw, body => readVersioned(chatMessageBodySchema, body, upgradeBody(Object.keys(chatMessageBodySchema.shape))));
}

/** An action event's body: a token, or the reason its callback couldn't be read. */
export function readChatActionBody(raw: string): ContractResult<ChatActionBody> {
  return fromJson(raw, (body): ContractResult<ChatActionBody> =>
    typeof body === "object" && body !== null && !Array.isArray(body) && Object.hasOwn(body, "problem")
      ? readVersioned(chatProblemBodySchema, body, upgradeBody(["problem"]))
      : readVersioned(chatTokenBodySchema, body, upgradeBody(["token"])));
}

/** Words held for "Use this as your note?" (`chat_flow_note.words`): the held message's own text and length. */
export const heldWordsSchema = z.strictObject({ text: z.string(), originalLength: z.int().min(0).optional() });
export type HeldWords = z.infer<typeof heldWordsSchema>;

export function readHeldWords(raw: string): ContractResult<HeldWords> {
  return fromJson(raw, body => parseContract(heldWordsSchema, body));
}
