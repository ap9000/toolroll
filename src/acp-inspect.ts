/**
 * What can be known about an ACP agent's binary without running it
 * (docs/plans/acp-adapter.md § Identity): nothing outside the one spawning
 * gateway executes an ACP agent — not readiness, not the providers screen,
 * not a version probe. So readiness and the screens look, and never run:
 * PATH lookup, realpath, lstat, and for a script launcher a bounded read of
 * the nearest package.json for its name and version.
 *
 * None of this is evidence an agent may run. That is its conformance check
 * (attestation), which this only helps describe.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { ACP_AGENTS, type AcpProviderId } from "./acp-agents.js";

/** The most bytes read from a launcher (its first line) or a package.json. */
const READ_CAP = 64 * 1024;
/** How many folders up from the launcher a package.json is looked for. */
const PACKAGE_DEPTH = 6;

export type AcpInspection =
  | { found: false; binary: string }
  | {
      found: true;
      binary: string;
      /** The PATH entry that matched, and where it really is. */
      path: string;
      realpath: string;
      /** A native executable (Mach-O/ELF), or a script with a shebang line. */
      kind: "native" | "script" | "unknown";
      /** For a script: the nearest package.json's name and version, read, never run. */
      package: { name: string; version: string } | null;
      size: number;
    };

/** Read at most `cap` bytes from the start of a regular file, without following a final symlink. */
function readHead(file: string, cap: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(cap);
    const read = readSync(fd, buffer, 0, cap, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function kindOf(head: Buffer | null): "native" | "script" | "unknown" {
  if (head === null || head.length < 4) return "unknown";
  if (head[0] === 0x23 && head[1] === 0x21) return "script"; // "#!"
  const magic = head.readUInt32BE(0);
  // ELF, Mach-O (both byte orders, 32/64-bit) and fat binaries.
  if (magic === 0x7f454c46 || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) return "native";
  return "unknown";
}

/** The nearest package.json above a script, by bounded read; its name and plain version, or null. */
function packageOf(realpath: string): { name: string; version: string } | null {
  let folder = dirname(realpath);
  for (let depth = 0; depth < PACKAGE_DEPTH; depth += 1) {
    const head = readHead(join(folder, "package.json"), READ_CAP);
    if (head !== null) {
      try {
        const parsed = JSON.parse(head.toString("utf8")) as Record<string, unknown>;
        const name = parsed["name"];
        const version = parsed["version"];
        if (typeof name === "string" && typeof version === "string" && name.length <= 214 && /^\d+\.\d+\.\d+$/.test(version)) return { name, version };
      } catch {
        // A package.json past the cap or not JSON says nothing.
      }
      return null;
    }
    const up = dirname(folder);
    if (up === folder) break;
    folder = up;
  }
  return null;
}

/** Find an agent's binary on PATH, and describe it without running it. */
export function inspectAcpAgent(provider: AcpProviderId, env: Readonly<Record<string, string | undefined>> = process.env): AcpInspection {
  const binary = ACP_AGENTS[provider].binary;
  for (const folder of (env["PATH"] ?? "").split(delimiter)) {
    if (folder === "" || !isAbsolute(folder)) continue;
    const path = join(folder, binary);
    try {
      lstatSync(path);
    } catch {
      continue;
    }
    let realpath: string;
    try {
      realpath = realpathSync(path);
      const stat = statSync(realpath);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
      const head = readHead(realpath, 4096);
      const kind = kindOf(head);
      return { found: true, binary, path, realpath, kind, package: kind === "script" ? packageOf(realpath) : null, size: stat.size };
    } catch {
      continue;
    }
  }
  return { found: false, binary };
}

/** The words a screen says for an inspection: "installed at …, version …" or "not installed". */
export function inspectionWords(inspection: AcpInspection): string {
  if (!inspection.found) return `\`${inspection.binary}\` is not installed on this computer's PATH`;
  const version = inspection.package === null ? "" : ` (${inspection.package.name} ${inspection.package.version})`;
  return `installed at ${inspection.realpath}${version}`;
}
