import { afterEach, describe, expect, test, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.js";
import { EXIT } from "./operate.js";
import { CONCURRENT_WRITER_WAIT_MS, openStore } from "./store.js";

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "standing-orders-cli-busy-"));
  roots.push(root);
  const file = join(root, "orders.db");
  openStore(file).close();
  return file;
}

async function holdWriter(file: string, releaseAfterMs: number | null): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE schema_version SET version = version").run();
    process.send("locked");
    const release = () => {
      db.exec("COMMIT");
      db.close();
      process.disconnect();
    };
    const delay = JSON.parse(process.argv[2]);
    if (delay === null) process.once("message", release);
    else setTimeout(release, delay);
  `, file, JSON.stringify(releaseAfterMs)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`writer did not lock ${file}`)), 5_000);
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => {
      clearTimeout(timer);
      reject(new Error(`writer exited before taking the lock (${code}): ${stderr}`));
    });
    child.once("message", message => {
      if (message !== "locked") return;
      clearTimeout(timer);
      resolve();
    });
  });
  return child;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
  });
}

describe("CLI database contention", () => {
  test("help and the command contract explain the database wait", async () => {
    const help: string[] = [];
    expect(await main(["task", "--help"], line => help.push(line))).toBe(EXIT.ok);
    expect(help.join("\n")).toContain("--db <path>       use a different queue; waits up to 15 seconds for another writer");

    const contract: string[] = [];
    expect(await main(["contract", "--commands", "--json"], line => contract.push(line))).toBe(EXIT.ok);
    expect(JSON.parse(contract.join("\n")).notes.database).toBe(
      "local database commands wait up to 15 seconds for another writer; an exhausted wait returns database-busy and names the selected file",
    );
  });

  test("a command waits for a second connection and succeeds after its short write", async () => {
    const file = fixture();
    const writer = await holdWriter(file, 2_000);
    const lines: string[] = [];

    const code = await main(
      ["task", "add", "Queued after the writer", "--id", "after-writer", "--key", "busy-success", "--db", file, "--json"],
      line => lines.push(line),
    );

    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: true, command: "task add" });
    await waitForExit(writer);
    const reopened = openStore(file);
    try {
      expect(reopened.getTask("after-writer")?.title).toBe("Queued after the writer");
      expect(reopened.raw().prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: CONCURRENT_WRITER_WAIT_MS });
      expect(CONCURRENT_WRITER_WAIT_MS).toBe(15_000);
    } finally {
      reopened.close();
    }
  });

  test("a command names the database when another connection holds the lock past the bound", async () => {
    const file = fixture();
    const store = openStore(file);
    const writer = await holdWriter(file, null);
    const lines: string[] = [];
    // Advance time for each real lock attempt, not for clock reads: adding an
    // observer (such as telemetry) must not itself spend the injected budget.
    // The short-write test above keeps the real wait.
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const exec = store.handle.exec.bind(store.handle);
    const attempt = vi.spyOn(store.handle, 'exec').mockImplementation(sql => {
      try { return exec(sql); } finally { if (sql === 'BEGIN IMMEDIATE') clock += 1_000; }
    });
    let code: number;
    let elapsed: number;
    try {
      const started = performance.now();
      code = await main(
        ["task", "add", "Must not be saved", "--id", "still-busy", "--key", "busy-failure", "--db", file, "--json"],
        line => lines.push(line),
        { operate: { openDatabase: () => store } },
      );
      elapsed = performance.now() - started;
    } finally {
      attempt.mockRestore();
      now.mockRestore();
    }

    expect(code).toBe(EXIT.failed);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({
      ok: false,
      command: "task",
      reason: "database-busy",
      message: `The database ${file} stayed busy for 15 seconds. Wait for the other Toolroll process to finish, then try again.`,
    });
    expect(elapsed).toBeGreaterThanOrEqual(CONCURRENT_WRITER_WAIT_MS);
    expect(elapsed).toBeLessThan(CONCURRENT_WRITER_WAIT_MS + 5_000);

    writer.send("release");
    await waitForExit(writer);
    const reopened = openStore(file);
    try {
      expect(reopened.getTask("still-busy")).toBeNull();
    } finally {
      reopened.close();
    }
  });
});
