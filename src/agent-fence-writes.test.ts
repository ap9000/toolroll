/** The Linux fence's arguments for a workspace build (agent-fence.ts linuxFenced): what /tmp gives back is read-only,
 * the allowlist is bound writable after it, and the host's own services are masked whatever the network. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { linuxFenced, linuxHostSockets, NO_GRANTS, type FenceGrants } from "./agent-fence.js";

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
