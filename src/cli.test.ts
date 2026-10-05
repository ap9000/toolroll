import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, main, isDirectInvocation, partitionRoots } from "./cli.js";

const options = (argv: string[]) => {
  const parsed = parseArgs(argv);
  if ("error" in parsed) throw new Error(`expected options, got: ${parsed.error}`);
  return parsed.options;
};

const error = (argv: string[]) => {
  const parsed = parseArgs(argv);
  if (!("error" in parsed)) throw new Error("expected an error");
  return parsed.error;
};

describe("parseArgs", () => {
  test("scans the working directory when given nothing", () => {
    // Scanning cwd rather than the home directory by default: a first run
    // should not read every repository a person owns without being asked.
    expect(options([]).roots).toEqual([process.cwd()]);
  });

  test("resolves positional paths against the working directory", () => {
    // Compared against resolve() rather than the literals, because an absolute
    // POSIX path is not absolute on Windows: "/tmp" resolves onto the current
    // drive. What is being asserted is that paths are resolved, not how.
    const absolute = resolve(tmpdir());

    expect(options(["src", absolute]).roots).toEqual([resolve(process.cwd(), "src"), absolute]);
  });

  test("reads --depth", () => {
    expect(options(["--depth", "8"]).maxDepth).toBe(8);
  });

  test("rejects a --depth that is missing or not a number", () => {
    expect(error(["--depth"])).toContain("--depth");
    expect(error(["--depth", "deep"])).toContain("--depth");
    expect(error(["--depth", "-1"])).toContain("--depth");
  });

  test("reads --json and --hidden", () => {
    const parsed = options(["--json", "--hidden"]);

    expect(parsed.json).toBe(true);
    expect(parsed.includeHidden).toBe(true);
  });

  test("keeps --all and --hidden as different questions", () => {
    // --hidden is about where to look; --all is about whether the connected
    // list applies. Conflating them would make one of them unreachable.
    const parsed = options(["--all"]);

    expect(parsed.all).toBe(true);
    expect(parsed.includeHidden).toBe(false);
  });

  test("records whether paths were given, not just what they defaulted to", () => {
    // The connected list applies only when the operator named no paths.
    expect(options([]).rootsGiven).toBe(false);
    expect(options(["/tmp"]).rootsGiven).toBe(true);
  });

  test("leaves the working-tree read off unless --dirty is given", () => {
    // reading a working tree is unbounded work; opting in has to be explicit
    expect(options([]).dirty).toBe(false);
    expect(options(["--dirty"]).dirty).toBe(true);
  });

  test("reads --help", () => {
    expect(options(["--help"]).help).toBe(true);
    expect(options(["-h"]).help).toBe(true);
  });

  test("names an unknown flag instead of ignoring it", () => {
    // Silently ignoring a typo'd flag is how someone concludes the tool is broken
    expect(error(["--jsonn"])).toContain("--jsonn");
  });
});

describe("missing paths", () => {
  test("splits roots into those that exist and those that do not", () => {
    const { present, missing } = partitionRoots(["/here", "/gone"], path => path === "/here");

    expect(present).toEqual(["/here"]);
    expect(missing).toEqual(["/gone"]);
  });

  test("calls a typo a typo instead of reporting an empty search", async () => {
    const lines: string[] = [];

    const code = await main(["/Users/nobody/Documentd"], line => lines.push(line));

    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("does not exist");
    expect(lines.join("\n")).not.toContain("No git repositories found");
  });

  test("keeps JSON parseable when a path is missing", async () => {
    // A warning printed above the envelope would break every consumer of it
    const lines: string[] = [];
    const absent = join(tmpdir(), "standing-orders-nobody", "Documentd");

    const code = await main(["--json", absent], line => lines.push(line));

    expect(code).toBe(2);
    const payload = JSON.parse(lines.join("\n"));
    expect(payload.missingRoots).toEqual([resolve(absent)]);
    expect(payload.repos).toEqual([]);
  });

  test("an all-missing scan's envelope says no, not yes", async () => {
    // ok:true with exit 2 was a lie in the envelope: an agent that typo'd a
    // COMMAND read a green scan and moved on (round-4 findings 6/19). The
    // scan fields stay, so existing consumers keep their shape.
    const lines: string[] = [];
    const absent = join(tmpdir(), "standing-orders-nobody", "Documentd");

    const code = await main(["--json", absent], line => lines.push(line));

    expect(code).toBe(2);
    const payload = JSON.parse(lines.join("\n"));
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("no-repositories");
    expect(payload.command).toBe("scan");
    expect(typeof payload.scannedAt).toBe("string");
  });

  test("a missing bare word names both readings — command or folder", async () => {
    // After resolve() a typo'd verb and a missing relative folder are the
    // same string; the message must not guess which one it was (finding 18).
    const lines: string[] = [];

    const code = await main(["frobnicate"], line => lines.push(line));

    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("if you meant a command");
    expect(lines.join("\n")).toContain("--help");
  });

  test("a missing path-shaped root keeps the plain missing-path message", async () => {
    const lines: string[] = [];

    const code = await main(["/Users/nobody/Documentd"], line => lines.push(line));

    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("does not exist — check the path.");
    expect(lines.join("\n")).not.toContain("if you meant a command");
  });

  test("`toolroll help` prints help instead of scanning a folder named help", async () => {
    const lines: string[] = [];

    const code = await main(["help"], line => lines.push(line));

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("a control plane for unattended coding agents");
  });
});

