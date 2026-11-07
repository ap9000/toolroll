/** Where a read of a recorded remote connects: every refusal and every pin (docs/plans/code-map.md §1). */
import { describe, expect, test } from "vitest";
import { addressRefused, destinationOf, noProxyApplies, pinDestination, type Lookup } from "./remote-destination.js";

const OK = "93.184.216.34";
const lookup = (table: Record<string, readonly string[]>): Lookup => async host => { const found = table[host]; if (found === undefined) throw new Error("no such host"); return found; };
const named = lookup({ "git.example": [OK], "proxy.example": ["203.0.113.9"], "evil.example": [OK, "127.0.0.1"], "local.example": ["127.0.0.1"], "meta.example": ["169.254.169.254"], "v6.example": ["2001:db8::1"] });

describe("addresses", () => {
  test.each([["127.0.0.1"], ["127.8.8.8"], ["0.0.0.0"], ["169.254.169.254"], ["::1"], ["::"], ["fe80::1"], ["febf::1"], ["::ffff:127.0.0.1"], ["::ffff:7f00:1"], ["::ffff:169.254.1.1"], ["64:ff9b::7f00:1"], ["64:ff9b::a9fe:a9fe"], ["::127.0.0.1"], ["not-an-address"]])("%s is refused", address => {
    expect(addressRefused(address)).toBe(true);
  });
  test.each([[OK], ["10.1.2.3"], ["192.168.1.1"], ["2001:db8::1"], ["::ffff:93.184.216.34"], ["64:ff9b::5db8:d822"]])("%s is allowed", address => {
    expect(addressRefused(address)).toBe(false);
  });
});

describe("the destination", () => {
  test.each([
    ["https://git.example/a.git", { scheme: "https", host: "git.example", port: 443, literal: false }],
    ["https://git.example:8443/a.git", { scheme: "https", host: "git.example", port: 8443, literal: false }],
    ["ssh://git@git.example:2222/a.git", { scheme: "ssh", host: "git.example", port: 2222, literal: false }],
    ["git@git.example:a/b.git", { scheme: "ssh", host: "git.example", port: 22, literal: false }],
    ["https://[2001:db8::1]/a.git", { scheme: "https", host: "2001:db8::1", port: 443, literal: true }],
    ["https://0x5d.0xb8.0xd8.0x22/a.git", { scheme: "https", host: OK, port: 443, literal: true }],
  ])("%s", (url, want) => { expect(destinationOf(url)).toEqual(want); });
});

describe("the pin", () => {
  test("https at the URL's own port", async () => {
    expect(await pinDestination("https://git.example:8443/a.git", {}, named)).toEqual({ ok: true, pin: { gitArgs: ["-c", `http.curloptResolve=git.example:8443:${OK}`], env: {}, proxy: null } });
  });
  test("a bracketed IPv6 address in the pin", async () => {
    const pinned = await pinDestination("https://v6.example/a.git", {}, named);
    expect(pinned).toMatchObject({ ok: true, pin: { gitArgs: ["-c", "http.curloptResolve=v6.example:443:[2001:db8::1]"] } });
  });
  test("literal hosts are checked and pinned as written, never looked up", async () => {
    const never: Lookup = async () => { throw new Error("looked up"); };
    expect(await pinDestination(`https://${OK}/a.git`, {}, never)).toMatchObject({ ok: true, pin: { gitArgs: ["-c", `http.curloptResolve=${OK}:443:${OK}`] } });
    expect(await pinDestination("https://[2001:db8::1]:444/a.git", {}, never)).toMatchObject({ ok: true, pin: { gitArgs: ["-c", "http.curloptResolve=2001:db8::1:444:[2001:db8::1]"] } });
    expect((await pinDestination("https://[fe80::1]/a.git", {}, never)).ok).toBe(false);
  });
  test.each([["https://local.example/a.git"], ["https://meta.example/a.git"], ["git@local.example:a.git"]])("attack: %s resolves to a refused address", async url => {
    expect(await pinDestination(url, {}, named)).toMatchObject({ ok: false, why: expect.stringContaining("isn't one Toolroll connects to") });
  });
  test("attack: one bad answer among good ones refuses the name", async () => {
    expect((await pinDestination("https://evil.example/a.git", {}, named)).ok).toBe(false);
  });
  test("a name that won't resolve is refused, not read unpinned", async () => {
    expect(await pinDestination("https://missing.example/a.git", {}, named)).toMatchObject({ ok: false, why: expect.stringContaining("couldn't be resolved") });
  });
  test("ssh pins through its own command, with no proxy of any kind", async () => {
    const pinned = await pinDestination("ssh://git@git.example:2222/a.git", { HTTPS_PROXY: "http://proxy.example:3128" }, named);
    if (!pinned.ok) throw new Error(pinned.why);
    expect(pinned.pin.gitArgs).toEqual([]);
    expect(pinned.pin.proxy).toBeNull();
    expect(pinned.pin.env["GIT_SSH_COMMAND"]).toBe(`ssh -o BatchMode=yes -o ProxyCommand=none -o ProxyJump=none -o HostName=${OK} -o Port=2222 -o HostKeyAlias=git.example -o CheckHostIP=no`);
  });
});

describe("proxies", () => {
  test("a host in NO_PROXY is direct and pinned", async () => {
    expect(await pinDestination("https://git.example/a.git", { HTTPS_PROXY: "http://proxy.example:3128", NO_PROXY: "example" }, named)).toMatchObject({ ok: true, pin: { gitArgs: ["-c", `http.curloptResolve=git.example:443:${OK}`], proxy: null } });
  });
  test("through a proxy, its own host is pinned and the page can say so", async () => {
    expect(await pinDestination("https://git.example/a.git", { https_proxy: "http://proxy.example:3128" }, named)).toEqual({ ok: true, pin: { gitArgs: ["-c", "http.curloptResolve=proxy.example:3128:203.0.113.9"], env: {}, proxy: "proxy.example" } });
  });
  test("the lower-case name wins, as curl has it", async () => {
    expect(await pinDestination("https://git.example/a.git", { https_proxy: "http://proxy.example:3128", HTTPS_PROXY: "http://local.example:1" }, named)).toMatchObject({ ok: true });
  });
  test("attack: a proxy that resolves to a refused address is refused", async () => {
    expect((await pinDestination("https://git.example/a.git", { HTTPS_PROXY: "http://local.example:3128" }, named)).ok).toBe(false);
  });
  test.each([["socks5://proxy.example:1080", undefined], ["http://proxy.example:3128", "git.example:443"], ["http://proxy.example:3128", "*.example/odd"]])("routing it can't decide (%s, %s) refuses", async (proxy, no) => {
    const env = { HTTPS_PROXY: proxy, ...(no === undefined ? {} : { NO_PROXY: no }) };
    expect(await pinDestination("https://git.example/a.git", env, named)).toMatchObject({ ok: false, why: expect.stringContaining("can't tell how this connection would be routed") });
  });
  test.each([["*", "x.example", true], [".example", "x.example", true], ["example", "example", true], ["ample", "example", false], ["10.0.0.0/8", "10.2.3.4", true], ["10.0.0.0/8", "11.2.3.4", false], ["10.0.0.0/8", "git.example", false], ["a.example, b.example", "b.example", true]])("NO_PROXY %s against %s", (list, host, want) => {
    expect(noProxyApplies(list, host)).toBe(want);
  });
});
