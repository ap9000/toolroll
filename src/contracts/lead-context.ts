/**
 * The lead's catch-up bundle (lead-context.ts): one schema for the DATA each lead turn opens with, built fresh from the
 * local database, in order of importance. The bundle is checked before it is scrubbed and serialized; its whole size
 * (TEXT_LIMITS.leadContextBytes, in UTF-8 bytes) is met in plain code after, by dropping the least important parts.
 */

import { z } from "zod";
import { limited } from "./contract.js";

/** How many tasks the bundle reads, projects it names, and open promises, corrections and proposals it shows. */
export const LEAD_CONTEXT_COUNTS = { tasks: 8, projects: 8, promises: 10, corrections: 5, proposals: 5 } as const;

export const LEAD_CHANNELS = ["console", "terminal", "telegram", "slack", "discord", "teams"] as const;

/** A task as the lead reads it: which project (`r1`...), its ids, state, goal, outcome, checks, the next action and
 * the questions still open on it. */
export const leadTaskSchema = z.strictObject({
  repo: z.string(),
  id: z.string(),
  currentExecution: z.string(),
  title: z.string(),
  state: z.string(),
  goal: z.string().nullable(),
  outcome: z.string().nullable(),
  checks: z.string().nullable(),
  next: z.string().nullable(),
  decisions: z.array(z.strictObject({ id: z.int(), question: z.string() })),
});

/** The lead's own open promise in this conversation, and when it is due. */
export const leadPromiseSchema = z.strictObject({ id: z.int(), what: limited("promise", "leadPromise"), when: z.string(), expires: z.string() });

/** A correction the operator confirmed since the lead's last reply. */
export const leadCorrectionSchema = z.strictObject({ proposal: z.int(), change: limited("correction", "leadCorrection") });

/** A proposal still open in this conversation, which a correction may affect. */
export const leadOpenProposalSchema = z.strictObject({ proposal: z.int(), kind: z.string(), about: limited("about", "leadProposalAbout").nullable() });

export const LEAD_CONTEXT_VERSION = 3;

export const leadContextSchema = z.strictObject({
  snapshotVersion: z.literal(LEAD_CONTEXT_VERSION),
  source: z.literal("local-database"),
  me: z.strictObject({ name: z.string(), persona: z.string() }),
  you: z.strictObject({ firstName: z.string().nullable(), timeZone: z.string(), today: z.string() }),
  /** Lines the person confirmed about themselves. */
  aboutYou: z.array(z.string()),
  /** The people, subagents and team chats the lead works with, one line each. */
  people: z.strictObject({ people: z.array(z.string()), subagents: z.array(z.string()), teams: z.array(z.string()) }),
  channel: z.strictObject({ id: z.enum(LEAD_CHANNELS), fit: z.string(), replyLimit: z.int().nullable() }).nullable(),
  needsYou: z.array(leadTaskSchema),
  /** This conversation's follow-through; absent outside one. */
  commitments: z.array(leadPromiseSchema).max(LEAD_CONTEXT_COUNTS.promises).optional(),
  corrections: z.array(leadCorrectionSchema).max(LEAD_CONTEXT_COUNTS.corrections).optional(),
  openProposals: z.array(leadOpenProposalSchema).max(LEAD_CONTEXT_COUNTS.proposals).optional(),
  followThrough: z.string().optional(),
  projects: z.array(z.strictObject({
    repo: z.string(),
    name: z.string(),
    decisions: z.array(z.strictObject({ id: z.int(), title: z.string(), why: z.string() })),
  })).max(LEAD_CONTEXT_COUNTS.projects),
  rest: z.strictObject({
    tasks: z.array(leadTaskSchema),
    knowledge: z.array(z.strictObject({
      repo: z.string(),
      status: z.enum(["stored", "none", "unavailable"]),
      revision: z.int().nullable(),
      instructions: z.string(),
      sources: z.array(z.strictObject({ id: z.string(), title: z.string() })),
    })),
  }),
  omissions: z.strictObject({
    assignments: z.int(),
    decisions: z.int(),
    projects: z.int(),
    textFields: z.int(),
    candidateScanLimited: z.boolean(),
    notes: z.array(z.string()),
    people: z.int(),
  }),
  notice: z.string(),
});

export type LeadContextBundle = z.infer<typeof leadContextSchema>;
export type LeadChannel = (typeof LEAD_CHANNELS)[number];
