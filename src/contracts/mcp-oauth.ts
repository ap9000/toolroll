/**
 * MCP sign-in (mcp-oauth.ts): what an MCP client may send when it registers itself (RFC 7591) and when it trades a
 * code or a refresh secret for tokens (RFC 6749 §4.1.3, §6, with PKCE, RFC 7636).
 *
 * A registration is read strictly for the fields Toolroll uses and ignores the rest (RFC 7591 §2: unknown metadata
 * is ignored). Only public clients register: no secret is issued, so `token_endpoint_auth_method` is `none` when
 * given. Whether a redirect is https, or http on 127.0.0.1 / [::1], is checked by mcp-oauth.ts after reading.
 */

import { z } from "zod";
import { parseContract, type ContractResult } from "./contract.js";

/** The most redirects one client registers, and how long each and the client's name may be. */
export const OAUTH_LIMITS = { redirects: 5, redirect: 512, name: 100 } as const;

export const OAUTH_GRANTS = ["authorization_code", "refresh_token"] as const;

export const oauthRegistrationSchema = z.object({
  redirect_uris: z.array(z.string().min(1).max(OAUTH_LIMITS.redirect)).min(1).max(OAUTH_LIMITS.redirects),
  client_name: z.string().max(OAUTH_LIMITS.name).optional(),
  token_endpoint_auth_method: z.literal("none").optional(),
  grant_types: z.array(z.enum(OAUTH_GRANTS)).min(1).max(2).optional(),
  response_types: z.array(z.literal("code")).min(1).max(1).optional(),
});

/** A PKCE verifier (RFC 7636 §4.1) and a S256 challenge (43 base64url characters). */
export const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
export const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

const bounded = z.string().min(1).max(2048);

/** A token request, by grant type. Every value is one form field. */
export const oauthTokenRequestSchema = z.discriminatedUnion("grant_type", [
  z.object({ grant_type: z.literal("authorization_code"), code: bounded, redirect_uri: bounded, client_id: bounded, code_verifier: z.string().regex(PKCE_VERIFIER), resource: bounded.optional() }),
  z.object({ grant_type: z.literal("refresh_token"), refresh_token: bounded, client_id: bounded, resource: bounded.optional(), scope: bounded.optional() }),
]);

export type OAuthRegistration = z.infer<typeof oauthRegistrationSchema>;
export type OAuthTokenRequest = z.infer<typeof oauthTokenRequestSchema>;

export const readOAuthRegistration = (input: unknown): ContractResult<OAuthRegistration> => parseContract(oauthRegistrationSchema, input);

/** A token request's form: a field given twice is refused (RFC 6749 §3.2); fields this grant doesn't take are ignored. */
export function readOAuthTokenRequest(form: URLSearchParams): ContractResult<OAuthTokenRequest> | { ok: false; repeated: true } {
  const fields: Record<string, string> = {};
  for (const [key, value] of form) {
    if (Object.hasOwn(fields, key)) return { ok: false, repeated: true };
    fields[key] = value;
  }
  return parseContract(oauthTokenRequestSchema, fields);
}
