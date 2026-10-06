import { describe, expect, it } from "vitest";
import { validateToolSpec } from "../project-tools.js";
import { parseContract, toModelSchema } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import {
  authorizationServerSchema, protectedResourceSchema, readAuthorizationServer, readProtectedResource, readRegistration, readTokenResponse, readToolSpec,
  registrationResponseSchema, tokenResponseSchema, toolSpecSchema,
} from "./integration-metadata.js";

const reader = (schema: Parameters<typeof parseContract>[0]) => (input: unknown): SampleVerdict => {
  const read = parseContract(schema, input);
  return read.ok ? { ok: true } : { ok: false, lines: read.issues.map(issue => issue.line) };
};

const auth = "https://auth.example.test";

describe("a service's sign-in metadata", () => {
  it("holds for each schema: unknown keys are ignored, a wrong type is named by path", () => {
    assertContract({
      schema: protectedResourceSchema,
      read: reader(protectedResourceSchema),
      valid: [
        { name: "all of it", input: { resource: "https://mcp.example.test", authorization_servers: [auth], scopes_supported: ["user:read", "openid"] } },
        { name: "nothing", input: {} },
        { name: "keys it doesn't name", input: { bearer_methods_supported: ["header"], resource_name: "Example" } },
      ],
      invalid: [
        { name: "servers as one string", input: { authorization_servers: auth }, paths: ["authorization_servers"] },
        { name: "a malformed scope", input: { scopes_supported: ['bad"scope'] }, paths: ["scopes_supported[0]"] },
      ],
    });
    assertContract({
      schema: authorizationServerSchema,
      read: reader(authorizationServerSchema),
      valid: [
        { name: "endpoints and methods", input: { authorization_endpoint: `${auth}/a`, token_endpoint: `${auth}/t`, registration_endpoint: `${auth}/r`, code_challenge_methods_supported: ["S256"], issuer: auth } },
        { name: "no methods listed", input: { authorization_endpoint: `${auth}/a` } },
      ],
      invalid: [{ name: "an endpoint that isn't text", input: { token_endpoint: 7 }, paths: ["token_endpoint"] }],
    });
    assertContract({
      schema: registrationResponseSchema,
      read: reader(registrationResponseSchema),
      valid: [{ name: "a public client", input: { client_id: "c-1", client_id_issued_at: 1 } }, { name: "with a secret", input: { client_id: "c-1", client_secret: "s" } }],
      invalid: [{ name: "a numeric client", input: { client_id: 5 }, paths: ["client_id"] }],
    });
    assertContract({
      schema: tokenResponseSchema,
      read: reader(tokenResponseSchema),
      valid: [
        { name: "a code's tokens", input: { access_token: "a", refresh_token: "r", expires_in: 3600, scope: "user:read", token_type: "Bearer" } },
        { name: "an error", input: { error: "invalid_grant", error_description: "expired" } },
      ],
      invalid: [
        { name: "a lifetime of none", input: { access_token: "a", expires_in: 0 }, paths: ["expires_in"] },
        { name: "a scope that isn't text", input: { access_token: "a", scope: ["user:read"] }, paths: ["scope"] },
      ],
    });
  });

  it("reads a server's answer field by field, never refusing it", () => {
    expect(readProtectedResource({ resource: 5, authorization_servers: [7, "http://plain.example.test", auth], scopes_supported: ["user:read", 7, 'b"c', "x".repeat(129), "openid"], extra: {} }))
      .toEqual({ authorization_servers: ["http://plain.example.test", auth], scopes_supported: ["user:read", "openid"] });
    expect(readProtectedResource({ authorization_servers: auth, scopes_supported: null, resource: null })).toEqual({});
    expect(readAuthorizationServer({ authorization_endpoint: 7, token_endpoint: `${auth}/t`, registration_endpoint: null, code_challenge_methods_supported: "S256" })).toEqual({ token_endpoint: `${auth}/t` });
    expect(readAuthorizationServer({ code_challenge_methods_supported: [1, "plain"] })).toEqual({ code_challenge_methods_supported: ["plain"] });
  });

  it("reads registration answers as connecting always has", () => {
    expect(readRegistration({ client_id: "c", client_secret: null, extra: 1 })).toEqual({ client_id: "c" });
    expect(readRegistration({ client_id: 5 })).toEqual({});
    expect(readRegistration([1])).toEqual({});
    expect(readRegistration("text")).toEqual({});
    expect(readRegistration(null)).toBeNull();
  });

  it("keeps whether a token answer said a scope at all", () => {
    expect(readTokenResponse({ access_token: "a" })).toEqual({ access_token: "a", scopeSaid: false });
    expect(readTokenResponse({ access_token: "a", scope: null })).toEqual({ access_token: "a", scopeSaid: true });
    expect(readTokenResponse({ access_token: "a", scope: 7 })).toEqual({ access_token: "a", scopeSaid: true });
    expect(readTokenResponse({ access_token: "a", scope: "" })).toEqual({ access_token: "a", scope: "", scopeSaid: true });
    expect(readTokenResponse({ access_token: 5, refresh_token: 5, expires_in: "3600", error: 5 })).toEqual({ scopeSaid: false });
    expect(readTokenResponse({ access_token: "a", expires_in: -1 })).toEqual({ access_token: "a", scopeSaid: false });
    expect(readTokenResponse([1])).toEqual({ scopeSaid: false });
    expect(readTokenResponse(null)).toBeNull();
  });
});

