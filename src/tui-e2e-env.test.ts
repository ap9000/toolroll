/**
 * The terminal workbench journey's isolation (scripts/tui-e2e.mjs): its child environment is built from an allowlist,
 * never a copy of this process's (a copy once replaced the throwaway HOME and PATH and ran the person's real Claude
 * Code); its pre-flight aborts the run when an agent CLI resolves outside the stand-in folder or HOME is the real one;
 * and a run with a required outcome false fails. Nothing here starts the journey: only its functions are imported.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
// @ts-expect-error plain ESM script without declarations
import { AGENT_CLIS, childEnv, ENV_ALLOWED, preflightOf, requiredOf, whereIn } from "../scripts/tui-e2e.mjs";

type Env = Record<string, string>;
type Preflight = { ok: boolean; home_is_throwaway: boolean; agents: Record<string, string | null>; problems?: string[] };
const dir = mkdtempSync(join(tmpdir(), "so-tui-e2e-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const bin = join(dir, "bin"), home = join(dir, "home"), tmp = join(dir, "tmp");
const REAL_HOME = "/home/me";
const xdg = { XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state") };
const git = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const build = (): Env => childEnv({ bin, home, tmp, db: join(dir, "orders.db"), xdg, git }) as Env;

describe("the journey's child environment", () => {
  const saved = { ...process.env };
  afterEach(() => { for (const name of ["HOME", "PATH", "ANTHROPIC_API_KEY", "CLAUDECODE", "OPENAI_API_KEY"]) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

  test("built from nothing: this process's HOME, PATH and agent variables never reach it", () => {
    process.env["HOME"] = REAL_HOME;
    process.env["PATH"] = `${REAL_HOME}/.local/bin:/opt/homebrew/bin:/usr/bin`;
    process.env["ANTHROPIC_API_KEY"] = "not-a-real-key";
    process.env["CLAUDECODE"] = "1";
    const env = build();
    expect(env["HOME"]).toBe(home);
    expect(env["PATH"]).toBe(`${bin}:/usr/bin:/bin:/usr/sbin:/sbin`);
    expect(env["TMPDIR"]).toBe(tmp);
    expect(env["BROWSER"]).toBe(join(bin, "browser"));
    for (const name of Object.keys(xdg)) expect(env[name]!.startsWith(home)).toBe(true);
    expect(Object.keys(env).filter(name => !(ENV_ALLOWED as RegExp).test(name))).toEqual([]);
    expect(JSON.stringify(env)).not.toMatch(/not-a-real-key|CLAUDECODE|\/opt\/homebrew|\.local\/bin/);
    // No TUI binary chosen through the environment (the journey passes --tui-binary).
    expect(env["TOOLROLL_TUI_BINARY"]).toBeUndefined();
  });
});

describe("the pre-flight", () => {
  const stand = (names: readonly string[]) => {
    mkdirSync(bin, { recursive: true });
    for (const name of names) { writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n"); chmodSync(join(bin, name), 0o755); }
  };

  test("passes when every agent CLI is its stand-in and HOME is the throwaway one", () => {
    const where = (env: Env, name: string) => `${env["PATH"]!.split(":")[0]}/${name}`;
    const verdict = preflightOf(build(), { bin, realHome: REAL_HOME, where }) as Preflight;
    expect(verdict).toEqual({ ok: true, home_is_throwaway: true, agents: Object.fromEntries((AGENT_CLIS as string[]).map(name => [name, "stand-in"])) });
  });

  test("ABORTS when an agent CLI resolves outside the stand-in folder", () => {
    const where = (_env: Env, name: string) => (name === "claude" ? `${REAL_HOME}/.local/bin/claude` : name === "codex" ? "/opt/homebrew/bin/codex" : "");
    const verdict = preflightOf(build(), { bin, realHome: REAL_HOME, where }) as Preflight;
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([
      `claude resolves outside the stand-in folder (${REAL_HOME}/.local/bin/claude)`,
      "codex resolves outside the stand-in folder (/opt/homebrew/bin/codex)",
    ]);
    // A folder that merely starts like the stand-in folder isn't it.
    const lookalike = (_env: Env, name: string) => `${bin}-other/${name}`;
    expect((preflightOf(build(), { bin, realHome: REAL_HOME, where: lookalike }) as Preflight).ok).toBe(false);
  });

  test("ABORTS when HOME is the real home, or a name outside the allowlist is set", () => {
    const where = () => "";
    const realHomeEnv = { ...build(), HOME: REAL_HOME };
    expect((preflightOf(realHomeEnv, { bin, realHome: REAL_HOME, where }) as Preflight).problems).toEqual(["HOME is the real home"]);
    const leaked = { ...build(), ANTHROPIC_API_KEY: "x" };
    expect((preflightOf(leaked, { bin, realHome: REAL_HOME, where }) as Preflight).problems).toEqual(["names outside the allowlist: ANTHROPIC_API_KEY"]);
  });

  test.skipIf(process.platform === "win32")("the real lookup runs a shell with exactly that environment", () => {
    stand(AGENT_CLIS as string[]);
    const env = build();
    expect(whereIn(env, "claude")).toBe(join(bin, "claude"));
    expect(whereIn(env, "no-such-tool-anywhere")).toBe("");
    const verdict = preflightOf(env, { bin, realHome: REAL_HOME }) as Preflight;
    expect(verdict.ok, JSON.stringify(verdict.problems)).toBe(true);
  });
});

test("a run with any required outcome false fails (accepted=false is no longer a pass)", () => {
  const ran = { preflight: { ok: true }, workbench: true, exit: "ended", diff_shown: true, accepted: false, provider_turns: ["builder"] };
  const full = requiredOf(ran, { modelFree: false, browser: false, raw: "Using your own terminal workbench build at /x (--tui-binary).", failure: null }) as Record<string, boolean>;
  expect(full["accepted"]).toBe(false);
  expect(Object.values(requiredOf({ ...ran, accepted: true }, { modelFree: false, browser: false, raw: "Using your own terminal workbench build", failure: null }) as Record<string, boolean>).every(Boolean)).toBe(true);
  const free = requiredOf({ ...ran, filed: 1 }, { modelFree: true, browser: false, raw: "", failure: null }) as Record<string, boolean>;
  expect(free["nothing_filed"]).toBe(false);
  expect(free["signed_in_by_flag"]).toBe(false);
});
