/**
 * Integration metadata (mcp-connect.ts, project-tools.ts): one schema each for what a service's sign-in says about
 * itself — its protected-resource metadata, its authorization server's metadata, its answer to registering Toolroll,
 * and its token answers — and for a project tool's spec.
 *
 * A server's answers are external, so they are read field by field and never strictly: an unknown key is ignored, a
 * field of the wrong type reads as absent, and a list keeps the items of the right type (`scopes_supported` keeps the
 * well-formed scope tokens). What JSON Schema doesn't say — https or loopback addresses, S256, how much scope fits a
 * sign-in address, when a token expires — is checked by mcp-connect.ts after reading, as before.
 *
 * A tool spec is what `validateToolSpec` makes of a tool from any source (the catalog, the console, the lead, an
 * import, a saved `project_tool` row). Saved specs were never versioned and every one is read by that adapter, which
 * keeps its defaults, trimming, string-secret shorthand and plain-word refusals; the spec it returns is this schema.
 */

import { z } from "zod";
import { parseContract, type ContractResult } from "./contract.js";

/** RFC 6749 scope tokens. */
export const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A field's schema without its optional wrapper. */
const inner = (field: z.ZodType): z.ZodType => (field instanceof z.ZodOptional ? (field.unwrap() as z.ZodType) : field);

/**
 * An external object read by `schema`, field by field: an absent or wrong-typed field is left out, a list keeps the
 * items its schema takes, and keys the schema doesn't name are ignored.
 */
function fieldsOf<S extends z.ZodRawShape>(schema: z.ZodObject<S>, input: Record<string, unknown>): z.infer<z.ZodObject<S>> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape) as [string, z.ZodType][]) {
    const value = input[key];
    if (value === undefined) continue;
    const of = inner(field);
    if (of instanceof z.ZodArray && Array.isArray(value)) out[key] = value.filter(item => (of.element as z.ZodType).safeParse(item).success);
    else if (field.safeParse(value).success) out[key] = value;
  }
  return out as z.infer<z.ZodObject<S>>;
}

// ---- a service's sign-in (OAuth) -------------------------------------------------------------------------------

/** RFC 9728 protected-resource metadata: the resource a token is for, who signs in for it, and the scopes it lists. */
export const protectedResourceSchema = z.object({
  resource: z.string().optional(),
  authorization_servers: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string().regex(SCOPE_TOKEN)).optional(),
});

/** RFC 8414 (or OpenID) authorization-server metadata: where to sign in, trade a code, and register. */
export const authorizationServerSchema = z.object({
  authorization_endpoint: z.string().optional(),
  token_endpoint: z.string().optional(),
  registration_endpoint: z.string().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});

/** RFC 7591 registration answer: the client Toolroll is, and its secret when the server gives one. */
export const registrationResponseSchema = z.object({
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
});

/** RFC 6749 §5.1/§5.2 token answer, for a code or a refresh: the tokens, how long they last, the scope granted, or the error. */
export const tokenResponseSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
});

export type ProtectedResource = z.infer<typeof protectedResourceSchema>;
export type AuthorizationServer = z.infer<typeof authorizationServerSchema>;
export type RegistrationResponse = z.infer<typeof registrationResponseSchema>;
/** `scopeSaid`: the answer has a `scope` key at all. Absent, an initial grant is what was asked for and a refresh
 * keeps the grant it had; present but not scope text, the grant is unknown. */
export type TokenResponse = z.infer<typeof tokenResponseSchema> & { scopeSaid: boolean };

export const readProtectedResource = (body: Record<string, unknown>): ProtectedResource => fieldsOf(protectedResourceSchema, body);
export const readAuthorizationServer = (body: Record<string, unknown>): AuthorizationServer => fieldsOf(authorizationServerSchema, body);

/** A registration answer's JSON; null when the server answered `null`, which has always read as no answer. Any other
 * non-object (a list, a string) carries no client. */
export const readRegistration = (body: unknown): RegistrationResponse | null =>
  body === null ? null : isRecord(body) ? fieldsOf(registrationResponseSchema, body) : {};

/** A token answer's JSON; null when the server answered `null` (no answer), as for a registration. */
export const readTokenResponse = (body: unknown): TokenResponse | null =>
  body === null ? null : isRecord(body) ? { ...fieldsOf(tokenResponseSchema, body), scopeSaid: "scope" in body } : { scopeSaid: false };

// ---- a project's tool -----------------------------------------------------------------------------------------

export const TOOL_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** How long a tool's settings may be, and how many arguments and secrets it names. `about` is clipped to its limit
 * when given; the one made for a tool without one names its host or program, however long. */
export const TOOL_SPEC_LIMITS = { name: 40, command: 400, arg: 400, args: 40, url: 500, about: 240, secrets: 12 } as const;

/** One secret a tool needs: an env name for a local server, or the value behind an http header. */
export const toolSecretSchema = z.strictObject({ name: z.string().regex(SECRET_NAME), optional: z.boolean() });

export const toolSpecSchema = z.strictObject({
  name: z.string().regex(TOOL_NAME),
  transport: z.enum(["stdio", "http"]),
  /** stdio: the program and its arguments (no secrets in either). */
  command: z.string().max(TOOL_SPEC_LIMITS.command).nullable(),
  args: z.array(z.string().max(TOOL_SPEC_LIMITS.arg)).max(TOOL_SPEC_LIMITS.args),
  /** http: the server's address. */
  url: z.string().max(TOOL_SPEC_LIMITS.url).nullable(),
  /** Every secret the tool needs. stdio: each is an env variable of the server process. */
  secrets: z.array(toolSecretSchema).max(TOOL_SPEC_LIMITS.secrets),
  /** http: the secret sent as `Authorization: Bearer <value>`. */
  bearer: z.string().regex(SECRET_NAME).nullable(),
  /** http: header name (HEADER_NAME, checked by the adapter: a key pattern has no exact JSON Schema) → the secret sent as its raw value. */
  headerSecrets: z.record(z.string(), z.string().regex(SECRET_NAME)),
  /** What it does, in plain words. */
  about: z.string(),
});

export type ToolSecret = z.infer<typeof toolSecretSchema>;
export type ToolSpec = z.infer<typeof toolSpecSchema>;

/** A spec as the tool adapter made it, checked against the schema (path-named lines when it isn't one). */
export const readToolSpec = (input: unknown): ContractResult<ToolSpec> => parseContract(toolSpecSchema, input);
