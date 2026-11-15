/**
 * Launching the terminal workbench (tui-launch.ts): which screen opens and why, the self-check before any sign-in is
 * minted, the link on descriptor 3 only, the one ask on descriptor 4, and how the binary's exit code ends the screen.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { easyStartArgs } from "./easy-start-args.js";
import { chooseTuiBinary, runTuiBinary, type TuiChoiceInput } from "./tui-launch.js";
import type { TuiSession } from "./tui-contract.js";

const CONTRACT = "c".repeat(64);
const dir = mkdtempSync(join(tmpdir(), "so-tui-launch-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const base = (more: Partial<TuiChoiceInput> = {}): TuiChoiceInput => ({
  env: {}, screenReader: false, platform: "darwin", arch: "arm64", contract: CONTRACT, packageRoot: join(dir, "no-checkout"),
  resolvePackage: () => join(dir, "pkg", "package.json"),
  selfCheck: () => ({ status: 0, stdout: `toolroll-tui 0.9.109 contract ${CONTRACT}\n` }),
  ...more,
});

describe("which screen opens", () => {
  test("the platform package's binary, once its self-check names this build's contract", () => {
    const seen: string[] = [];
    expect(chooseTuiBinary(base({ selfCheck: binary => { seen.push(binary); return { status: 0, stdout: `toolroll-tui 1.0.0 contract ${CONTRACT}` }; } })))
      .toEqual({ ok: true, binary: join(dir, "pkg", "bin", "toolroll-tui") });
    expect(seen).toEqual([join(dir, "pkg", "bin", "toolroll-tui")]);
  });

  test("the classic screen, with one reason, for every road that isn't the workbench", () => {
    const why = (input: TuiChoiceInput) => { const chose = chooseTuiBinary(input); return chose.ok ? null : chose.why; };
    expect(why(base({ env: { TOOLROLL_SCREEN: "classic" } }))).toBe("TOOLROLL_SCREEN=classic asks for it");
    expect(why(base({ screenReader: true }))).toBe("it works with screen readers");
    expect(why(base({ resolvePackage: () => null }))).toBe("the terminal workbench isn't installed on this computer");
    expect(why(base({ platform: "win32", arch: "x64", resolvePackage: () => null }))).toBe("the terminal workbench isn't built for win32-x64 yet");
    expect(why(base({ selfCheck: () => ({ status: null, stdout: "", error: "ENOEXEC" }) }))).toBe("the terminal workbench didn't start (ENOEXEC)");
    expect(why(base({ selfCheck: () => ({ status: 3, stdout: "" }) }))).toBe("the terminal workbench didn't start (exit 3)");
    expect(why(base({ selfCheck: () => ({ status: 0, stdout: `toolroll-tui 1.0.0 contract ${"d".repeat(64)}` }) }))).toBe("the terminal workbench is from another Toolroll version");
    expect(why(base({ selfCheck: () => ({ status: 0, stdout: "something else" }) }))).toBe("the terminal workbench is from another Toolroll version");
  });

  test("a real binary that isn't one (ENOEXEC) and one that's gone are never handed a sign-in", () => {
    const broken = join(dir, "broken");
    writeFileSync(broken, "\u0000\u0001 not a program");
    chmodSync(broken, 0o755);
    const real = (env: NodeJS.ProcessEnv) => { const { selfCheck: _drop, ...rest } = base({ env }); return chooseTuiBinary(rest); };
    expect(real({ TOOLROLL_TUI_BINARY: broken })).toMatchObject({ ok: false, why: expect.stringMatching(/^the terminal workbench didn't start \(/) });
    expect(real({ TOOLROLL_TUI_BINARY: join(dir, "missing") })).toMatchObject({ ok: false, why: "the terminal workbench didn't start (ENOENT)" });
  });

  test("a source checkout's own build when no package is installed", () => {
    const root = join(dir, "checkout");
    const built = join(root, "tui", "target", "release");
    mkdirSync(built, { recursive: true });
    writeFileSync(join(built, "toolroll-tui"), "");
    expect(chooseTuiBinary(base({ resolvePackage: () => null, packageRoot: root }))).toEqual({ ok: true, binary: join(built, "toolroll-tui") });
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
import { readFileSync, writeFileSync, writeSync } from "node:fs";
const link = readFileSync(3, "utf8");
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
});