describe("isDirectInvocation", () => {
  const MODULE = pathToFileURL("/pkg/dist/cli.js").href;

  test("recognises the module when invoked through a symlink on PATH", () => {
    // The failure this guards is silent: the command runs, prints nothing,
    // and exits 0, because argv[1] is the link and the module is the target.
    const resolved = isDirectInvocation(MODULE, "/home/me/.local/bin/standing-orders", () =>
      "/pkg/dist/cli.js",
    );

    expect(resolved).toBe(true);
  });

  test("runs the same way under the toolroll name and the older standing-orders name", () => {
    const bin = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { bin: Record<string, string> }).bin;
    expect(bin).toEqual({ toolroll: "dist/bin.js", "standing-orders": "dist/bin.js" });
    for (const name of Object.keys(bin)) {
      expect(isDirectInvocation(MODULE, `/home/me/.local/bin/${name}`, () => "/pkg/dist/cli.js")).toBe(true);
    }
  });

  test("recognises a direct path invocation", () => {
    expect(isDirectInvocation(MODULE, "/pkg/dist/cli.js", path => path)).toBe(true);
  });

  test("stays quiet when imported by something else", () => {
    expect(isDirectInvocation(MODULE, "/usr/bin/vitest", path => path)).toBe(false);
    expect(isDirectInvocation(MODULE, undefined, path => path)).toBe(false);
  });

  test("treats an unresolvable entry as not a direct invocation", () => {
    const resolved = isDirectInvocation(MODULE, "/gone", () => {
      throw new Error("ENOENT");
    });

    expect(resolved).toBe(false);
  });
});

describe("link command", () => {
  const NEVER_CREATED = join(tmpdir(), "standing-orders-never-created");

  test("changes nothing without --yes", async () => {
    // The tool refuses to install things on your behalf; that has to include
    // installing itself. Showing the plan is the whole point.
    const lines: string[] = [];

    const code = await main(["link", "--to", NEVER_CREATED], line => lines.push(line), {
      binSource: process.execPath,
    });

    expect(code).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("Nothing has been written");
    expect(existsSync(NEVER_CREATED)).toBe(false);
  });

  test("rejects a --to with no directory", async () => {
    const lines: string[] = [];

    const code = await main(["link", "--to"], line => lines.push(line));

    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("--to");
  });

  test("says nothing to remove when the link is not there", async () => {
    // Deliberately no binSource: `unlink` has nothing to point at, so it must
    // not go looking for a build. Requiring one would strand anyone whose
    // dist/ has been cleaned since they linked.
    const lines: string[] = [];

    const code = await main(["unlink", "--to", NEVER_CREATED], line => lines.push(line));

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Nothing to remove");
  });
});

describe("main", () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "standing-orders-cli-"));
    await mkdir(join(base, "alpha", ".git"), { recursive: true });
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("prints help and exits successfully", async () => {
    const lines: string[] = [];

    const code = await main(["--help"], line => lines.push(line));

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("toolroll");
  });

  test("exits with a usage code on a bad flag", async () => {
    const lines: string[] = [];

    const code = await main(["--nope"], line => lines.push(line));

    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("--nope");
  });

  test("emits a JSON envelope agents can consume", async () => {
    const lines: string[] = [];

    const code = await main(["--json", base], line => lines.push(line));

    expect(code).toBe(0);
    const payload = JSON.parse(lines.join("\n"));
    expect(payload.roots).toEqual([base]);
    expect(payload.repos).toHaveLength(1);
    expect(payload.repos[0].name).toBe("alpha");
    expect(typeof payload.scannedAt).toBe("string");
  });

  test("prints a readable report by default", async () => {
    const lines: string[] = [];

    const code = await main([base], line => lines.push(line));

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("repositor");
  });
});

