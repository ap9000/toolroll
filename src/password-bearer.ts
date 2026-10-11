/**
 * D7: a password on each request (`Authorization: Bearer <name>:<password>`) is deprecated. This release still
 * accepts it everywhere it was accepted, with the same per-address tries, locks and budgets, but every answer carries
 * a deprecation warning, and every refusal of such a request names the replacement: an API token. From
 * PASSWORD_BEARER_REFUSED_FROM on, the server refuses it before checking the password.
 */
import type { ServerResponse } from "node:http";
import { PACKAGE_VERSION } from "./version.js";

/** The one replacement every machine-credential refusal names. */
export const TOKEN_REPLACEMENT = "Create an API token with `toolroll tokens create`";
/** The first release that refuses a password on a request; 0.9.58 deprecated it with a warning. */
export const PASSWORD_BEARER_REFUSED_FROM = "0.10.0";
export const PASSWORD_BEARER_WARNING = `Signing in with a password on each request is deprecated and stops working in Toolroll ${PASSWORD_BEARER_REFUSED_FROM}. ${TOKEN_REPLACEMENT} and send it as the bearer instead.`;
/** What the CLI says on stderr when a saved connection signs in with a password instead of an API token. */
export const PASSWORD_PROFILE_WARNING = `Warning: this connection signs in with your password on each request, which is deprecated and stops working in Toolroll ${PASSWORD_BEARER_REFUSED_FROM}. ${TOKEN_REPLACEMENT}, then connect again with --token-stdin.`;
export const PASSWORD_BEARER_REFUSED = `Toolroll no longer accepts a password on a request. ${TOKEN_REPLACEMENT} and send it as the bearer instead.`;

/** Whether an Authorization header is a password bearer: a name and a secret, never an API token. */
export function isPasswordBearer(authorization: string | undefined): boolean {
  return authorization !== undefined && /^Bearer (.+):(.+)$/.test(authorization) && !/^Bearer so_/.test(authorization);
}

const parts = (version: string): number[] => (/^(\d+)\.(\d+)\.(\d+)/.exec(version) ?? [0, 0, 0, 0]).slice(1).map(Number);
/** Whether this build still accepts a password bearer: only a release before PASSWORD_BEARER_REFUSED_FROM does. */
export function passwordBearerAccepted(version: string = PACKAGE_VERSION): boolean {
  const have = parts(version), limit = parts(PASSWORD_BEARER_REFUSED_FROM);
  for (let index = 0; index < 3; index++) if (have[index] !== limit[index]) return have[index]! < limit[index]!;
  return false;
}

/** A refusal's words for this request: unchanged, or with the replacement when it came with a password bearer. */
export function withReplacement(authorization: string | undefined, message: string): string {
  return !isPasswordBearer(authorization) || message.includes("toolroll tokens create") ? message : `${message} ${PASSWORD_BEARER_WARNING}`;
}

/**
 * The refusal boundary for one password-bearer request, whichever adapter answers it: the deprecation is announced in
 * headers (RFC 9745 Deprecation, and a Warning naming the replacement), and any refusal's words, plain text or a JSON
 * `message`, gain the replacement. Successful answers are left byte for byte.
 */
export function announcePasswordBearer(response: ServerResponse): void {
  response.setHeader("Deprecation", "true");
  response.setHeader("Warning", `299 toolroll "${PASSWORD_BEARER_WARNING.replace(/"/g, "'")}"`);
  const end = response.end.bind(response) as (...args: unknown[]) => ServerResponse;
  response.end = ((...args: unknown[]) => {
    const [chunk] = args;
    if (response.statusCode >= 400 && typeof chunk === "string" && !chunk.includes("toolroll tokens create")) args[0] = annotated(chunk);
    return end(...args);
  }) as ServerResponse["end"];
}

function annotated(body: string): string {
  if (/^\s*\{/.test(body)) {
    try {
      const value = JSON.parse(body) as unknown;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const row = value as Record<string, unknown>;
        if (typeof row["message"] === "string") return JSON.stringify({ ...row, message: `${row["message"]} ${PASSWORD_BEARER_WARNING}` });
        if (typeof row["error_description"] === "string") return JSON.stringify({ ...row, error_description: `${row["error_description"]} ${PASSWORD_BEARER_WARNING}` });
      }
    } catch { /* not JSON after all: plain text below */ }
    return body;
  }
  return body.trimStart().startsWith("<") ? body : `${body.replace(/\s+$/, "")}\n${PASSWORD_BEARER_WARNING}`;
}
