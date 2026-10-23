/**
 * `toolroll mcp` — the token-file matrix (MCP gateway spec v6).
 *
 * The CLI's credential door: a 0600 regular file owned by us, read through
 * the fd (no symlink, no FIFO hang), XOR the environment variable. Every
 * wrong shape refuses BEFORE any protocol byte flows; under --json the
 * refusal is the standard envelope on stdout.
 *
 * Wrong OWNER is untestable without root: chown to another uid requires
 * privileges this suite must not have, so that arm of the fstat check is
 * deliberately not exercised here.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.js";
import { runOperate, EXIT } from "./operate.js";
import { INSIDE_FENCE } from "../test/inside-fence.js";

const T0 = new Date("2026-08-30T12:00:00.000Z");

describe("the MCP server's credential door", () => {
  let dir: string;
  let db: string;
  let lines: string[];
  let savedEnv: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "standing-orders-mcp-cli-"));
    db = join(dir, "orders.db");
    lines = [];
    // The database exists and is schema-current: the matrix below must hit
    // the token-file checks, never a missing-database refusal.
    openStore(db).close();
    savedEnv = process.env["STANDING_ORDERS_COORDINATOR"];
    delete process.env["STANDING_ORDERS_COORDINATOR"];
  });

  afterEach(async () => {
    // process.env manipulation is restored HERE, every test, pass or fail.
    if (savedEnv === undefined) delete process.env["STANDING_ORDERS_COORDINATOR"];
    else process.env["STANDING_ORDERS_COORDINATOR"] = savedEnv;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  /** Run `toolroll mcp` with --json and keep the envelope lines. */
  const run = (argv: string[]) => {
    lines = [];
    return runOperate("mcp", argv, line => lines.push(line), { databaseFile: db, now: T0 });
  };

  const envelope = () => JSON.parse(lines.join("\n")) as Record<string, unknown>;

  /** A token file with an explicit mode — chmod after the write, so the
   * process umask (which the mcp command itself tightens) never skews it. */
  const tokenFile = (name: string, content: string, mode: number): string => {
    const path = join(dir, name);
    writeFileSync(path, content);
    chmodSync(path, mode);
    return path;
  };

  test("a symlink to a real token file refuses — the token file must be the real file", async () => {
    const real = tokenFile("real-token", "some-token\n", 0o600);
    const link = join(dir, "token-link");
    symlinkSync(real, link);
    const code = await run(["--db", db, "--token-file", link, "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(envelope()).toMatchObject({ ok: false, command: "mcp", reason: "refused" });
    expect(String(envelope()["message"])).toContain("symlink");
  });

  test("a FIFO refuses as not-a-regular-file — and the non-blocking open never hangs", async () => {
    const fifo = join(dir, "token-fifo");
    try {
      // Node has no mkfifo of its own; the system's binary makes the fixture.
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // mkfifo unavailable on this host — the case is skipped
    }
    chmodSync(fifo, 0o600);
    const code = await run(["--db", db, "--token-file", fifo, "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(String(envelope()["message"])).toContain("not a regular file");
  });

  // Wrong OWNER: the fstat uid check refuses a file owned by somebody else,
  // but creating one requires root (chown to a foreign uid) — untestable
  // here by design, and deliberately left to the code path's own words.

  test("mode 0640 refuses — group-readable is not 0600", async () => {
    const path = tokenFile("token-0640", "some-token\n", 0o640);
    const code = await run(["--db", db, "--token-file", path, "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(String(envelope()["message"])).toContain("mode must be exactly 0600");
  });

  // The release check runs inside the plane's macOS fence, which can't set a file's special bits; CI (Linux, and the
  // tag's macOS jobs) runs this unfenced.
  test.skipIf(INSIDE_FENCE)("mode 4600 refuses — the setuid bit counts, special bits included", async () => {
    const path = tokenFile("token-4600", "some-token\n", 0o4600);
    const code = await run(["--db", db, "--token-file", path, "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(String(envelope()["message"])).toContain("mode must be exactly 0600");
  });

  test("an oversize file refuses — a token never needs more than 4096 bytes", async () => {
    const path = tokenFile("token-fat", "x".repeat(4097), 0o600);
    const code = await run(["--db", db, "--token-file", path, "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(String(envelope()["message"])).toContain("too large");
  });

  test("both --token-file AND the environment variable refuse — pick one, never a silent precedence", async () => {
    const path = tokenFile("token-both", "some-token\n", 0o600);
    process.env["STANDING_ORDERS_COORDINATOR"] = "env-token";
    const code = await run(["--db", db, "--token-file", path, "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(String(envelope()["message"])).toContain("pick one");
  });

  test("neither source refuses — no credential, no server", async () => {
    const code = await run(["--db", db, "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(String(envelope()["message"])).toContain("no credential");
  });

  test("the full file-read road: a valid 0600 file whose token is UNKNOWN dies at startup with the credential's words", async () => {
    // The happy path is proved indirectly (the served loop blocks on stdin):
    // the file passes every fstat gate, its bytes are read and trimmed, the
    // store opens through the non-migrating door — and startup dies on the
    // one thing left, the unknown token. That exercises the entire road up
    // to authentication.
    const path = tokenFile("token-unknown", "not-a-minted-token\n", 0o600);
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const code = await run(["--db", db, "--token-file", path, "--json"]);
    expect(code).toBe(EXIT.refused);
    // The startup death honors said()'s contract: a machine caller gets
    // the envelope (no protocol bytes ever flowed), not a bare stderr line.
    const envelope = JSON.parse(lines.join("\n")) as Record<string, unknown>;
    expect(envelope["ok"]).toBe(false);
    expect(String(envelope["message"])).toContain("no live coordinator credential matches this token");
    expect(stderr.join("")).toBe("");
  });
});
