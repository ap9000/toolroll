/** Separate remote-terminal metadata contract; does not change the local engine contract/digest. */
import { z } from "zod";
import { RECOVERY_GENERATION_PATTERN, WORKSPACE_ID_PATTERN } from "../workspace-identity-schema.js";

export const TERMINAL_CONNECTION_PROTOCOL = 1 as const;
/** Finite remote TUI commands routed through `POST /api/cli` (each verified `"yes"` in `operate-remote.ts`). */
export const REMOTE_TUI_COMMANDS = [
  "task add",
  "task steer",
  "task complete",
  "task revise",
  "task assign",
  "task stop",
  "task resume",
  "task hold",
  "task unhold",
  "task requeue",
] as const;
export type RemoteTuiCommand = (typeof REMOTE_TUI_COMMANDS)[number];

const printable = z.string().refine(value => [...value].length >= 1 && [...value].length <= 200
  && !/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff\ud800-\udfff]/u.test(value));
const canonicalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
export const terminalConnectionSchema = z.strictObject({
  protocol: z.literal(TERMINAL_CONNECTION_PROTOCOL),
  workspace: z.strictObject({ id: z.string().regex(WORKSPACE_ID_PATTERN), recoveryGeneration: z.string().regex(RECOVERY_GENERATION_PATTERN), label: printable }),
  principal: z.strictObject({ account: printable, role: z.enum(["viewer", "approver"]), access: z.enum(["read", "act"]), expiresAt: canonicalDate }),
  engine: z.strictObject({ version: z.literal(1), contract: z.string().regex(/^[0-9a-f]{64}$/) }),
  capabilities: z.strictObject({
    workRows: z.boolean(), stepCards: z.boolean(), resultDiff: z.boolean(), runLiveWindow: z.boolean(),
    leadChat: z.boolean(), liveStream: z.boolean(),
    commands: z.array(z.enum(REMOTE_TUI_COMMANDS)), approval: z.literal("browser"),
    providerSetup: z.literal(false), localCode: z.boolean(), localExecution: z.literal(false), interactive: z.literal(false),
  }),
});
export type TerminalConnection = z.infer<typeof terminalConnectionSchema>;
export const TERMINAL_CONNECTION_ERRORS = [
  "request",
  "unauthenticated",
  "credential-purpose",
  "workspace-mismatch",
  "recovery-changed",
  "workspace-unavailable",
  "contract-unavailable",
] as const;
export type TerminalConnectionError = (typeof TERMINAL_CONNECTION_ERRORS)[number];
export const terminalConnectionRefusalSchema = z.strictObject({
  protocol: z.literal(TERMINAL_CONNECTION_PROTOCOL),
  error: z.enum(TERMINAL_CONNECTION_ERRORS),
});
export const DISABLED_TERMINAL_CAPABILITIES: TerminalConnection["capabilities"] = Object.freeze({
  workRows: false, stepCards: false, resultDiff: false, runLiveWindow: false,
  leadChat: false, liveStream: false,
  commands: [] as RemoteTuiCommand[], approval: "browser",
  providerSetup: false, localCode: false, localExecution: false, interactive: false,
});