describe("the project tool spec contract", () => {
  const stdio = validateToolSpec({ name: " Shop ", command: " node ", args: ["shop.js"], secrets: ["SHOP_KEY", { name: "SHOP_KEY" }, { name: "OPT", optional: true }], about: " The shop " });
  const http = validateToolSpec({ name: "web", transport: "http", url: "https://mcp.example.test/mcp", secrets: [{ name: "TOK", optional: false }, "HDR"], bearer: "TOK", headerSecrets: { "X-Key": "HDR" }, extra: true });

  it("holds: what the adapter makes is the schema, anything else is refused by path", () => {
    // JSON-Schema-exact, though no model is given it; Zod reads `headerSecrets`' record back from JSON Schema as a
    // preprocess, so the round trip is left to the schemas without a record.
    expect(toModelSchema(toolSpecSchema)).toMatchObject({ type: "object", additionalProperties: false });
    assertContract({
      read: input => { const read = readToolSpec(input); return read.ok ? { ok: true } : { ok: false, lines: read.issues.map(issue => issue.line) }; },
      valid: [{ name: "a local program", input: stdio }, { name: "a web address", input: http }],
      invalid: [
        { name: "an unknown key", input: { ...stdio, extra: 1 }, paths: ["payload"] },
        { name: "an unknown transport", input: { ...stdio, transport: "sse" }, paths: ["transport"] },
        { name: "a secret that isn't an env name", input: { ...stdio, secrets: [{ name: "key", optional: false }] }, paths: ["secrets[0].name"] },
        { name: "too many arguments", input: { ...stdio, args: Array(41).fill("a") }, paths: ["args"] },
      ],
    });
  });

  it("keeps the adapter's defaults, trimming and shorthand", () => {
    expect(stdio).toEqual({ name: "shop", transport: "stdio", command: "node", args: ["shop.js"], url: null, secrets: [{ name: "SHOP_KEY", optional: false }, { name: "OPT", optional: true }], bearer: null, headerSecrets: {}, about: "The shop" });
    expect(http).toEqual({ name: "web", transport: "http", command: null, args: [], url: "https://mcp.example.test/mcp", secrets: [{ name: "TOK", optional: false }, { name: "HDR", optional: false }], bearer: "TOK", headerSecrets: { "X-Key": "HDR" }, about: "Tools from mcp.example.test." });
    // A long host makes a long `about`; it was always kept.
    const host = `${"h".repeat(60)}.${"h".repeat(60)}.${"h".repeat(60)}.${"h".repeat(60)}.example`;
    expect(validateToolSpec({ name: "long", transport: "http", url: `https://${host}/` }).about).toBe(`Tools from ${host}.`);
    expect(validateToolSpec({ name: "x", command: "c", about: "a".repeat(300) }).about).toHaveLength(240);
    expect(validateToolSpec({ name: "x", command: "c", bearer: 5, headerSecrets: "ignored", url: 7 })).toMatchObject({ bearer: null, headerSecrets: {}, url: null });
  });

  it("refuses bad specs in the same plain words", () => {
    expect(() => validateToolSpec({ name: 7, command: "c" })).toThrow("A short name is required, up to 40 characters.");
    expect(() => validateToolSpec({ name: "x", command: "c", secrets: Array.from({ length: 13 }, (_, i) => `S${i}`) })).toThrow("A tool can name up to 12 secrets.");
    expect(() => validateToolSpec({ name: "x", command: "c", args: Array(41).fill("a") })).toThrow("Arguments are up to 40 plain words.");
    expect(() => validateToolSpec({ name: "x", command: "c", secrets: ["PATH"] })).toThrow("PATH is reserved; choose another secret name.");
    expect(() => validateToolSpec({ name: "x", transport: "sse", command: "c" })).toThrow("A tool runs as a local program or at a web address.");
    expect(() => validateToolSpec({ name: "x", transport: "http", url: "http://plain.example.test/" })).toThrow("A web tool needs an https address.");
  });
});
