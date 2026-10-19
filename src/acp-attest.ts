/**
 * An ACP agent's admission (docs/plans/acp-adapter.md § Admission): it runs only on a passed conformance check of the
 * exact binary on this runner, recorded as an attestation. Absence is denial.
 *
 * The record says how to launch that binary — a native launcher directly, a script through the interpreter its
 * shebang named, resolved once at the check and pinned (the child's PATH never chooses it) — and binds every file
 * that launch depends on: the launcher, the interpreter, and for a package its package.json and entry. Each binding
 * keeps the file's stat tuple and sha256. At spawn, after all asynchronous setup, every binding is checked again: a
 * changed stat is re-hashed, and the spawn refuses unless every hash still matches.
 *
 * What it proves, exactly: the bytes of those files are the bytes that passed the check, as of the re-check
 * immediately before spawn. Not an exclusive lock on the paths: a writer racing the narrow window between that re-check
 * and exec is not excluded (Node has no exec-by-descriptor), the same residual the version attestation states. Nor the
 * agent's other files (a bundle's chunks, its plugins): those are its configuration surface. The environment
 * variables that make an interpreter load other code are shed at every ACP launch (INTERPRETER_INJECTION_ENV).
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/** What makes an interpreter load code beside the script it was given: never passed to an ACP launch. */
export const INTERPRETER_INJECTION_ENV: readonly string[] = [
  "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "PYTHONINSPECT",
  "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "PERLLIB", "BUN_OPTIONS", "DENO_DIR", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
];

/** Bumped whenever the conformance probe changes what it proves: every attestation made under another version is void. */
export const ACP_CONFORMANCE_VERSION = 1;

export type FileBinding = {
  role: "launcher" | "interpreter" | "package" | "entry";
  path: string;
  sha256: string;
  dev: number;
  ino: number;
  ctimeMs: number;
  size: number;
};

/** How the attested binary is started, and every file that start depends on. */
export type AcpLaunch = {
  /** What is executed: the launcher itself, or the pinned interpreter. */
  file: string;
  /** Arguments before the agent's own ACP argv: a script's shebang arguments and the script itself. */
  prefix: string[];
  bindings: FileBinding[];
};

const READ_CAP = 64 * 1024;
const HASH_CHUNK = 1024 * 1024;

