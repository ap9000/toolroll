import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, readlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  chooseTarget,
  planLink,
  applyLink,
  planUnlink,
  applyUnlink,
  BIN_NAME,
  LINK_FILE,
} from "./link.js";

const run = promisify(execFile);
const isWindows = process.platform === "win32";

/**
 * Fixtures in the shape of the platform under test. The previous POSIX
 * literals meant chooseTarget was asked about paths it could never be handed
 * on Windows, so its separator handling went untested and was wrong.
 */
const HOME = isWindows ? "C:\\Users\\someone" : "/Users/someone";
const SYSTEM_DIR = isWindows ? "C:\\Windows\\system32" : "/usr/bin";
const OTHER_SYSTEM_DIRS = isWindows
  ? ["C:\\Windows", "C:\\Program Files\\Git\\cmd"]
  : ["/usr/local/bin", "/usr/bin", "/bin"];
const OUTSIDE_HOME = isWindows ? "D:\\tools" : "/opt/tools";

/** Whatever the platform's link mechanism is, what does the one in `dir` point at? */
async function linkTarget(dir: string): Promise<string> {
  const path = join(dir, LINK_FILE);
  if (!isWindows) return readlink(path);
  const declared = /^REM source: (.+)$/m.exec(await readFile(path, "utf8"));
  return declared?.[1]?.trim() ?? "";
}

describe("chooseTarget", () => {
  // ~/.local/bin when it is on PATH, any other home-owned PATH entry (native separator, trailing separator)
  // before inventing one, an explicit directory as given, and never a directory outside home: that would need sudo.
  test.each<[string, string[], string | undefined, { dir: string; onPath: boolean }]>([
    ["prefers ~/.local/bin when it is already on PATH", [SYSTEM_DIR, join(HOME, ".local", "bin")], undefined, { dir: join(HOME, ".local", "bin"), onPath: true }],
    ["honours an explicit directory", [SYSTEM_DIR], OUTSIDE_HOME, { dir: OUTSIDE_HOME, onPath: false }],
    ["never proposes a directory outside the home directory", OTHER_SYSTEM_DIRS, undefined, { dir: join(HOME, ".local", "bin"), onPath: false }],
    ["falls back to ~/.local/bin and reports that it is not on PATH", [SYSTEM_DIR], undefined, { dir: join(HOME, ".local", "bin"), onPath: false }],
    ["uses any home-owned PATH entry before inventing one", [SYSTEM_DIR, join(HOME, "tools")], undefined, { dir: join(HOME, "tools"), onPath: true }],
    ["recognises a home-owned entry written with the native separator", [join(HOME, "scoop", "shims")], undefined, { dir: join(HOME, "scoop", "shims"), onPath: true }],
    ["tolerates a trailing separator on a PATH entry", [SYSTEM_DIR, join(HOME, ".local", "bin") + sep], undefined, { dir: join(HOME, ".local", "bin"), onPath: true }],
  ])("%s", (_label, pathEntries, override, expected) => {
    expect(chooseTarget({ pathEntries, home: HOME, ...(override === undefined ? {} : { override }) })).toEqual(expected);
  });

  test.runIf(isWindows)("compares PATH entries without regard to case", () => {
    // Windows PATH entries are routinely written in a different case than the
    // directory they name, and the shell does not care. Neither should this.
    const target = join(HOME, ".local", "bin");

    const choice = chooseTarget({ pathEntries: [target.toUpperCase()], home: HOME });

    expect(choice).toEqual({ dir: target, onPath: true });
  });
});

