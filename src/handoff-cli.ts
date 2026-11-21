/**
 * `toolroll handoff pull <task>` / `toolroll handoff push [<task>]`:
 * Pull a central task's changes into an isolated local git worktree (never touching your dirty working tree),
 * then upload a verified, bounded patch candidate back to the central task.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { centralProfile, serviceOrigin, type ConnectOptions } from "./connect-cli.js";
import { MAX_HANDOFF_PATCH_BYTES, validateHandoffPatch } from "./local-handoff.js";

const HELP = `toolroll handoff pull <task> [--repo <local-dir>] [--profile <name>]
  Open a central task's code in an isolated local git worktree (never touches your dirty checkout).
toolroll handoff push [<task>] [--note "<summary>"] [--profile <name>]
  Upload your local handoff diff back to the central task as an unverified revision candidate.`;

type HandoffMeta = {
  workspaceId: string;
  recoveryGeneration: string;
  taskId: string;
  baseCommit: string | null;
  origin: string;
  profile: string;
};

type HandoffPullResponse = {
  ok: boolean;
  message?: string;
  workspaceId?: string;
  recoveryGeneration?: string;
  taskId?: string;
  title?: string;
  projectName?: string;
  baseCommit?: string | null;
  patch?: string;
  patchTruncated?: boolean;
};

type HandoffPushResponse = {
  ok: boolean;
  message?: string;
  candidateId?: string;
  taskId?: string;
  files?: string[];
  trust?: string;
};

function httpJson<T>(
  method: "GET" | "POST",
  origin: string,
  path: string,
  token: string,
  pins: { workspaceId?: string | undefined; recoveryGeneration?: string | undefined } = {},
  body?: unknown,
): Promise<{ status: number; data: T | null }> {
  const safeOrigin = serviceOrigin(origin);
  const url = new URL(path, safeOrigin);
  const reqFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    ...(pins.workspaceId !== undefined ? { "x-toolroll-workspace": pins.workspaceId } : {}),
    ...(pins.recoveryGeneration !== undefined ? { "x-toolroll-recovery": pins.recoveryGeneration } : {}),
    ...(serialized === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(serialized)) }),
  };
  return new Promise((resolve, reject) => {
    const req = reqFn(url, { method, headers, timeout: 30_000 }, res => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        resolve({ status, data: null });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_HANDOFF_PATCH_BYTES + 128 * 1024) { req.destroy(); resolve({ status, data: null }); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          resolve({ status, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T });
        } catch {
          resolve({ status, data: null });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out.")); });
    if (serialized !== undefined) req.write(serialized);
    req.end();
  });
}

function gitRun(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: MAX_HANDOFF_PATCH_BYTES + 1024 * 1024 }).trim();
}

function gitDirOf(cwd: string): string {
  const raw = gitRun(cwd, ["rev-parse", "--git-dir"]);
  return raw.startsWith("/") ? raw : join(cwd, raw);
}

function gitCommonDirOf(cwd: string): string {
  const raw = gitRun(cwd, ["rev-parse", "--git-common-dir"]);
  return raw.startsWith("/") ? raw : join(cwd, raw);
}

export async function maybeRunHandoffCommand(
  argv: readonly string[],
  write: (line: string) => void,
  options: ConnectOptions & { cwd?: string } = {},
): Promise<number | null> {
  if (argv[0] !== "handoff") return null;
  const sub = argv[1];
  if (sub === undefined || sub === "--help" || sub === "-h" || argv.includes("--help")) {
    write(HELP);
    return 0;
  }
  const rest = argv.slice(2);
  let profileName: string | undefined;
  let repoFlag: string | undefined;
  let note = "";
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--profile" || arg === "--repo" || arg === "--note") {
      const next = rest[++i];
      if (!next) { write(`${arg} needs a value.`); return 2; }
      if (arg === "--profile") profileName = next;
      else if (arg === "--repo") repoFlag = next;
      else note = next;
      continue;
    }
    if (arg.startsWith("-")) { write(`Unknown option: ${arg}`); return 2; }
    positionals.push(arg);
  }
  let profile: ReturnType<typeof centralProfile>;
  try { profile = centralProfile(options, profileName); } catch (error) {
    write(error instanceof Error ? error.message : "Could not read remote profile.");
    return 2;
  }
  if (profile === null || !profile.apiToken) {
    write("Connect to a central server with an API token first: toolroll connect <https://origin> --as <account> --token-stdin");
    return 2;
  }
  const cwd = options.cwd ?? process.cwd();

  if (sub === "pull") {
    const taskId = positionals[0];
    if (!taskId) { write("Name a task id: toolroll handoff pull <task>"); return 2; }
    let localRepo: string;
    try { localRepo = realpathSync(gitRun(repoFlag ?? cwd, ["rev-parse", "--show-toplevel"])); } catch {
      write("Run this inside a local Git checkout of the project, or pass --repo <local-dir>.");
      return 2;
    }
    const reply = await httpJson<HandoffPullResponse>(
      "GET",
      profile.origin,
      `/api/handoff/task/${encodeURIComponent(taskId)}`,
      profile.token,
      { workspaceId: profile.workspaceId, recoveryGeneration: profile.recoveryGeneration },
    );
    if (reply.status !== 200 || reply.data === null || !reply.data.ok) {
      write(reply.data?.message ?? `Central server answered status ${reply.status}.`);
      return 1;
    }
    const info = reply.data;
    if (profile.workspaceId !== undefined && info.workspaceId !== profile.workspaceId) {
      write("Refused: central server workspace identity does not match your saved profile.");
      return 1;
    }
    const common = gitCommonDirOf(localRepo);
    const poolDir = join(common, "toolroll-handoff");
    mkdirSync(poolDir, { recursive: true, mode: 0o700 });
    const safeTask = taskId.replace(/[^A-Za-z0-9_.-]/g, "-");
    const worktree = join(poolDir, safeTask);
    if (existsSync(worktree)) {
      write(`Handoff worktree already exists:\n  cd ${worktree}`);
      return 0;
    }
    const startRef = (info.baseCommit ? (() => {
      try { gitRun(localRepo, ["cat-file", "-e", `${info.baseCommit}^{commit}`]); return info.baseCommit; } catch { return null; }
    })() : null) ?? "HEAD";
    const branch = `toolroll/handoff/${safeTask}`;
    try {
      gitRun(localRepo, ["worktree", "add", "-B", branch, "--", worktree, startRef]);
    } catch (error) {
      write(`Could not create isolated handoff worktree: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const baseAtCreate = gitRun(worktree, ["rev-parse", "HEAD"]);
    if (info.patch && info.patch.trim() !== "") {
      const patchFile = join(gitDirOf(worktree), "central-initial.patch");
      writeFileSync(patchFile, info.patch, { mode: 0o600 });
      try {
        execFileSync("git", ["-C", worktree, "apply", "--3way", "--", patchFile], { stdio: "pipe" });
      } catch {
        rmSync(patchFile, { force: true });
        write(`Created isolated worktree at ${worktree}, but central patch could not auto-apply cleanly (base ${startRef}).`);
      }
      rmSync(patchFile, { force: true });
    }
    const meta: HandoffMeta = {
      workspaceId: info.workspaceId ?? "",
      recoveryGeneration: info.recoveryGeneration ?? "",
      taskId: info.taskId ?? taskId,
      baseCommit: info.baseCommit ?? baseAtCreate,
      origin: profile.origin,
      profile: profile.name,
    };
    writeFileSync(join(gitDirOf(worktree), "toolroll-handoff.json"), JSON.stringify(meta, null, 2), { mode: 0o600 });
    write(`Opened task ${meta.taskId} (${info.title ?? "task"}) in an isolated local worktree (your main checkout was untouched):`);
    write(`  cd ${worktree}`);
    write(`When ready, push your changes back with:`);
    write(`  toolroll handoff push --note "Updated locally"`);
    return 0;
  }

  if (sub === "push") {
    let worktreeRoot: string;
    try { worktreeRoot = realpathSync(gitRun(repoFlag ?? cwd, ["rev-parse", "--show-toplevel"])); } catch {
      write("Run this inside your local handoff worktree (or pass --repo <worktree>).");
      return 2;
    }
    const metaPath = join(gitDirOf(worktreeRoot), "toolroll-handoff.json");
    let meta: HandoffMeta | null = null;
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(readFileSync(metaPath, "utf8")) as HandoffMeta; } catch { meta = null; }
    }
    const taskId = positionals[0] ?? meta?.taskId;
    if (!taskId) {
      write("Not inside a handoff worktree. Name the task id: toolroll handoff push <task>");
      return 2;
    }
    if (meta !== null && meta.workspaceId !== "" && profile.workspaceId !== undefined && meta.workspaceId !== profile.workspaceId) {
      write("Refused: this handoff worktree belongs to a different central workspace than your active profile.");
      return 1;
    }
    const baseCommit = meta?.baseCommit ?? gitRun(worktreeRoot, ["rev-parse", "HEAD"]);
    // Include both committed work on the handoff branch and unstaged edits against baseCommit.
    const patch = execFileSync("git", ["-C", worktreeRoot, "diff", baseCommit], { encoding: "utf8", maxBuffer: MAX_HANDOFF_PATCH_BYTES + 1024 * 1024 });
    const checked = validateHandoffPatch(patch);
    if (!checked.ok) {
      write(`Cannot upload local diff: ${checked.error}`);
      return 1;
    }
    const reply = await httpJson<HandoffPushResponse>(
      "POST",
      profile.origin,
      `/api/handoff/task/${encodeURIComponent(taskId)}/candidate`,
      profile.token,
      {
        workspaceId: meta?.workspaceId || profile.workspaceId,
        recoveryGeneration: meta?.recoveryGeneration || profile.recoveryGeneration,
      },
      { patch, baseCommit, note },
    );
    if (reply.status !== 201 || reply.data === null || !reply.data.ok) {
      write(reply.data?.message ?? `Central server refused candidate upload (status ${reply.status}).`);
      return 1;
    }
    write(`Uploaded local candidate ${reply.data.candidateId} to task ${reply.data.taskId} (${checked.files.length} files, unverified — ready for central checks/review).`);
    return 0;
  }

  write(`Unknown handoff action: ${sub}\n${HELP}`);
  return 2;
}
