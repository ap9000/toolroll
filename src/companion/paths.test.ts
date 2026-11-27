/** The rules for the ways a phone reaches the Mac (paths.ts) and who may talk to the direct listener at all. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { directPeerAllowed } from "./direct-server.js";
import { buildPaths, lanAddressesOf, pathAllowed, pathsAllowed } from "./paths.js";
import { tailnetIpv4Of } from "../tailnet.js";

describe("paths", () => {
  test("direct addresses first (LAN, then Tailscale), the relay last; public or odd addresses never listed", () => {
    expect(buildPaths({ port: 4199, lan: ["192.168.1.20", "8.8.8.8", "192.168.1.20"], tailnet: "100.101.102.103", hosted: "wss://relay.example.test/v1/connect" })).toEqual([
      { kind: "direct", url: "ws://192.168.1.20:4199/v1/direct" },
      { kind: "direct", url: "ws://100.101.102.103:4199/v1/direct" },
      { kind: "hosted", url: "wss://relay.example.test/v1/connect" },
    ]);
    expect(buildPaths({ port: null, lan: ["10.0.0.2"], tailnet: null, hosted: null })).toEqual([]);
  });

  test.each([
    [[{ kind: "direct", url: "ws://10.1.2.3:4199/v1/direct" }], true],
    [[{ kind: "direct", url: "ws://172.20.0.4:4199/v1/direct" }, { kind: "hosted", url: "wss://r.example.test/v1/connect" }], true],
    [[], false],
    [[{ kind: "direct", url: "ws://8.8.8.8:4199/v1/direct" }], false], // public address
    [[{ kind: "direct", url: "ws://mac.tail1234.ts.net:4199/v1/direct" }], false], // a name, not an IP literal
    [[{ kind: "direct", url: "ws://10.1.2.3/v1/direct" }], false], // no port
    [[{ kind: "direct", url: "ws://10.1.2.3:4199/v1/direct?x=1" }], false],
    [[{ kind: "hosted", url: "ws://r.example.test/v1/connect" }], false], // plain ws off this computer
    [[{ kind: "hosted", url: "wss://r.example.test/v1/connect" }, { kind: "direct", url: "ws://10.1.2.3:4199/v1/direct" }], false], // hosted not last
    [[1, 2, 3, 4, 5].map(n => ({ kind: "direct", url: `ws://10.0.0.${n}:4199/v1/direct` })), false], // more than 4 direct
    [[{ kind: "direct", url: "ws://10.1.2.3:4199/v1/direct" }, { kind: "direct", url: "ws://10.1.2.3:4199/v1/direct" }], false], // duplicate
  ] as const)("pathsAllowed(%j) is %s", (paths, ok) => {
    expect(pathsAllowed(paths as never)).toBe(ok);
  });

  test("LAN addresses: up, private IPv4, Wi-Fi/Ethernet first, at most three", () => {
    const v4 = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null });
    expect(lanAddressesOf({
      lo0: [v4("127.0.0.1", true)], bridge100: [v4("192.168.64.1")], en0: [v4("192.168.1.20")], utun4: [v4("100.101.102.103")],
      en5: [v4("10.0.0.7")], awdl0: [v4("169.254.3.3")], vmnet: [v4("172.16.5.1")],
    })).toEqual(["192.168.1.20", "10.0.0.7", "192.168.64.1"]);
  });

  test("this Mac's Tailscale IPv4 from `tailscale status --json`", () => {
    expect(tailnetIpv4Of(JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["fd7a:115c:a1e0::1", "100.101.102.103"] } }))).toBe("100.101.102.103");
    expect(tailnetIpv4Of(JSON.stringify({ BackendState: "Stopped", Self: { TailscaleIPs: ["100.101.102.103"] } }))).toBeNull();
    expect(tailnetIpv4Of("not json")).toBeNull();
  });
});

test.each([
  ["127.0.0.1", true], ["::1", true], ["::ffff:192.168.1.9", true], ["10.9.8.7", true], ["172.31.0.1", true], ["172.32.0.1", false],
  ["169.254.10.1", false], ["100.64.0.1", true], ["100.128.0.1", false], ["fe80::1", true], ["fd7a:115c:a1e0::5", true],
  ["fd00::1", false], ["203.0.113.9", false], ["2001:db8::1", false], ["::ffff:8.8.8.8", false], [undefined, false],
] as const)("directPeerAllowed(%s) is %s", (address, ok) => {
  expect(directPeerAllowed(address)).toBe(ok);
});

describe("the shared rule table (the phone runs the same one)", () => {
  const table = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "test", "fixtures", "companion-paths.json"), "utf8")) as {
    single: { path: { kind: string; url: string }; ok: boolean }[];
    lists: { paths: { kind: string; url: string }[]; ok: boolean }[];
  };
  test.each(table.single.map(row => [row.path.kind, row.path.url, row.ok] as const))("%s %s → %s", (kind, url, ok) => {
    expect(pathAllowed({ kind, url } as never)).toBe(ok);
  });
  test.each(table.lists.map((row, i) => [i, row.paths, row.ok] as const))("list %i → %s", (_i, paths, ok) => {
    expect(pathsAllowed(paths as never)).toBe(ok);
  });
});