describe("graph command", () => {
  test("rejects an option it does not have", async () => {
    const lines: string[] = [];

    const code = await main(["graph", "--deep"], line => lines.push(line));

    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("--deep");
  });

  test("says a named path does not exist rather than reporting nothing found", async () => {
    // Same rule as the main report: a typo is not an empty search.
    const lines: string[] = [];
    const absent = join(tmpdir(), "standing-orders-no-such-repo");

    const code = await main(["graph", absent], line => lines.push(line));

    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("does not exist");
  });

  test("emits JSON when asked, for the half of the audience that is an agent", async () => {
    const lines: string[] = [];

    const code = await main(["graph", "--json", tmpdir()], line => lines.push(line));

    expect(code).toBe(0);
    expect(() => JSON.parse(lines.join("\n"))).not.toThrow();
  });
});

describe("the unified report envelope", () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "standing-orders-envelope-"));
    await mkdir(join(base, "alpha", ".git"), { recursive: true });
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("--local reads nothing from the network and says so in the envelope", async () => {
    const lines: string[] = [];

    const code = await main(["--json", "--local", base], line => lines.push(line));

    expect(code).toBe(0);
    const payload = JSON.parse(lines.join("\n"));
    expect(payload.remoteRead).toBe(false);
    for (const repo of payload.repos) {
      // Empty arrays beside `false` flags: nothing was found because nothing
      // was asked, and a consumer can tell that from a genuine zero.
      expect(repo.pulls).toEqual([]);
      expect(repo.pullsRead).toBe(false);
      expect(repo.issuesRead).toBe(false);
    }
  });

  test("carries the remote fields on every repository", async () => {
    // Per repository rather than only at the top level: an empty `pulls` means
    // three different things and a consumer should not have to join two parts
    // of the envelope to find out which.
    const lines: string[] = [];

    await main(["--json", "--local", base], line => lines.push(line));

    const [repo] = JSON.parse(lines.join("\n")).repos;
    for (const field of ["pulls", "issues", "pullsRead", "issuesRead", "remoteSkipped", "remoteProblems"]) {
      expect(repo).toHaveProperty(field);
    }
  });

  test("keeps the fields the old envelope had", async () => {
    // Additive, so a consumer reading the previous shape still works.
    const lines: string[] = [];

    await main(["--json", "--local", base], line => lines.push(line));

    const payload = JSON.parse(lines.join("\n"));
    expect(payload).toHaveProperty("scannedAt");
    expect(payload).toHaveProperty("roots");
    expect(payload).toHaveProperty("missingRoots");
    expect(payload.repos[0]).toHaveProperty("branches");
    expect(payload.repos[0]).toHaveProperty("path");
  });

  test("--local is a different question from --dirty and --all", async () => {
    const parsed = parseArgs(["--local"]);
    if ("error" in parsed) throw new Error(parsed.error);

    expect(parsed.options.local).toBe(true);
    expect(parsed.options.dirty).toBe(false);
    expect(parsed.options.all).toBe(false);
  });
});

describe("repos add-from-github — the refusals that need no network", () => {
  let lines: string[] = [];
  const write = (line: string) => lines.push(line);
  const out = () => lines.join("\n");

  test("strict parsing: bad shapes, missing root, unknown flags, extra positionals", async () => {
    const { main } = await import("./cli.js");
    lines = [];
    expect(await main(["repos", "add-from-github"], write)).toBe(2);
    lines = [];
    expect(await main(["repos", "add-from-github", "bad name", "--root", "/tmp"], write)).toBe(2);
    expect(out()).toContain("owner/name");
    lines = [];
    expect(await main(["repos", "add-from-github", "a/b"], write)).toBe(2);
    expect(out()).toContain("--root");
    lines = [];
    expect(await main(["repos", "add-from-github", "a/b", "--root", "/definitely/not/here-xyz"], write)).toBe(2);
    lines = [];
    expect(await main(["repos", "add-from-github", "a/b", "c/d", "--root", "/tmp"], write)).toBe(2);
    expect(out()).toContain("one repository at a time");
    lines = [];
    expect(await main(["repos", "add-from-github", "a/b", "--frobnicate"], write)).toBe(2);
    expect(out()).toContain("--frobnicate");
    lines = [];
    expect(await main(["repos", "add-from-github", "a/b", "--root", "/tmp", "--json", "--frobnicate"], write)).toBe(2);
    const body = JSON.parse(out()) as { ok: boolean; reason: string };
    expect(body).toMatchObject({ ok: false, reason: "usage" });
  });
});


