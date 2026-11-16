/**
 * Launching the terminal workbench (tui-launch.ts): which screen opens and why — the binary trusted by WHERE it lives
 * (Toolroll's own install tree, this checkout, or an explicit absolute --tui-binary), each checked for ownership and
 * permissions, never by what it prints or by an environment variable — the self-check (compatibility only) before any
 * sign-in is minted, the link on descriptor 3 only and only after the binary says crash dumps are off, the one ask on
 * descriptor 4, and how the binary's exit code ends the screen.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { easyStartArgs } from "./easy-start-args.js";
import { aclVerdictOf, bundledBinary, chooseTuiBinary, packageRootOf, runTuiBinary, trustedBinary, type TuiChoiceInput } from "./tui-launch.js";
import type { TuiSession } from "./tui-contract.js";

const CONTRACT = "c".repeat(64);
/** What the binary says on descriptor 4 once crash dumps are off (guard.rs READY_LINE). */
const READY = `{"ready":"protected"}\n`;
const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-tui-launch-")));
chmodSync(dir, 0o700);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const PKG = "@toolroll/tui-darwin-arm64";
const unix = process.platform !== "win32";

/** A file at `path` (folders made 0755 on the way), mode `mode`. */
const place = (path: string, text: string, mode = 0o755): string => {
  let folder = dirname(path);
  const made: string[] = [];
  while (folder.startsWith(dir) && folder !== dir) { made.push(folder); folder = dirname(folder); }
  mkdirSync(dirname(path), { recursive: true });
  for (const one of made) chmodSync(one, 0o755);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
};
/** The platform package installed at `folder` (its manifest names it); its binary's path. */
const installAt = (folder: string, name = PKG): string => {
  place(join(folder, "package.json"), JSON.stringify({ name }), 0o644);
  return place(join(folder, "bin", "toolroll-tui"), "#!/bin/sh\n");
};
/** Toolroll installed at `root`, with its platform package in its own node_modules. */
const ROOT = join(dir, "app", "node_modules", "toolroll");
const OWN = installAt(join(ROOT, "node_modules", "@toolroll", "tui-darwin-arm64"));

const base = (more: Partial<TuiChoiceInput> = {}): TuiChoiceInput => ({
  env: {}, screenReader: false, platform: "darwin", arch: "arm64", contract: CONTRACT, packageRoot: ROOT,
  selfCheck: () => ({ status: 0, stdout: `toolroll-tui 0.9.109 contract ${CONTRACT}\n` }),
  ...more,
});
const why = (input: TuiChoiceInput) => { const chose = chooseTuiBinary(input); return chose.ok ? null : chose.why; };
/** A self-check that records what it was asked to run. */
const recording = () => {
  const ran: string[] = [];
  return { ran, selfCheck: (binary: string) => { ran.push(binary); return { status: 0, stdout: `toolroll-tui 1.0.0 contract ${CONTRACT}` }; } };
};

