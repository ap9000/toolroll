/**
 * A Direct Chat Ship commits what its preview showed, and nothing else. The preview's digest once hashed a new
 * folder's collapsed status entry (and a `?` when hashing the folder failed), so a file changed inside a new folder
 * after the preview left the digest as it was and was then shipped. Now each new file is listed and hashed on its own,
 * a change anywhere refuses the Ship, and the snapshot stages exactly the previewed paths.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { fakePid } from "../fake-pid.js";
import { DirectChatHost } from "../../src/direct-chat.js";
import { executeDirectChatShip, previewDirectChatShip } from "../../src/direct-chat-ship.js";
import type { CustodyIO, ProcessWitness, ProcRow } from "../../src/flexible-custody.js";
import { declareNewInstallSolo } from "../../src/install-mode.js";
import { addApprover } from "../../src/scope.js";
import { openStore, type Store } from "../../src/store.js";

const GIT_ENV = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const T0 = new Date("2026-10-27T12:00:00.000Z");
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

class FakeCustody implements CustodyIO {
  readonly platform: NodeJS.Platform = "darwin";
  readonly self = 1;
  readonly rows = new Map<number, ProcRow>();
  add(pid: number, start = "s1"): void { this.rows.set(pid, { pid, ppid: 1, pgid: pid, uid: 501, start, zombie: false }); }
  table(): ProcRow[] { return [...this.rows.values()]; }
  namespaceOf(): string | null { return null; }
  holdersOf(): number[] { return []; }
  signal(targets: readonly ProcessWitness[]) {
    for (const t of targets) this.rows.delete(t.pid);
    return { sent: [...targets], gone: [], mismatched: [], refused: [], unsupported: false, bestEffort: true };
  }
}

async function chatWith(): Promise<{ store: Store; stateRoot: string; threadId: string; clone: string; repo: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dc-ship-")));
  dirs.push(root);
  const repo = join(root, "app");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  writeFileSync(join(repo, "README.md"), "# App\n");
  execFileSync("git", ["-C", repo, "add", "README.md"], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "initial"], { env: GIT_ENV });
  const store = openStore(join(root, "state.db"));
  stores.push(store);
  if (!addApprover(store, "alex", T0).ok) throw Error("approver");
  declareNewInstallSolo(store, "alex", T0);
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);
  const custody = new FakeCustody();
  const host = new DirectChatHost(store, {
    stateRoot: join(root, "state"), custody, bootId: () => "boot-1", locateBinary: () => "/fake/claude",
    spawnTurn: input => {
      mkdirSync(dirname(input.logPath), { recursive: true });
      writeFileSync(input.logPath, "", { mode: 0o600 });
      const pid = fakePid(12);
      custody.add(pid, "s9200");
      return { pid, pgid: pid, startIdentity: "s9200" };
    },
  });
  const started = await host.createThread({ owner: "alex", localGeneration: null, accountGeneration: 1, requestId: "3".repeat(32), repo, provider: "claude", prompt: "Add feature" });
  if (!started.ok) throw Error(JSON.stringify(started));
  host.stopThread("alex", started.thread.id);
  return { store, stateRoot: host.stateRoot, threadId: started.thread.id, clone: started.thread.clonePath, repo };
}

const headOf = (clone: string) => execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { env: GIT_ENV, encoding: "utf8" }).trim();

test("a file changed inside a new folder after the preview: the Ship is refused as changed and nothing is committed", async () => {
  const chat = await chatWith();
  mkdirSync(join(chat.clone, "lib", "deep"), { recursive: true });
  writeFileSync(join(chat.clone, "lib", "deep", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(chat.clone, "lib", "b.ts"), "export const b = 1;\n");
  const preview = previewDirectChatShip(chat.store, { stateRoot: chat.stateRoot, owner: "alex", threadId: chat.threadId });
  if (!preview.ok) throw Error(preview.error);
  // Each new file on its own, never the folder.
  expect(preview.preview.changedFiles).toEqual(["lib/b.ts", "lib/deep/a.ts"]);
  const before = headOf(chat.clone);
  writeFileSync(join(chat.clone, "lib", "deep", "a.ts"), "export const a = 2; // not what was previewed\n");
  const shipped = executeDirectChatShip(chat.store, { stateRoot: chat.stateRoot, owner: "alex", threadId: chat.threadId, mode: "keep-branch", termsDigest: preview.preview.termsDigest });
  expect(shipped).toMatchObject({ ok: false, status: 409, code: "terms_changed" });
  expect(headOf(chat.clone)).toBe(before);
  // A new file inside the folder changes it too.
  const again = previewDirectChatShip(chat.store, { stateRoot: chat.stateRoot, owner: "alex", threadId: chat.threadId });
  if (!again.ok) throw Error(again.error);
  writeFileSync(join(chat.clone, "lib", "deep", "c.ts"), "export const c = 1;\n");
  expect(executeDirectChatShip(chat.store, { stateRoot: chat.stateRoot, owner: "alex", threadId: chat.threadId, mode: "keep-branch", termsDigest: again.preview.termsDigest }))
    .toMatchObject({ ok: false, code: "terms_changed" });
  expect(headOf(chat.clone)).toBe(before);
});

test("the control: an unchanged preview ships exactly the previewed files", async () => {
  const chat = await chatWith();
  mkdirSync(join(chat.clone, "lib"), { recursive: true });
  writeFileSync(join(chat.clone, "lib", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(chat.clone, "README.md"), "# App\nMore\n");
  const preview = previewDirectChatShip(chat.store, { stateRoot: chat.stateRoot, owner: "alex", threadId: chat.threadId });
  if (!preview.ok) throw Error(preview.error);
  const shipped = executeDirectChatShip(chat.store, { stateRoot: chat.stateRoot, owner: "alex", threadId: chat.threadId, mode: "keep-branch", termsDigest: preview.preview.termsDigest });
  if (!shipped.ok) throw Error(shipped.error);
  const files = execFileSync("git", ["-C", chat.clone, "diff", "--name-only", `${shipped.ship.baseSha}`, shipped.ship.candidateSha], { env: GIT_ENV, encoding: "utf8" }).trim().split("\n").sort();
  expect(files).toEqual(["README.md", "lib/a.ts"]);
  expect(execFileSync("git", ["-C", chat.clone, "show", `${shipped.ship.candidateSha}:lib/a.ts`], { env: GIT_ENV, encoding: "utf8" })).toBe("export const a = 1;\n");
});