describe("repos add-from-github — behavior through injected gh halves", () => {
  let lines: string[] = [];
  const write = (line: string) => lines.push(line);
  const out = () => lines.join("\n");

  const preview = (kib: number | null) => async (owner: string, name: string) => ({
    ok: true as const,
    preview: { nameWithOwner: `${owner}/${name}`, visibility: "public", diskUsageKib: kib, description: "" },
  });
  const cloneInto = async (nameWithOwner: string, root: string) => {
    const { mkdirSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const target = join(root, nameWithOwner.split("/")[1] as string);
    mkdirSync(target, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: target });
    return { ok: true as const, target };
  };

  test("preview is exit 3 with the shape, large gates on --large-ok, --yes clones and connects through the locked registry", async () => {
    const { main } = await import("./cli.js");
    const { mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const home = mkdtempSync(join(tmpdir(), "so-afg-home-"));
    const root = realpathSync(mkdtempSync(join(tmpdir(), "so-afg-root-")));
    const env = process.env["XDG_CONFIG_HOME"];
    const dbEnv = process.env["TOOLROLL_DB"];
    process.env["XDG_CONFIG_HOME"] = home;
    // The registry `up` watches sits beside the database.
    process.env["TOOLROLL_DB"] = join(home, "toolroll", "orders.db");
    const registry = join(home, "toolroll", "repos.json");
    try {
      const onboard = { preview: preview(512), clone: cloneInto };
      // preview: exit 3, nothing written
      lines = [];
      expect(await main(["repos", "add-from-github", "o/thing", "--root", root, "--json"], write, { onboard })).toBe(3);
      expect(JSON.parse(out())).toMatchObject({ ok: false, reason: "unconfirmed", preview: { nameWithOwner: "o/thing", large: false } });
      expect(existsSync(join(root, "thing"))).toBe(false);

      // large (unknown size) gates until --large-ok
      lines = [];
      expect(await main(["repos", "add-from-github", "o/huge", "--root", root, "--yes", "--json"], write, { onboard: { preview: preview(null), clone: cloneInto } })).toBe(3);
      expect(JSON.parse(out())).toMatchObject({ ok: false, reason: "large" });

      // --yes clones and connects
      lines = [];
      expect(await main(["repos", "add-from-github", "o/thing", "--root", root, "--yes", "--json"], write, { onboard })).toBe(0);
      expect(JSON.parse(out())).toMatchObject({ ok: true, target: join(root, "thing") });
      expect(readFileSync(registry, "utf8")).toContain("thing");

      // a live lock refuses with the updater's own reason, never "usage"
      writeFileSync(`${registry}.lock`, JSON.stringify({ pid: process.pid, token: "x", at: Date.now() }));
      lines = [];
      expect(await main(["repos", "add-from-github", "o/thing2", "--root", root, "--yes", "--json"], write, { onboard: { preview: preview(1), clone: cloneInto } })).toBe(1);
      expect(JSON.parse(out())).toMatchObject({ ok: false, reason: "locked" });
    } finally {
      if (env === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = env;
      process.env["TOOLROLL_DB"] = dbEnv;
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a clone answering with a foreign path never connects", async () => {
    const { main } = await import("./cli.js");
    const { mkdtempSync, rmSync, realpathSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const home = mkdtempSync(join(tmpdir(), "so-afg-home2-"));
    const root = realpathSync(mkdtempSync(join(tmpdir(), "so-afg-root2-")));
    const env = process.env["XDG_CONFIG_HOME"];
    const dbEnv = process.env["TOOLROLL_DB"];
    process.env["XDG_CONFIG_HOME"] = home;
    // The registry `up` watches sits beside the database.
    process.env["TOOLROLL_DB"] = join(home, "toolroll", "orders.db");
    const registry = join(home, "toolroll", "repos.json");
    try {
      const liar = async () => ({ ok: true as const, target: "/somewhere/else" });
      lines = [];
      expect(await main(["repos", "add-from-github", "o/thing", "--root", root, "--yes", "--json"], write, { onboard: { preview: preview(1), clone: liar } })).toBe(1);
      expect(JSON.parse(out())).toMatchObject({ ok: false, reason: "malformed" });
      expect(existsSync(registry)).toBe(false);
    } finally {
      if (env === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = env;
      process.env["TOOLROLL_DB"] = dbEnv;
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