describe.skipIf(!unix)("which screen opens", () => {
  test("the platform package from Toolroll's own install tree, its real path checked, once its self-check names this build's contract", () => {
    const { ran, selfCheck } = recording();
    expect(chooseTuiBinary(base({ selfCheck }))).toEqual({ ok: true, binary: OWN });
    expect(ran).toEqual([OWN]);
  });

  test("the package hoisted beside Toolroll in its own node_modules folder counts; one anywhere else (an upward search) never does", () => {
    const hoistRoot = join(dir, "hoist", "node_modules", "toolroll");
    mkdirSync(hoistRoot, { recursive: true });
    const hoisted = installAt(join(dir, "hoist", "node_modules", "@toolroll", "tui-darwin-arm64"));
    expect(chooseTuiBinary(base({ packageRoot: hoistRoot }))).toEqual({ ok: true, binary: hoisted });
    // Above Toolroll's tree (a node_modules an upward module search would find): not installed.
    const loose = join(dir, "loose", "project", "toolroll");
    mkdirSync(loose, { recursive: true });
    installAt(join(dir, "loose", "node_modules", "@toolroll", "tui-darwin-arm64"));
    installAt(join(dir, "node_modules", "@toolroll", "tui-darwin-arm64"));
    const { ran, selfCheck } = recording();
    expect(why(base({ packageRoot: loose, selfCheck }))).toBe("the terminal workbench isn't installed on this computer");
    // A folder whose manifest names another package isn't it.
    const wrong = join(dir, "wrong", "toolroll");
    installAt(join(wrong, "node_modules", "@toolroll", "tui-darwin-arm64"), "@someone/else");
    expect(why(base({ packageRoot: wrong, selfCheck }))).toBe("the terminal workbench isn't installed on this computer");
    expect(ran).toEqual([]);
  });

  test("the binary the package ships (dist/tui/<platform>-<arch>) comes first; --tui-binary still beats it; a refused one never falls through", () => {
    const root = join(dir, "shipped", "lib", "node_modules", "toolroll");
    const own = installAt(join(root, "node_modules", "@toolroll", "tui-darwin-arm64"));
    const shipped = place(bundledBinary(root, "darwin-arm64"), "#!/bin/sh\n");
    expect(shipped).toBe(join(root, "dist", "tui", "darwin-arm64", "toolroll-tui"));
    const { ran, selfCheck } = recording();
    expect(chooseTuiBinary(base({ packageRoot: root, selfCheck }))).toEqual({ ok: true, binary: shipped });
    // An explicit --tui-binary is the person's own choice, before the shipped one.
    const dev = place(join(dir, "shipped-dev", "toolroll-tui"), "#!/bin/sh\n");
    expect(chooseTuiBinary(base({ packageRoot: root, devBinary: dev, selfCheck }))).toMatchObject({ ok: true, binary: dev });
    // Only this machine's folder: another platform's shipped binary is never run here.
    expect(why(base({ packageRoot: root, platform: "linux", arch: "x64", selfCheck }))).toBe("the terminal workbench isn't installed on this computer");
    // Others can change it: refused with the reason, and the optional package below it is NOT tried instead.
    chmodSync(shipped, 0o775);
    expect(why(base({ packageRoot: root, selfCheck }))).toBe(`the terminal workbench at ${shipped} can't be trusted: others can change it (group- or world-writable)`);
    chmodSync(shipped, 0o755);
    expect(ran).toEqual([shipped, dev]);
    // Gone (deleted from the install): the optional package is next.
    rmSync(shipped);
    expect(chooseTuiBinary(base({ packageRoot: root, selfCheck }))).toEqual({ ok: true, binary: own });
  });

  test("npm prefixes: one owned by this user (nvm, Homebrew's Cellar) passes; a group- or world-writable prefix refuses; a sticky shared folder above it is fine", () => {
    const prefix = join(dir, "prefixes", "lib-owned");
    const root = join(prefix, "lib", "node_modules", "toolroll");
    const shipped = place(bundledBinary(root, "darwin-arm64"), "#!/bin/sh\n");
    const { ran, selfCheck } = recording();
    expect(chooseTuiBinary(base({ packageRoot: root, selfCheck }))).toEqual({ ok: true, binary: shipped });
    // A world-writable prefix (anyone could swap lib/node_modules/toolroll underneath): refused, never run.
    chmodSync(prefix, 0o777);
    expect(why(base({ packageRoot: root, selfCheck }))).toMatch(new RegExp(`can't be trusted: others can change ${prefix} \\(group- or world-writable\\)$`));
    chmodSync(prefix, 0o775);
    expect(why(base({ packageRoot: root, selfCheck }))).toMatch(/can't be trusted: others can change .*lib-owned/);
    // A sticky world-writable folder ABOVE the prefix (like /tmp) can't have the prefix renamed by others: fine.
    chmodSync(prefix, 0o755);
    chmodSync(dirname(prefix), 0o1777);
    expect(chooseTuiBinary(base({ packageRoot: root, selfCheck }))).toEqual({ ok: true, binary: shipped });
    chmodSync(dirname(prefix), 0o755);
    if (process.getuid!() !== 0) {
      // Seen as another user's install (root-owned is the other accepted owner, which a test can't make): refused.
      expect(why(base({ packageRoot: root, uid: process.getuid!() + 1, selfCheck }))).toMatch(/owned by another user/);
    }
    expect(ran).toEqual([shipped, shipped]);
  });

  test("the package root is where the launcher's own module really is: a symlinked install resolves to it, and the environment or working folder never moves it", () => {
    const real = join(dir, "cellar", "toolroll", "1.0.0", "libexec", "lib", "node_modules", "toolroll");
    place(join(real, "dist", "tui-launch.js"), "", 0o644);
    symlinkSync(join(dir, "cellar", "toolroll", "1.0.0"), join(dir, "opt-toolroll"));
    expect(packageRootOf(pathToFileURL(join(dir, "opt-toolroll", "libexec", "lib", "node_modules", "toolroll", "dist", "tui-launch.js")).href)).toBe(real);
    // Without a test's packageRoot: a shipped binary planted where the environment points is never run.
    const planted = join(dir, "planted-root");
    place(bundledBinary(planted, "darwin-arm64"), `#!/bin/sh\necho "toolroll-tui 1.0.0 contract ${CONTRACT}"\n`);
    const { ran, selfCheck } = recording();
    const { packageRoot: _drop, ...rest } = base({ selfCheck, env: { PWD: planted, INIT_CWD: planted, npm_config_prefix: planted, TOOLROLL_ROOT: planted, NODE_PATH: join(planted, "dist") } });
    chooseTuiBinary(rest);
    expect(ran.filter(one => one.startsWith(planted))).toEqual([]);
  });

  test("TOOLROLL_TUI_BINARY chooses nothing (it is ignored, said in one line), even a file that would pass every check", () => {
    const planted = place(join(dir, "planted", "toolroll-tui"), "#!/bin/sh\n");
    const { ran, selfCheck } = recording();
    const chose = chooseTuiBinary(base({ env: { TOOLROLL_TUI_BINARY: planted }, packageRoot: join(dir, "nothing-here"), selfCheck }));
    expect(chose).toEqual({ ok: false, why: "the terminal workbench isn't installed on this computer", notice: "TOOLROLL_TUI_BINARY is ignored: pass --tui-binary <absolute path> to use your own build" });
    expect(ran).toEqual([]);
    // With the package installed, the package is what runs, never the variable's file.
    expect(chooseTuiBinary(base({ env: { TOOLROLL_TUI_BINARY: planted }, selfCheck }))).toMatchObject({ ok: true, binary: OWN });
    expect(ran).toEqual([OWN]);
  });

  test("--tui-binary: only an absolute path (never a name looked up on PATH), checked like the others, said in one line", () => {
    const own = place(join(dir, "dev", "target", "toolroll-tui"), "#!/bin/sh\n");
    const { ran, selfCheck } = recording();
    for (const bare of ["toolroll-tui", "./toolroll-tui", "target/toolroll-tui"]) {
      expect(why(base({ devBinary: bare, selfCheck }))).toBe("--tui-binary needs an absolute path");
    }
    expect(ran).toEqual([]);
    expect(chooseTuiBinary(base({ devBinary: own, selfCheck }))).toEqual({ ok: true, binary: own, notice: `Using your own terminal workbench build at ${own} (--tui-binary)` });
    expect(ran).toEqual([own]);
    // A symlink runs as the real file it points at, and the real file's place is what is checked.
    const link = join(dir, "dev", "link-to-it");
    symlinkSync(own, link);
    expect(chooseTuiBinary(base({ devBinary: link, selfCheck }))).toMatchObject({ ok: true, binary: own });
    expect(easyStartArgs(["--tui-binary", own])).toEqual({ web: false, projectRoot: null, port: null, tuiBinary: own });
    expect(easyStartArgs(["--tui-binary"])).toBeNull();
  });

  test("a file or folder others can change, or another user's, is never run — not even its --version (an impostor could echo it)", () => {
    const { ran, selfCheck } = recording();
    // An impostor that answers the self-check perfectly.
    const impostor = `#!/bin/sh\necho "toolroll-tui 1.0.0 contract ${CONTRACT}"\n`;
    const groupFile = place(join(dir, "bad1", "toolroll-tui"), impostor, 0o775);
    expect(why(base({ devBinary: groupFile, selfCheck }))).toMatch(/can't be trusted: others can change it/);
    const worldDir = place(join(dir, "bad2", "inner", "toolroll-tui"), impostor);
    chmodSync(dirname(worldDir), 0o777);
    expect(why(base({ devBinary: worldDir, selfCheck }))).toMatch(/can't be trusted: others can change .*inner/);
    // A sticky shared folder (like /tmp) as the binary's own folder is refused too; above it, it is fine.
    chmodSync(dirname(worldDir), 0o1777);
    expect(why(base({ devBinary: worldDir, selfCheck }))).toMatch(/others can change .*inner/);
    const underSticky = place(join(dir, "bad2", "inner", "mine", "toolroll-tui"), impostor);
    expect(trustedBinary(underSticky, process.getuid!())).toEqual({ ok: true, real: underSticky });
    // A link from a good place to a file in a bad place: the real place is checked.
    const linked = join(dir, "dev2", "toolroll-tui");
    mkdirSync(dirname(linked), { recursive: true });
    symlinkSync(groupFile, linked);
    expect(why(base({ devBinary: linked, selfCheck }))).toMatch(/others can change it/);
    // The package's own binary, made writable by others: refused just the same.
    chmodSync(OWN, 0o777);
    expect(why(base({ selfCheck }))).toMatch(/^the terminal workbench at .* can't be trusted: others can change it/);
    chmodSync(OWN, 0o755);
    if (process.getuid!() !== 0) {
      // Owned by someone else (here: everything this test made, seen as another user's).
      expect(why(base({ uid: process.getuid!() + 1, selfCheck }))).toMatch(/owned by another user/);
    }
    expect(ran).toEqual([]);
  });

  test("macOS ACLs, read strictly: an allow entry with any change right refuses; deny entries pass; unreadable refuses", () => {
    const mode = "-rwxr-xr-x+ 1 me  staff  1024 Nov 14 22:00 /home/me/bin/toolroll-tui";
    expect(aclVerdictOf("-rwxr-xr-x  1 me  staff  1024 Nov 14 22:00 /home/me/bin/toolroll-tui\n")).toEqual({ ok: true });
    // Every macOS home folder carries this one.
    expect(aclVerdictOf("drwxr-x---+ 52 me  staff  1664 Nov 14 22:00 /home/me\n 0: group:everyone deny delete\n")).toEqual({ ok: true });
    expect(aclVerdictOf(`${mode}\n 0: user:me allow read,execute,readattr,readextattr,readsecurity\n`)).toEqual({ ok: true });
    expect(aclVerdictOf(`${mode}\n 0: user:me allow write\n`)).toEqual({ ok: false, why: "allows user:me to change it (write)" });
    expect(aclVerdictOf(`drwxr-xr-x@ 4 me  staff  128 Nov 14 22:00 /home/me/bin\n 0: group:everyone deny delete\n 1: group:staff inherited allow list,add_file,delete_child,file_inherit,directory_inherit\n`))
      .toEqual({ ok: false, why: "allows group:staff to change it (add_file,delete_child)" });
    for (const right of ["append", "add_subdirectory", "delete", "writeattr", "writeextattr", "writesecurity", "chown"]) {
      expect(aclVerdictOf(`${mode}\n 0: group:everyone allow ${right}\n`).ok, right).toBe(false);
    }
    // Unreadable: nothing, a mangled line, an unknown right, a forged-looking entry.
    for (const bad of ["", "ls: /home/me/x: Permission denied\n", `${mode}\n0: user:me deny delete\n`, `${mode}\n 0: user:me deny teleport\n`, `${mode}\n 0: user:me allow\n`, `${mode}\n garbage\n`]) {
      expect(aclVerdictOf(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    // An ACL that can't be read refuses the binary (fail closed).
    expect(trustedBinary(OWN, process.getuid!(), () => ({ ok: false, why: "can't be read" }))).toEqual({ ok: false, why: "its ACL can't be read" });
    expect(trustedBinary(OWN, process.getuid!(), path => (path === dirname(OWN) ? { ok: false, why: "allows group:staff to change it (add_file)" } : { ok: true })))
      .toEqual({ ok: false, why: `the ACL of ${dirname(OWN)} allows group:staff to change it (add_file)` });
  });

  test.skipIf(process.platform !== "darwin")("macOS: a real `allow write` ACL on a 0755 copy (this user's own entry) is refused", () => {
    const copy = place(join(dir, "acl", "toolroll-tui"), "#!/bin/sh\n");
    expect(trustedBinary(copy, process.getuid!())).toEqual({ ok: true, real: copy });
    const me = userInfo().username;
    try {
      expect(spawnSync("/bin/chmod", ["+a", `${me} allow write`, copy]).status).toBe(0);
      expect(trustedBinary(copy, process.getuid!())).toMatchObject({ ok: false, why: expect.stringMatching(/^its ACL allows user:.* to change it \(write\)$/) });
      expect(why(base({ devBinary: copy }))).toMatch(/can't be trusted: its ACL allows/);
      // The same on the folder above it.
      spawnSync("/bin/chmod", ["-N", copy]);
      expect(spawnSync("/bin/chmod", ["+a", `${me} allow add_file,delete_child`, dirname(copy)]).status).toBe(0);
      expect(trustedBinary(copy, process.getuid!())).toMatchObject({ ok: false, why: expect.stringMatching(/^the ACL of .*acl allows user:.* to change it \(add_file,delete_child\)$/) });
    } finally {
      spawnSync("/bin/chmod", ["-N", copy]);
      spawnSync("/bin/chmod", ["-N", dirname(copy)]);
    }
    expect(trustedBinary(copy, process.getuid!())).toEqual({ ok: true, real: copy });
  });

  test("a source checkout's build only when Toolroll itself runs from that checkout", () => {
    const root = join(dir, "checkout");
    const built = place(join(root, "tui", "target", "release", "toolroll-tui"), "#!/bin/sh\n");
    const { ran, selfCheck } = recording();
    // A tui/target build in a folder that isn't a checkout (no .git, no tui/Cargo.toml) is not trusted.
    expect(why(base({ packageRoot: root, selfCheck }))).toBe("the terminal workbench isn't installed on this computer");
    place(join(root, "tui", "Cargo.toml"), "[workspace]\n", 0o644);
    mkdirSync(join(root, ".git"));
    expect(chooseTuiBinary(base({ packageRoot: root, selfCheck }))).toEqual({ ok: true, binary: built });
    expect(ran).toEqual([built]);
  });

  test("the classic screen, with one reason, for every road that isn't the workbench", () => {
    expect(why(base({ env: { TOOLROLL_SCREEN: "classic" } }))).toBe("TOOLROLL_SCREEN=classic asks for it");
    expect(why(base({ screenReader: true }))).toBe("it works with screen readers");
    expect(why(base({ packageRoot: join(dir, "none") }))).toBe("the terminal workbench isn't installed on this computer");
    expect(why(base({ platform: "win32", arch: "x64", packageRoot: join(dir, "none") }))).toBe("the terminal workbench isn't built for win32-x64 yet");
    expect(why(base({ selfCheck: () => ({ status: null, stdout: "", error: "ENOEXEC" }) }))).toBe("the terminal workbench didn't start (ENOEXEC)");
    expect(why(base({ selfCheck: () => ({ status: 3, stdout: "" }) }))).toBe("the terminal workbench didn't start (exit 3)");
    expect(why(base({ selfCheck: () => ({ status: 43, stdout: "" }) }))).toBe("the terminal workbench couldn't turn off crash dumps on this computer");
    expect(why(base({ selfCheck: () => ({ status: 0, stdout: `toolroll-tui 1.0.0 contract ${"d".repeat(64)}` }) }))).toBe("the terminal workbench is from another Toolroll version");
    expect(why(base({ selfCheck: () => ({ status: 0, stdout: "something else" }) }))).toBe("the terminal workbench is from another Toolroll version");
  });

  test("a real binary that isn't one (ENOEXEC) is never handed a sign-in; one that's gone isn't installed", () => {
    const broken = place(join(dir, "broken", "toolroll-tui"), "\u0000\u0001 not a program");
    const real = (devBinary: string) => { const { selfCheck: _drop, ...rest } = base({ devBinary }); return chooseTuiBinary(rest); };
    expect(real(broken)).toMatchObject({ ok: false, why: expect.stringMatching(/^the terminal workbench didn't start \(/) });
    expect(real(join(dir, "missing"))).toMatchObject({ ok: false, why: expect.stringMatching(/can't be trusted: it isn't there \(ENOENT\)/) });
  });

  test("--screen-reader is an easy start's flag", () => {
    expect(easyStartArgs(["--screen-reader"])).toEqual({ web: false, projectRoot: null, port: null, screenReader: true });
    expect(easyStartArgs([])).toEqual({ web: false, projectRoot: null, port: null });
  });
});

describe("running it", () => {
  /** A stand-in binary: records its arguments, environment and descriptor 3, asks on descriptor 4, exits with `code`. */
  const fake = (code: number): string => {
    const file = join(dir, `fake-${code}.mjs`);
    writeFileSync(file, `#!${process.execPath}
import { writeFileSync, writeSync } from "node:fs";
// Before it says it is protected, nothing arrives on descriptor 3 (watched for 300 ms); then the link, to its end.
const watch = new (await import("node:net")).Socket({ fd: 3, readable: true, writable: false });
let got = "";
const ended = new Promise(done => watch.on("end", done));
watch.on("data", chunk => { got += chunk; });
await new Promise(done => setTimeout(done, 300));
const early = got;
writeSync(4, ${JSON.stringify(READY)});
await ended;
const link = got;
writeFileSync(${JSON.stringify(join(dir, "early-"))} + ${code} + ".txt", early);
writeFileSync(${JSON.stringify(join(dir, "seen-"))} + ${code} + ".json", JSON.stringify({ argv: process.argv.slice(2), env: process.env, link }));
writeSync(4, ${JSON.stringify(`${"x".repeat(2000)}\n{"want":"nothing"}\nnot json\n{"want":"browser"}\n`)});
// The launcher's answer, on the same descriptor.
let said = "";
const answer = new (await import("node:net")).Socket({ fd: 4, readable: true, writable: false });
answer.on("data", chunk => { said += chunk; if (said.includes("\\n")) { writeFileSync(${JSON.stringify(join(dir, "said-"))} + ${code} + ".txt", said); process.exit(${code}); } });
setTimeout(() => process.exit(${code}), 2000);
`);
    chmodSync(file, 0o755);
    return file;
  };
  const LINK = `http://127.0.0.1:4801/login/once/${"A".repeat(43)}`;
  const session = (owned: boolean): TuiSession & { openBrowser: ReturnType<typeof vi.fn> } => ({
    owned: () => owned, openBrowser: vi.fn(async () => "Opened in your browser."), shouldAskBackground: () => false, answerBackground: async () => "",
  });

  test("the link reaches it on descriptor 3 only; it asks for the browser once; its exit code says how the screen ended", async () => {
    const one = session(true);
    expect(await runTuiBinary({ binary: fake(41), link: LINK, session: one, project: "/home/me/shop", stdio: ["ignore", "ignore", "ignore"] })).toBe("keep");
    const seen = JSON.parse(readFileSync(join(dir, "seen-41.json"), "utf8")) as { argv: string[]; env: Record<string, string>; link: string };
    expect(seen.link).toBe(`${LINK}\n`);
    expect(readFileSync(join(dir, "early-41.txt"), "utf8")).toBe("");
    expect(seen.argv).toEqual(["--control-fd", "4", "--owned", "--project", "/home/me/shop"]);
    expect(JSON.stringify(seen.env)).not.toContain("A".repeat(43));
    // Only the one known ask, once; an over-long line, an unknown ask and a malformed line do nothing.
    expect(one.openBrowser).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, "said-41.txt"), "utf8")).toBe(`${JSON.stringify({ said: "Opened in your browser." })}\n`);
    expect(await runTuiBinary({ binary: fake(40), link: LINK, session: session(true), project: null, stdio: ["ignore", "ignore", "ignore"] })).toBe("stop");
    expect(await runTuiBinary({ binary: fake(0), link: LINK, session: session(false), project: null, stdio: ["ignore", "ignore", "ignore"] })).toBe("leave");
    expect((JSON.parse(readFileSync(join(dir, "seen-0.json"), "utf8")) as { argv: string[] }).argv).toEqual(["--control-fd", "4"]);
    expect(await runTuiBinary({ binary: fake(42), link: LINK, session: session(false), project: null, stdio: ["ignore", "ignore", "ignore"] })).toBe("classic");
  });

  test("a binary gone since its self-check opens the classic screen", async () => {
    expect(await runTuiBinary({ binary: join(dir, "gone"), link: LINK, session: session(false), project: null, stdio: ["ignore", "ignore", "ignore"] })).toBe("classic");
  });

  /** A stand-in that never says it is protected: exits `code` at once (or, with null, waits to be stopped). */
  const unready = (code: number | null): string => {
    const file = join(dir, `unready-${code ?? "wait"}.mjs`);
    writeFileSync(file, `#!${process.execPath}\n${code === null ? "setTimeout(() => {}, 60000);" : `process.exit(${code});`}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  /** Records whether the link was ever written on the child's descriptor 3 (by write or end; a bare close isn't). */
  const watchLink = () => {
    const seen = { written: false };
    return { seen, started: (child: import("node:child_process").ChildProcess) => {
      const pipe = child.stdio[3] as unknown as Record<"write" | "end", (...args: unknown[]) => unknown>;
      for (const method of ["write", "end"] as const) {
        const real = pipe[method]!.bind(pipe);
        pipe[method] = (...args: unknown[]) => { if (String(args[0] ?? "").includes("/login/once/")) seen.written = true; return real(...args); };
      }
    } };
  };

  test("a binary that can't turn crash dumps off (exit 43) or never says it did is never sent the link: the classic screen", async () => {
    for (const code of [43, 1, 0]) {
      const { seen, started } = watchLink();
      expect(await runTuiBinary({ binary: unready(code), link: LINK, session: session(false), project: null, stdio: ["ignore", "ignore", "ignore"], started })).toBe("classic");
      expect(seen.written).toBe(false);
    }
    const { seen, started } = watchLink();
    const at = Date.now();
    expect(await runTuiBinary({ binary: unready(null), link: LINK, session: session(false), project: null, stdio: ["ignore", "ignore", "ignore"], started, readyMs: 300 })).toBe("classic");
    expect(seen.written).toBe(false);
    expect(Date.now() - at).toBeLessThan(10_000);
  });

  test("past the ready deadline the hand-off is expired for good: a late ready line sends nothing, and a binary that ignores SIGTERM is killed", async () => {
    // Ignores SIGTERM, says ready late (after the deadline, before the kill), and would wait forever.
    const stubborn = join(dir, "stubborn.mjs");
    writeFileSync(stubborn, `#!${process.execPath}\nimport { writeSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\nsetTimeout(() => writeSync(4, ${JSON.stringify(READY)}), 450);\nsetInterval(() => {}, 1000);\n`);
    chmodSync(stubborn, 0o755);
    const { seen, started: watch } = watchLink();
    let child: import("node:child_process").ChildProcess | null = null;
    const at = Date.now();
    const end = await runTuiBinary({ binary: stubborn, link: LINK, session: session(false), project: null, stdio: ["ignore", "ignore", "ignore"],
      started: one => { child = one; watch(one); }, readyMs: 250, killAfterMs: 500 });
    expect(end).toBe("classic");
    expect(seen.written).toBe(false);
    expect((child as import("node:child_process").ChildProcess | null)?.signalCode).toBe("SIGKILL");
    expect(Date.now() - at).toBeLessThan(5_000);
  });

  test("only the exact absolute path that was checked is started", async () => {
    await expect(runTuiBinary({ binary: "toolroll-tui", link: LINK, session: session(false), project: null })).rejects.toThrow(/checked, absolute path/);
  });
});