describe("planLink and applyLink", () => {
  let base: string;
  let bin: string;
  let source: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "standing-orders-link-"));
    bin = join(base, "bin");
    source = join(base, "cli.js");
    await mkdir(bin, { recursive: true });
    await writeFile(source, "#!/usr/bin/env node\n");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("creates the link, and the directory if it does not exist", async () => {
    const fresh = join(base, "new", "bin");

    const plan = await planLink(source, fresh);
    await applyLink(plan);

    expect(await linkTarget(fresh)).toBe(source);
  });

  test.runIf(!isWindows)("makes the linked command executable", async () => {
    // tsc does not set the execute bit, so a bare symlink to its output gives
    // "permission denied" the first time anyone types the command.
    const plan = await planLink(source, bin);

    await applyLink(plan);

    const mode = (await lstat(source)).mode;
    expect(mode & 0o100).toBeTruthy();
  });

  test.runIf(isWindows)("gives the command a name the shell will resolve", async () => {
    // Windows finds commands through PATHEXT. An extensionless file is not one,
    // so the old symlink was created successfully and then never found.
    expect(LINK_FILE).toBe(`${BIN_NAME}.cmd`);

    await applyLink(await planLink(source, bin));

    const extensions = (process.env["PATHEXT"] ?? "").toLowerCase().split(";");
    expect(extensions).toContain(".cmd");
    expect((await lstat(join(bin, LINK_FILE))).isFile()).toBe(true);
  });

  test.runIf(isWindows)("forwards arguments and exit codes through the shim", async () => {
    // The shim is only worth having if it behaves like the program it stands
    // for: quoting intact through %*, and the real exit code back to the shell.
    await writeFile(
      source,
      "console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exit(3);\n",
    );
    await applyLink(await planLink(source, bin));

    const shim = join(bin, LINK_FILE);
    const failed = await run("cmd.exe", ["/c", shim, "one", "two words", "--json"]).catch(
      error => error,
    );

    expect(JSON.parse(failed.stdout)).toEqual(["one", "two words", "--json"]);
    expect(failed.code).toBe(3);
  });

  const HOSTILE = `"a&b" "a|b" "a^b" "a>b" "(a)" "" "!name!" "spaced arg"`;
  const HOSTILE_ARGV = ["a&b", "a|b", "a^b", "a>b", "(a)", "", "!name!", "spaced arg"];

  test.runIf(isWindows)("passes hostile arguments through unchanged", async () => {
    // A batch metacharacter inside a quoted argument must stay an argument
    // rather than becoming a command separator — getting this wrong would run
    // whatever followed the ampersand.
    //
    // Invoked without CALL, which is how a person at a prompt reaches it. Two
    // earlier versions of this test measured the harness instead: passing these
    // from JS tests node's quoting for `cmd /c`, and passing them via CALL
    // tests CALL, which doubles carets whether or not a shim is involved.
    await writeFile(source, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    await applyLink(await planLink(source, bin));

    const caller = join(base, "direct.cmd");
    await writeFile(
      caller,
      ["@ECHO off", `"${join(bin, LINK_FILE)}" ${HOSTILE}`, ""].join("\r\n"),
    );

    const { stdout } = await run("cmd.exe", ["/c", caller]);

    expect(JSON.parse(stdout.trim())).toEqual(HOSTILE_ARGV);
  });

  test.runIf(isWindows)("adds nothing of its own when reached through CALL", async () => {
    // CALL re-parses its arguments and doubles any caret in them. That is
    // cmd's behaviour, not ours — `CALL node ...` does it with no shim in
    // sight — so what is asserted here is that the shim is transparent:
    // whatever CALL does to a direct invocation, it does identically through
    // the shim. Any difference between the two lines would be the shim's fault.
    await writeFile(source, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    await applyLink(await planLink(source, bin));

    const caller = join(base, "compare.cmd");
    await writeFile(
      caller,
      [
        "@ECHO off",
        `CALL node "${source}" ${HOSTILE}`,
        `CALL "${join(bin, LINK_FILE)}" ${HOSTILE}`,
        "",
      ].join("\r\n"),
    );

    const { stdout } = await run("cmd.exe", ["/c", caller]);
    const [direct, throughShim] = stdout.trim().split(/\r?\n/);

    expect(throughShim).toBe(direct);
  });

  test.runIf(isWindows)("keeps working when called from another batch file", async () => {
    // A .cmd invoked from a .cmd needs CALL, or control never comes back. That
    // is the caller's job, but the exit code has to survive the trip.
    await writeFile(source, "console.log('inner');\nprocess.exit(7);\n");
    await applyLink(await planLink(source, bin));

    const caller = join(base, "caller.cmd");
    await writeFile(
      caller,
      ["@ECHO off", `CALL "${join(bin, LINK_FILE)}" one "two words"`, "EXIT /B %ERRORLEVEL%", ""].join("\r\n"),
    );

    const failed = await run("cmd.exe", ["/c", caller]).catch(error => error);

    expect(failed.stdout.trim()).toBe("inner");
    expect(failed.code).toBe(7);
  });

  test.runIf(isWindows)("survives a percent sign in the source path", async () => {
    // Percent is legal in a Windows path, and cmd would read %Foo% in one as a
    // variable and quietly substitute it away, leaving node a path to nowhere.
    const odd = join(base, "100%Foo%dir");
    const oddSource = join(odd, "cli.js");
    await mkdir(odd, { recursive: true });
    await writeFile(oddSource, "console.log('ran');\n");

    await applyLink(await planLink(oddSource, bin));

    const { stdout } = await run("cmd.exe", ["/c", join(bin, LINK_FILE)]);
    expect(stdout.trim()).toBe("ran");
  });

  test.runIf(isWindows)("writes exactly the shim it claims to", async () => {
    // Read against the literal expected text, not with a copy of the parser,
    // so a change to the shim body cannot pass by agreeing with itself.
    await applyLink(await planLink(source, bin));

    const text = await readFile(join(bin, LINK_FILE), "utf8");

    expect(text).toBe(
      [
        "@ECHO off",
        "REM standing-orders-link: generated by `standing-orders link`; safe to delete",
        `REM source: ${source}`,
        "SETLOCAL DisableDelayedExpansion",
        `node "${source}" %*`,
        "ENDLOCAL & EXIT /B %ERRORLEVEL%",
        "",
      ].join("\r\n"),
    );
  });

  test.runIf(isWindows)("is not fooled by inherited delayed expansion", async () => {
    // Delayed expansion is inherited from whoever started cmd. With it on and
    // unguarded, every `!` in an argument is expanded away before node sees it
    // — "a!name!b" silently arrives as "ab". Nothing warns you.
    await writeFile(source, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    await applyLink(await planLink(source, bin));

    const caller = join(base, "bang.cmd");
    await writeFile(
      caller,
      ["@ECHO off", `"${join(bin, LINK_FILE)}" "a!name!b" "plain"`, ""].join("\r\n"),
    );

    const { stdout } = await run("cmd.exe", ["/v:on", "/c", caller]);

    expect(JSON.parse(stdout.trim())).toEqual(["a!name!b", "plain"]);
  });

  test.runIf(isWindows)("still reports the exit code from inside SETLOCAL", async () => {
    // ENDLOCAL tears down the scope the exit code was read in, so the two have
    // to share a line. Getting that wrong reports success for every failure.
    await writeFile(source, "process.exit(9);\n");
    await applyLink(await planLink(source, bin));

    const caller = join(base, "code.cmd");
    await writeFile(caller, ["@ECHO off", `"${join(bin, LINK_FILE)}"`, ""].join("\r\n"));

    const failed = await run("cmd.exe", ["/c", caller]).catch(error => error);

    expect(failed.code).toBe(9);
  });

  test.runIf(isWindows)("survives a source path with spaces in it", async () => {
    const spaced = join(base, "some place", "cli.js");
    await mkdir(join(base, "some place"), { recursive: true });
    await writeFile(spaced, "console.log('ran');\n");

    await applyLink(await planLink(spaced, bin));

    const { stdout } = await run("cmd.exe", ["/c", join(bin, LINK_FILE)]);
    expect(stdout.trim()).toBe("ran");
  });

  test("recognises a link it has already made", async () => {
    await applyLink(await planLink(source, bin));

    const plan = await planLink(source, bin);

    expect(plan.action).toBe("already");
  });

  test("replaces its own link when it points somewhere stale", async () => {
    const stale = join(base, "old-cli.js");
    await writeFile(stale, "#!/usr/bin/env node\n");
    await applyLink(await planLink(stale, bin));

    const plan = await planLink(source, bin);
    expect(plan.action).toBe("replace");

    await applyLink(plan);
    expect(await linkTarget(bin)).toBe(source);
  });

  test("refuses to touch a real file that is already there", async () => {
    // Someone else's binary of the same name is not ours to delete.
    const occupied = join(bin, LINK_FILE);
    await writeFile(occupied, "someone else's program\n");

    const plan = await planLink(source, bin);
    expect(plan.action).toBe("conflict");

    await expect(applyLink(plan)).rejects.toThrow();
    // and it is still there, untouched
    expect((await lstat(occupied)).isFile()).toBe(true);
  });
});

describe("planUnlink and applyUnlink", () => {
  let base: string;
  let bin: string;
  let source: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "standing-orders-unlink-"));
    bin = join(base, "bin");
    source = join(base, "cli.js");
    await mkdir(bin, { recursive: true });
    await writeFile(source, "#!/usr/bin/env node\n");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("removes a link it made", async () => {
    await applyLink(await planLink(source, bin));

    const plan = await planUnlink(bin);
    expect(plan.action).toBe("remove");

    await applyUnlink(plan);
    await expect(lstat(join(bin, LINK_FILE))).rejects.toThrow();
  });

  test("says nothing is there when nothing is", async () => {
    const plan = await planUnlink(bin);

    expect(plan.action).toBe("absent");
  });

  test("refuses to remove a real file wearing the same name", async () => {
    const occupied = join(bin, LINK_FILE);
    await writeFile(occupied, "someone else's program\n");

    const plan = await planUnlink(bin);
    expect(plan.action).toBe("foreign");

    await expect(applyUnlink(plan)).rejects.toThrow();
    expect((await lstat(occupied)).isFile()).toBe(true);
  });

  test.runIf(isWindows)("leaves someone else's .cmd of the same name alone", async () => {
    // On POSIX "is it ours" is answered by the filesystem: a symlink or not.
    // A .cmd is an ordinary file, so identity rests on the marker we write —
    // and a batch file that merely shares the name must survive untouched.
    const occupied = join(bin, LINK_FILE);
    const theirs = "@ECHO off\r\nECHO a different program entirely\r\n";
    await writeFile(occupied, theirs);

    const plan = await planUnlink(bin);
    expect(plan.action).toBe("foreign");

    await expect(applyUnlink(plan)).rejects.toThrow();
    expect(await readFile(occupied, "utf8")).toBe(theirs);
  });
});
