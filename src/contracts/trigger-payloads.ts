/**
 * What a flow trigger reads from outside (flow-triggers.ts): GitHub's issues, pull requests, workflow runs and webhook
 * events, Linear's GraphQL answers and webhook events, a plain webhook's JSON, a mailbox's normalized message and a
 * shared form's fields.
 *
 * These payloads belong to the services that send them, so each schema describes only the fields Toolroll reads and
 * ignores every other key. A field of the wrong type reads as missing (as the hand reader's `text()` and `record()`
 * did), so no delivery or poll is ever refused here: what was accepted before is accepted now, and what a payload
 * lacks is decided after parsing, with the same answer and plain reason as before. Numbers stay as sent (`number`,
 * `webhookTimestamp`) and are coerced with `Number()` after parsing, as they always were; so do the values whose mere
 * presence counts (`pull_request`, `updatedFrom.stateId`).
 */

import { z } from "zod";
import type { InboundMail } from "../mailbox.js";

/** A field read when it has the type Toolroll expects, and read as missing when it has any other. */
const loose = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const text = loose(z.string());
const named = z.object({ name: text }).catch({});

/** A GitHub issue or pull request, from a poll or inside a webhook event. */
export const githubIssueSchema = z.object({
  /** Coerced with `Number()` after parsing; a card needs a safe integer. */
  number: z.unknown().optional(),
  /** An issue that is a pull request carries this (any value). */
  pull_request: z.unknown().optional(),
  draft: loose(z.boolean()),
  labels: loose(z.array(named)),
  title: text,
  body: text,
  html_url: text,
  author_association: text,
  user: loose(z.object({ login: text })),
  head: loose(z.object({ ref: text })),
  base: loose(z.object({ ref: text })),
  created_at: text,
  updated_at: text,
}).catch({});

/** A GitHub Actions workflow run. */
export const githubRunSchema = z.object({
  conclusion: text,
  head_branch: text,
  head_sha: text,
  name: text,
  display_title: text,
  created_at: text,
  html_url: text,
}).catch({});

/** `repos/:repo/issues` and `repos/:repo/pulls`: a list (anything else reads as an empty one). */
export const githubIssueListSchema = z.array(githubIssueSchema).catch([]);
/** `repos/:repo/issues/events`: a list of issue events. */
export const githubIssueEventListSchema = z.array(z.object({ event: text, label: loose(named), created_at: text, issue: githubIssueSchema.optional() }).catch({})).catch([]);
/** `repos/:repo/actions/runs`. */
export const githubRunListSchema = z.object({ workflow_runs: loose(z.array(githubRunSchema)) }).catch({});

/** A signed GitHub webhook event (`issues`, `pull_request`, `workflow_run`; a `ping` reads as an empty one). */
export const githubEventSchema = z.object({
  action: text,
  repository: loose(z.object({ full_name: text })),
  label: loose(named),
  issue: githubIssueSchema.optional(),
  pull_request: githubIssueSchema.optional(),
  workflow_run: githubRunSchema.optional(),
}).catch({});

/** A Linear issue, from the GraphQL query (`labels { nodes }`) or a webhook's `data` (`labels` as a list). */
export const linearIssueSchema = z.object({
  identifier: text,
  title: text,
  description: text,
  url: text,
  updatedAt: text,
  state: loose(named),
  team: loose(z.object({ key: text })),
  labels: loose(z.union([z.array(named), z.object({ nodes: loose(z.array(named)) })])),
}).catch({});

/** Linear's GraphQL answer to LINEAR_QUERY. */
export const linearAnswerSchema = z.object({
  errors: loose(z.array(z.object({ message: text }).catch({}))),
  data: loose(z.object({ issues: loose(z.object({ nodes: loose(z.array(linearIssueSchema)) })) })),
}).catch({});

