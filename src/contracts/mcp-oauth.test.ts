import { describe, expect, test } from "vitest";
import { readOAuthRegistration, readOAuthTokenRequest } from "./mcp-oauth.js";

describe("MCP sign-in contracts", () => {
  test("a registration keeps the fields Toolroll uses, ignores others, and is public-client only", () => {
    expect(readOAuthRegistration({ redirect_uris: ["https://a.example/cb"], client_name: "Agent", logo_uri: "https://a.example/logo.png" }))
      .toEqual({ ok: true, value: { redirect_uris: ["https://a.example/cb"], client_name: "Agent" } });
    for (const bad of [{}, { redirect_uris: [] }, { redirect_uris: "https://a.example/cb" }, { redirect_uris: ["x"], token_endpoint_auth_method: "client_secret_post" },
      { redirect_uris: ["x"], grant_types: ["client_credentials"] }, { redirect_uris: ["x"], response_types: ["token"] }, { redirect_uris: Array(6).fill("x") }, null]) {
      expect(readOAuthRegistration(bad).ok).toBe(false);
    }
  });

  test("a token request is one of the two grants, PKCE-shaped, with no field given twice", () => {
    const verifier = "v".repeat(43);
    expect(readOAuthTokenRequest(new URLSearchParams({ grant_type: "authorization_code", code: "c", redirect_uri: "r", client_id: "i", code_verifier: verifier })).ok).toBe(true);
    expect(readOAuthTokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: "r", client_id: "i" })).ok).toBe(true);
    expect(readOAuthTokenRequest(new URLSearchParams({ grant_type: "authorization_code", code: "c", redirect_uri: "r", client_id: "i", code_verifier: "short" })).ok).toBe(false);
    expect(readOAuthTokenRequest(new URLSearchParams({ grant_type: "authorization_code", code: "c", redirect_uri: "r", client_id: "i" })).ok).toBe(false);
    expect(readOAuthTokenRequest(new URLSearchParams({ grant_type: "password", username: "u", password: "p" })).ok).toBe(false);
    expect(readOAuthTokenRequest(new URLSearchParams([["grant_type", "refresh_token"], ["refresh_token", "a"], ["refresh_token", "b"], ["client_id", "i"]]))).toEqual({ ok: false, repeated: true });
  });
});
