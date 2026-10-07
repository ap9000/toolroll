import { expect, test } from "vitest";
import { carriesToken, hstsFor, isLoopbackAddress, isLoopbackPeer, isTailnetAddress, plainHttpRefusal, transportOf, USE_HTTPS } from "./public-access.js";

test("classifies loopback and tailnet addresses, mapped and bracketed forms included", () => {
  for (const one of ["127.0.0.1", "127.8.9.10", "::1", "[::1]", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(one), one).toBe(true);
  for (const one of ["128.0.0.1", "10.0.0.1", "::2", "", "localhost", "127.0.0.256"]) expect(isLoopbackAddress(one), one).toBe(false);
  for (const one of ["100.64.0.1", "100.127.255.254", "::ffff:100.100.1.1", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:ab12::5%utun3"]) expect(isTailnetAddress(one), one).toBe(true);
  for (const one of ["100.63.255.255", "100.128.0.1", "fd7a:115c:a1e1::1", "192.168.1.5", "127.0.0.1"]) expect(isTailnetAddress(one), one).toBe(false);
});

test("believes forwarded headers only from a loopback peer, and only the last hop", () => {
  const relayed = (joinSource: string, proto?: string, forwarded?: string) => transportOf({ peer: "127.0.0.1", joinSource, forwardedProto: proto, forwarded });
  expect(transportOf({ peer: "198.51.100.7", joinSource: "198.51.100.7", forwardedProto: "https", forwarded: undefined })).toEqual({ source: "198.51.100.7", https: false, privatePath: false });
  expect(relayed("fwd:203.0.113.10", "http, https")).toEqual({ source: "203.0.113.10", https: true, privatePath: false });
  expect(relayed("fwd:203.0.113.10", "https, http").https).toBe(false);
  expect(relayed("fwd:100.70.0.2").privatePath).toBe(true);
  expect(relayed("127.0.0.1").privatePath).toBe(true);
  expect(relayed("127.0.0.1", undefined, "for=203.0.113.10").privatePath).toBe(false);
});

test("trusts only the exact loopback peers joinSourceOf trusts, not all of 127/8", () => {
  for (const one of ["127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"]) expect(isLoopbackPeer(one), one).toBe(true);
  for (const one of ["127.0.0.2", "127.8.9.10", "::ffff:127.0.0.2", "0:0:0:0:0:0:0:1", ""]) expect(isLoopbackPeer(one), one).toBe(false);
  // A proxy on 127.0.0.2 relaying a public caller: serve.ts's joinSourceOf leaves its peer as the source, and so must this.
  expect(transportOf({ peer: "127.0.0.2", joinSource: "127.0.0.2", forwardedProto: "https", forwarded: undefined })).toEqual({ source: "127.0.0.2", https: false, privatePath: false });
  expect(plainHttpRefusal(transportOf({ peer: "127.0.0.2", joinSource: "127.0.0.2", forwardedProto: undefined, forwarded: undefined }), "/mcp", undefined)).toBe(USE_HTTPS);
  // A trusted proxy cannot launder a forwarded 127/8 hop into this computer either.
  expect(transportOf({ peer: "127.0.0.1", joinSource: "fwd:127.0.0.2", forwardedProto: undefined, forwarded: undefined }).privatePath).toBe(false);
});

test("refuses only token-bearing requests that are neither HTTPS nor private; HSTS only for the public host over HTTPS", () => {
  const remote = { source: "203.0.113.10", https: false, privatePath: false };
  expect(carriesToken("/api/cli", undefined)).toBe(true);
  expect(carriesToken("/mcp", undefined)).toBe(true);
  expect(carriesToken("/api/team", "bearer so_x_y")).toBe(true);
  expect(carriesToken("/login", undefined)).toBe(false);
  // MCP sign-in hands out tokens with no Authorization header at all; its discovery documents stay public.
  for (const path of ["/oauth/authorize", "/oauth/token", "/oauth/register", "/oauth/revoke", "/oauth/token/"]) {
    expect(carriesToken(path, undefined)).toBe(true);
    expect(plainHttpRefusal(remote, path, undefined)).toBe(USE_HTTPS);
    expect(plainHttpRefusal({ ...remote, https: true }, path, undefined)).toBeNull();
    expect(plainHttpRefusal({ ...remote, privatePath: true }, path, undefined)).toBeNull();
  }
  expect(carriesToken("/.well-known/oauth-authorization-server", undefined)).toBe(false);
  expect(carriesToken("/.well-known/oauth-protected-resource/mcp", undefined)).toBe(false);
  expect(plainHttpRefusal(remote, "/mcp", undefined)).toBe(USE_HTTPS);
  expect(plainHttpRefusal(remote, "/login", undefined)).toBeNull();
  expect(plainHttpRefusal({ ...remote, https: true }, "/mcp", undefined)).toBeNull();
  expect(plainHttpRefusal({ ...remote, privatePath: true }, "/mcp", undefined)).toBeNull();
  expect(hstsFor("a.example", "a.example", { ...remote, https: true })).toBe("max-age=31536000");
  expect(hstsFor("a.example", "b.example", { ...remote, https: true })).toBeNull();
  expect(hstsFor("a.example", "a.example", remote)).toBeNull();
  expect(hstsFor(null, "a.example", { ...remote, https: true })).toBeNull();
});
