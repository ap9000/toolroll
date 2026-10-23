/** The Linux fence's arguments for a workspace build (agent-fence.ts linuxFenced): what /tmp gives back is read-only,
 * the allowlist is bound writable after it, and the host's own services are masked whatever the network. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { grantFolder, linuxFenced, linuxHostSockets, macosFenceAvailable, macosFenceProfile, NO_GRANTS, type FenceGrants } from "./agent-fence.js";
import { shortTempDir } from "../test/short-temp.js";
import { INSIDE_FENCE } from "../test/inside-fence.js";

test("a workspace build's private /tmp gives its kept paths back read-only, then its allowlist writable", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-fence-args-")));
  try {
    const git = join(dir, "repo", ".git"), objects = join(git, "objects");
    mkdirSync(objects, { recursive: true });
    const grants: FenceGrants = { ...NO_GRANTS, writes: { subpaths: [objects], prefixes: [] },
      network: { mode: "allowlist", proxyPort: 1, brokerPorts: [], loopback: "proxy-only", socketRoots: [], keep: [git], bridge: { folder: dir, forwarder: dir, node: "node" } } };
    const { args } = linuxFenced("true", [], [], grants);
    const at = (flag: string, path: string) => args.findIndex((one, index) => one === flag && args[index + 1] === path && args[index + 2] === path);
    if (git.startsWith("/tmp/")) {
      expect(at("--bind", git)).toBe(-1);
      expect(at("--ro-bind", git)).toBeGreaterThan(-1);
      expect(at("--bind", objects)).toBeGreaterThan(at("--ro-bind", git));
    }
    expect(args.slice(0, 5)).toEqual(["--ro-bind", "/", "/", "--dev", "/dev"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a workspace build with an open network still has the host's own sockets masked", () => {
  const sockets = linuxHostSockets();
  const { args } = linuxFenced("true", [], [], { ...NO_GRANTS, writes: { subpaths: [homedir()], prefixes: [] }, network: { mode: "open" } });
  for (const path of sockets) expect(args.join("\0")).toContain(path);
  const anywhere = linuxFenced("true", [], [], { ...NO_GRANTS, network: { mode: "open" } }).args;
  expect(anywhere.slice(0, 3)).toEqual(["--dev-bind", "/", "/"]);
});

test("a grant is never made through a link of this user's, at the folder or anywhere above it", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-grant-")));
  try {
    const target = join(dir, "LaunchAgents");
    mkdirSync(target);
    symlinkSync(target, join(dir, "linked"));
    expect(grantFolder(join(dir, "linked"))).toBeNull();
    expect(grantFolder(join(dir, "linked", "cache"))).toBeNull();
    expect(grantFolder(join(dir, "real", "cache"))).toBe(join(dir, "real", "cache"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a workspace build masks an engine the operator moved (a link in home) and one the environment names", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-engines-")));
  try {
    const home = join(dir, "home"), moved = join(dir, "elsewhere", "docker"), named = join(dir, "custom.sock");
    mkdirSync(home); mkdirSync(moved, { recursive: true }); mkdirSync(named);
    symlinkSync(moved, join(home, ".docker"));
    const env = { DOCKER_HOST: `unix://${named}`, SSH_AUTH_SOCK: named };
    expect(linuxHostSockets(501, home, "/tmp", true, env)).toEqual(expect.arrayContaining([moved, named]));
    expect(linuxHostSockets(501, home, "/tmp", false, env)).not.toEqual(expect.arrayContaining([moved]));
    expect(linuxHostSockets(501, home, "/tmp", false, env)).toEqual(expect.arrayContaining([named]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Inside the plane's macOS check fence every folder a check may write is too deep for this test's unix socket path (about 104 bytes); CI (Linux, and the tag's macOS jobs) runs it unfenced.
test.skipIf(INSIDE_FENCE)("a workspace build sharing /tmp has every socket there masked, with the folder that holds it", async () => {
  const { createServer } = await import("node:net");
  // Under /tmp, not the system temp folder: a unix socket's path must fit 104 bytes on macOS, and a runner's temp
  // folder (/private/var/folders/…/T/) leaves too little room for tmux-501/default.
  const tmp = shortTempDir("so-tmpsockets-");
  const servers: import("node:net").Server[] = [];
  try {
    mkdirSync(join(tmp, "tmux-501"));
    for (const path of [join(tmp, "top.sock"), join(tmp, "tmux-501", "default")]) {
      const server = createServer();
      await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(path, done); });
      servers.push(server);
    }
    mkdirSync(join(tmp, "plain"));
    const masks = linuxHostSockets(501, join(tmp, "nohome"), tmp, true, {});
    expect(masks).toEqual(expect.arrayContaining([join(tmp, "top.sock"), join(tmp, "tmux-501")]));
    expect(masks).not.toContain(join(tmp, "plain"));
    expect(linuxHostSockets(501, join(tmp, "nohome"), tmp, false, {})).not.toContain(join(tmp, "top.sock"));
  } finally { for (const one of servers) one.close(); rmSync(tmp, { recursive: true, force: true }); }
});

test("a workspace build with an open network may ask the system's DNS service, and still no other socket", () => {
  const grants: FenceGrants = { ...NO_GRANTS, writes: { subpaths: ["/tmp/so-ws"], prefixes: [] } };
  const profile = macosFenceProfile([], grants);
  expect(profile).toContain("(deny network-outbound (remote unix-socket))");
  expect(profile).toContain(`(remote unix-socket (path-literal "/private/var/run/mDNSResponder"))`);
  expect(macosFenceProfile([], NO_GRANTS)).not.toContain("mDNSResponder");
});

/** A name only the system's resolver answers (localhost comes from the hosts file without it); null when offline. */
const lookup = (wrap: string[]) => spawnSync(wrap[0] ?? process.execPath, [...wrap.slice(1), ...(wrap.length === 0 ? [] : [process.execPath]), "-e", "require('node:dns').lookup('github.com', error => process.stdout.write(error ? 'error ' + error.code : 'found'))"], { encoding: "utf8", timeout: 30_000 }).stdout;
const online = macosFenceAvailable() && lookup([]) === "found";

test.skipIf(!online)("on macOS a workspace build with an open network resolves a host name", () => {
  const work = realpathSync(mkdtempSync(join("/tmp", "so-dns-")));
  try {
    const profile = macosFenceProfile([], { ...NO_GRANTS, writes: { subpaths: [work], prefixes: [] } });
    expect(lookup(["/usr/bin/sandbox-exec", "-p", profile])).toBe("found");
  } finally { rmSync(work, { recursive: true, force: true }); }
});