/** sha256 of a regular file, read without following a final symlink. */
export function hashFile(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(HASH_CHUNK);
    for (;;) {
      const read = readSync(fd, buffer, 0, HASH_CHUNK, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function head(path: string, cap: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(cap);
    return buffer.subarray(0, readSync(fd, buffer, 0, cap, 0));
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function bind(role: FileBinding["role"], path: string): FileBinding | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    const sha256 = hashFile(path);
    if (sha256 === null) return null;
    return { role, path, sha256, dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function isNative(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const magic = bytes.readUInt32BE(0);
  return magic === 0x7f454c46 || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
}

/** A name found on a PATH, by realpath; only absolute PATH entries count. */
function onPath(name: string, path: string): string | null {
  for (const folder of path.split(delimiter)) {
    if (folder === "" || !isAbsolute(folder)) continue;
    try {
      const real = realpathSync(join(folder, name));
      const stat = statSync(real);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return real;
    } catch {
      continue;
    }
  }
  return null;
}

/** The interpreter and its arguments a shebang line names — `#!/abs/interp [arg]` or `#!/usr/bin/env [-S] name [args]` — or null. */
export function parseShebang(line: string, path: string): { interpreter: string; args: string[] } | null {
  if (!line.startsWith("#!")) return null;
  const words = line.slice(2).trim().split(/\s+/).filter(one => one !== "");
  const [first, ...rest] = words;
  if (first === undefined || !isAbsolute(first)) return null;
  if (first === "/usr/bin/env" || first === "/bin/env") {
    const named = rest[0] === "-S" ? rest.slice(1) : rest;
    const [name, ...args] = named;
    if (name === undefined || name.includes("/") || name.startsWith("-") || name.includes("=")) return null;
    const interpreter = onPath(name, path);
    return interpreter === null ? null : { interpreter, args };
  }
  if (rest.length > 1) return null;
  try {
    return { interpreter: realpathSync(first), args: rest };
  } catch {
    return null;
  }
}

/** The nearest package.json above a script and the file its `bin`/`main` names, when that is not the launcher. */
function packageBindings(launcher: string): FileBinding[] | null {
  let folder = dirname(launcher);
  for (let depth = 0; depth < 6; depth += 1) {
    const file = join(folder, "package.json");
    const bytes = head(file, READ_CAP);
    if (bytes !== null) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; } catch { return null; }
      const pkg = bind("package", file);
      if (pkg === null) return null;
      const bins = typeof parsed["bin"] === "string" ? [parsed["bin"]] : parsed["bin"] !== null && typeof parsed["bin"] === "object" ? Object.values(parsed["bin"] as Record<string, unknown>) : [];
      const entries = [...bins, parsed["main"]].filter((one): one is string => typeof one === "string");
      const out = [pkg];
      for (const entry of new Set(entries)) {
        let real: string;
        try { real = realpathSync(join(folder, entry)); } catch { continue; }
        if (real === launcher) continue;
        const bound = bind("entry", real);
        if (bound !== null) out.push(bound);
      }
      return out;
    }
    const up = dirname(folder);
    if (up === folder) break;
    folder = up;
  }
  return [];
}

/**
 * How to launch a binary found at `launcher` (a realpath), with every file bound — or why it can't be. `path` is the
 * PATH a `#!/usr/bin/env name` shebang is resolved on, once, here.
 */
export function launchOf(launcher: string, path: string): AcpLaunch | { problem: string } {
  const bytes = head(launcher, 4096);
  if (bytes === null) return { problem: `${launcher} can't be read` };
  const self = bind("launcher", launcher);
  if (self === null) return { problem: `${launcher} can't be read` };
  if (isNative(bytes)) return { file: launcher, prefix: [], bindings: [self] };
  const first = bytes.toString("utf8").split("\n")[0] ?? "";
  const shebang = parseShebang(first, path);
  if (shebang === null) return { problem: `${launcher} is neither a native program nor a script whose interpreter can be pinned (unsupported-launcher)` };
  const interpreterBytes = head(shebang.interpreter, 4096);
  if (interpreterBytes === null || !isNative(interpreterBytes)) return { problem: `${shebang.interpreter}, which runs ${launcher}, is not a native program (unsupported-launcher)` };
  const interpreter = bind("interpreter", shebang.interpreter);
  const pkg = packageBindings(launcher);
  if (interpreter === null || pkg === null) return { problem: `the files ${launcher} runs from can't all be read` };
  return { file: shebang.interpreter, prefix: [...shebang.args, launcher], bindings: [self, interpreter, ...pkg] };
}

/** Whether every bound file is still the one that passed: same stat, or on any change the same sha256. */
export function verifyLaunch(launch: AcpLaunch): { ok: true } | { ok: false; problem: string } {
  for (const binding of launch.bindings) {
    let stat;
    try {
      if (lstatSync(binding.path).isSymbolicLink()) return { ok: false, problem: `${binding.path} became a link since the check` };
      stat = statSync(binding.path);
    } catch {
      return { ok: false, problem: `${binding.path} is gone since the check` };
    }
    if (stat.dev === binding.dev && stat.ino === binding.ino && stat.ctimeMs === binding.ctimeMs && stat.size === binding.size) continue;
    if (hashFile(binding.path) !== binding.sha256) return { ok: false, problem: `${binding.path} changed since the check — check the agent again` };
  }
  return { ok: true };
}

/** A stored launch, read strictly: anything this code never writes reads as null. */
export function launchFromJson(json: string): AcpLaunch | null {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value["file"] !== "string" || !isAbsolute(value["file"])) return null;
  if (!Array.isArray(value["prefix"]) || !value["prefix"].every(one => typeof one === "string")) return null;
  if (!Array.isArray(value["bindings"]) || value["bindings"].length === 0) return null;
  const bindings: FileBinding[] = [];
  for (const one of value["bindings"]) {
    if (one === null || typeof one !== "object") return null;
    const b = one as Record<string, unknown>;
    if (!["launcher", "interpreter", "package", "entry"].includes(String(b["role"]))) return null;
    if (typeof b["path"] !== "string" || !isAbsolute(b["path"]) || typeof b["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(b["sha256"])) return null;
    if (![b["dev"], b["ino"], b["ctimeMs"], b["size"]].every(n => typeof n === "number" && Number.isFinite(n))) return null;
    bindings.push({ role: b["role"] as FileBinding["role"], path: b["path"], sha256: b["sha256"], dev: b["dev"] as number, ino: b["ino"] as number, ctimeMs: b["ctimeMs"] as number, size: b["size"] as number });
  }
  if (bindings[0]?.role !== "launcher") return null;
  // What is executed is a bound file — the launcher itself, or the bound interpreter with the launcher as its script
  // — and nothing a stored row could point elsewhere.
  const launcher = bindings[0].path;
  const prefix = value["prefix"] as string[];
  if (value["file"] === launcher) {
    if (prefix.length !== 0) return null;
  } else {
    const interpreter = bindings.find(one => one.role === "interpreter");
    if (interpreter === undefined || interpreter.path !== value["file"] || prefix[prefix.length - 1] !== launcher) return null;
  }
  return { file: value["file"], prefix, bindings };
}