/** A signed Linear webhook event. */
export const linearEventSchema = z.object({
  type: text,
  action: text,
  /** Milliseconds; coerced with `Number()` after parsing. */
  webhookTimestamp: z.unknown().optional(),
  /** An update that moved the issue's state carries `stateId` (any value). */
  updatedFrom: loose(z.object({ stateId: z.unknown().optional() })),
  data: linearIssueSchema.optional(),
}).catch({});

/**
 * A plain webhook's body: any JSON. The trigger's own `titleField` and `bodyField` paths (or title/summary/message and
 * description/body/text) are picked from it after parsing, and a body without one is shown whole, so it is kept as sent.
 */
export const webhookPayloadSchema = z.unknown();

/** A message as the mailbox reader hands it on (mailbox.ts normalizes and clips the raw mail before this). */
export const inboundMailSchema = z.object({
  uid: z.number(),
  messageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  from: z.string(),
  fromName: z.string().nullable(),
  subject: z.string(),
  text: z.string(),
  automatic: z.boolean(),
});

/** A shared form's submission: the first value of each field, as URLSearchParams.get reads it (null when absent). */
export const formSubmissionSchema = z.object({
  /** When the page was shown, in milliseconds; coerced with `Number()` after parsing. */
  t: z.string().nullable(),
  /** The trap a person never fills in. */
  website: z.string().nullable(),
  /** `a0`, `a1`, … one per question. */
  answers: z.array(z.string().nullable()),
});

export type GithubIssue = z.infer<typeof githubIssueSchema>;
export type GithubRun = z.infer<typeof githubRunSchema>;
export type GithubEvent = z.infer<typeof githubEventSchema>;
export type LinearIssue = z.infer<typeof linearIssueSchema>;
export type LinearAnswer = z.infer<typeof linearAnswerSchema>;
export type LinearEvent = z.infer<typeof linearEventSchema>;
export type FormSubmission = z.infer<typeof formSubmissionSchema>;

// The mailbox's own type and this schema must not drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const mailMatchesSchema: Same<z.infer<typeof inboundMailSchema>, InboundMail> = true;
void mailMatchesSchema;

/** Every field a schema reads; none of these readers refuses (a field of the wrong type reads as missing). */
export const readGithubIssue = (raw: unknown): GithubIssue => githubIssueSchema.parse(raw);
export const readGithubRun = (raw: unknown): GithubRun => githubRunSchema.parse(raw);
export const readGithubIssueList = (raw: unknown) => githubIssueListSchema.parse(raw);
export const readGithubIssueEventList = (raw: unknown) => githubIssueEventListSchema.parse(raw);
export const readGithubRunList = (raw: unknown) => githubRunListSchema.parse(raw);
export const readGithubEvent = (raw: unknown): GithubEvent => githubEventSchema.parse(raw);
export const readLinearIssue = (raw: unknown): LinearIssue => linearIssueSchema.parse(raw);
export const readLinearAnswer = (raw: unknown): LinearAnswer => linearAnswerSchema.parse(raw);
export const readLinearEvent = (raw: unknown): LinearEvent => linearEventSchema.parse(raw);
export const readWebhookPayload = (raw: unknown): unknown => webhookPayloadSchema.parse(raw);

/** A Linear issue's label names, from either shape. */
export function linearLabelNames(issue: LinearIssue): string[] {
  const labels = issue.labels;
  return (Array.isArray(labels) ? labels : labels?.nodes ?? []).map(one => one.name ?? "");
}

/** A message from the mailbox reader. It is the mailbox's own type, so it always reads; one that somehow didn't is
 * used as it came, as before. */
export function readInboundMail(mail: InboundMail): InboundMail {
  const read = inboundMailSchema.safeParse(mail);
  return read.success ? read.data : mail;
}

/** A shared form's fields: the first value of each, and one answer per question (`a0` …). Strings always read. */
export function readFormSubmission(fields: URLSearchParams, questions: number): FormSubmission {
  return formSubmissionSchema.parse({
    t: fields.get("t"),
    website: fields.get("website"),
    answers: Array.from({ length: questions }, (_one, index) => fields.get(`a${index}`)),
  });
}
