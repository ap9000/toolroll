/**
 * The programs the Linux sandbox itself runs (sandbox-runtime.ts, sandbox-launch.ts), each handed to Anthropic's
 * sandbox-runtime by an exact path Toolroll has checked, never a name it looks up on PATH: a person's or a test's PATH
 * never changes which bubblewrap fences a launch.
 *
 * - bwrap, socat, bash, rg, and the `which` the runtime still runs to look up the shell it is handed: root's own
 *   (trusted-path.ts rootOwnedBinary: the canonical target a regular file owned by root, not group- or world-writable,
 *   every folder above it the same), found only in SANDBOX_TOOL_FOLDERS. A copy in ~/.cargo/bin or a Homebrew prefix
 *   is never looked at; the person is told to install it from the system's package manager.
 * - the runtime's seccomp helper (apply-seccomp): exactly the copy in Toolroll's own installed sandbox-runtime package,
 *   vendor/seccomp/<arch>/apply-seccomp, never `npm root -g`, a user npm folder or PATH. Its canonical target (through
 *   any vendor link) and every folder above it are owned by root or by the owner of Toolroll's own code, none of them
 *   group- or world-writable (no sticky pass). Root's own throughout, it serves any launch. Otherwise (a user's npm
 *   install, CI's checkout) its write protection must be the same as Toolroll's code's: its canonical target lies inside
 *   the install-tree write denies that cover the code (agent-fence.ts toolrollInstall, the vendor link's target folder
 *   included), and the launch may not write that target (its write roots `/` and the literal ones counted).
 *
 *   Shared residual, stated once for both: on a user-owned install, a launch that may write the install's parent
 *   folders could swap Toolroll's code and its seccomp helper alike (rename a folder above the denied one and put
 *   another in its place). The inode pinning below makes a swap after discovery refuse the next launch, but a fresh
 *   discovery would take the new one. Use a root-owned install for write-anywhere builds.
 *
 * No system program may lie inside the launch's projects, worktrees or Toolroll's state. Discovery is cached; before each launch every path is canonicalized again and the whole check re-run, and its file must still be
 * the one discovered (device and inode): any change refuses that launch, and the next one discovers afresh.
 */
import { accessSync, constants as fsConstants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SrtTerms } from "./sandbox-runtime.js";
import { platformAcl, rootOwnedBinary, rootOwnedFolders, type AclReader } from "./trusted-path.js";

/** The only folders the system programs are looked for in, in this order. */
export const SANDBOX_TOOL_FOLDERS: readonly string[] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/run/current-system/sw/bin"];
const SYSTEM_TOOLS = [
  { key: "bwrap", command: "bwrap", words: "bubblewrap (bwrap)", install: "bubblewrap" },
  { key: "socat", command: "socat", words: "socat", install: "socat" },
  { key: "bash", command: "bash", words: "bash", install: "bash" },
  { key: "rg", command: "rg", words: "ripgrep (rg)", install: "ripgrep" },
  { key: "which", command: "which", words: "which", install: "which" },
] as const;
type SystemKey = typeof SYSTEM_TOOLS[number]["key"];
const KEYS = [...SYSTEM_TOOLS.map(tool => tool.key), "seccomp"] as const;

/** One program: its canonical path and the file it was (device:inode) when it was checked. */
export type SandboxTool = { real: string; id: string };
/** Every program, and for `which` the root-owned folder the runtime's PATH lookup goes through. */
export type LinuxSandboxTools = Record<SystemKey | "seccomp", SandboxTool> & { whichFolder: string };
export type LinuxSandboxToolsVerdict = { ok: true; tools: LinuxSandboxTools } | { ok: false; why: string };
/** Who counts as root and as the owner of Toolroll's own code: the real ones, except where a test stands its uid in. */
export type ToolTrust = { root?: readonly number[]; codeOwner?: number; acl?: AclReader | null; seccomp?: string | null };

const insideOrAt = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
const realOrSelf = (path: string): string => { try { return realpathSync(path); } catch { return path; } };
const require = createRequire(import.meta.url);

/** The seccomp helper Toolroll's own installed sandbox-runtime ships for this processor, or null where it ships none. */
export function seccompHelperPath(arch: string = process.arch): string | null {
  const vendor = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (vendor === null) return null;
  try { return join(dirname(require.resolve("@anthropic-ai/sandbox-runtime")), "..", "vendor", "seccomp", vendor, "apply-seccomp"); } catch { return null; }
}

/** The owner of the code running now (this module's own file), or undefined when it can't be read. */
function codeOwnerNow(): number | undefined {
  try { return lstatSync(realpathSync(fileURLToPath(import.meta.url))).uid; } catch { return undefined; }
}

/**
 * Where no sandbox program may be, from a launch's terms: `all`, its working folder, write roots and fence denies (the
 * launch's projects, worktrees and Toolroll's state; no system program inside one), and `writes`, what the launch may
 * write: inside one of `allow` (its write roots, `/` and the literal ones included) and inside none of `deny` (its write
 * denies, the install tree's among them). None given: no launch (a discovery, a "can this computer sandbox" check).
 */
export type ToolExclusions = { all: readonly string[]; writes?: { allow: readonly string[]; deny: readonly string[] } };
const NO_EXCLUSIONS: ToolExclusions = { all: [] };

const withReal = (paths: readonly string[]) => [...new Set(paths.flatMap(path => [path, realOrSelf(path)]))];

export function sandboxToolExclusions(terms: SrtTerms, cwd: string): ToolExclusions {
  const write = terms.writeConfig;
  const roots = (paths: readonly string[]) => withReal(paths.map(path => path.replace(/\/?\*.*$/, "")).filter(path => path !== "" && path !== "/" && path.startsWith("/")));
  // An allowed pattern counts as its whole folder (more is writable, never less); a denied pattern covers nothing
  // for certain, so it protects nothing here.
  const allow = withReal([...write.allowOnly, ...write.literalAllowOnly ?? []].map(path => path.includes("*") ? dirname(path.replace(/\*.*$/, "x")) : path).filter(path => path.startsWith("/")));
  const deny = withReal([...write.denyWithinAllow, ...write.literalDenyWithinAllow ?? []].filter(path => path.startsWith("/") && !path.includes("*")));
  return { all: roots([cwd, ...write.allowOnly, ...write.literalAllowOnly ?? [], ...write.denyWithinAllow, ...terms.readConfig.denyOnly]), writes: { allow, deny } };
}

/** Whether a launch with these writes may write `path`. */
const mayWrite = (writes: NonNullable<ToolExclusions["writes"]>, path: string): boolean =>
  writes.allow.some(root => insideOrAt(path, root)) && !writes.deny.some(root => insideOrAt(path, root));

const installWords = (pkg: string): string =>
  `install ${pkg} from your system package manager (sudo apt install ${pkg}; Fedora: sudo dnf install ${pkg})`;

type Trust = { root: readonly number[]; codeOwner: number | undefined; acl: AclReader | null };
type Checked = { ok: true; tool: SandboxTool } | { ok: false; why: string };

/** Runnable, and the file it is now. */
function identify(real: string): Checked {
  try {
    accessSync(real, fsConstants.X_OK);
    const file = statSync(real);
    return { ok: true, tool: { real, id: `${file.dev}:${file.ino}` } };
  } catch { return { ok: false, why: `${real} can't be run` }; }
}

/** The full check of one system program at `path`: root's own, in none of `exclusions`. Its canonical path and file, or why not. */
function checkSystem(path: string, trust: Trust, exclusions: ToolExclusions): Checked {
  const checked = rootOwnedBinary(path, trust.acl, trust.root);
  if (!checked.ok) return checked;
  if (exclusions.all.some(root => insideOrAt(checked.real, root))) return { ok: false, why: `${checked.real} is inside a project, worktree or Toolroll's own folder` };
  return identify(checked.real);
}

/**
 * The full check of the seccomp helper at `path` for a launch with `exclusions` (see the header): its canonical target
 * and every folder above it owned by root or the code's owner, none group- or world-writable; and unless root's own
 * throughout, the target inside the launch's write denies (the install tree's) and not writable by it. Its folders
 * above are held to no more than the code's are (the shared residual in the header).
 */
export function checkSeccompHelper(path: string, exclusions: ToolExclusions, trust: ToolTrust = {}): Checked {
  const t = trustOf(trust);
  const owners = t.codeOwner === undefined ? t.root : [...t.root, t.codeOwner];
  const checked = rootOwnedBinary(path, t.acl, owners, "root or Toolroll's own user");
  if (!checked.ok) return checked;
  const writes = exclusions.writes;
  if (writes !== undefined && !rootOwnedBinary(checked.real, t.acl, t.root).ok) {
    if (mayWrite(writes, checked.real)) return { ok: false, why: `the launch may write ${checked.real}, and the helper isn't root's own` };
    if (!writes.deny.some(root => insideOrAt(checked.real, root))) return { ok: false, why: `the fence's install-tree write denies don't cover ${checked.real}` };
  }
  return identify(checked.real);
}

const trustOf = (trust: ToolTrust): Trust => ({ root: trust.root ?? [0], codeOwner: "codeOwner" in trust ? trust.codeOwner : codeOwnerNow(), acl: "acl" in trust ? trust.acl ?? null : platformAcl() });

/**
 * Find each program (see the header) in `folders`, checked in full. A copy that fails is passed over, never used; when
 * none passes for some program, the plain reason, with what to install, and nothing to fall back on.
 */
export function resolveLinuxSandboxTools(options: ToolTrust & { folders?: readonly string[]; exclusions?: ToolExclusions } = {}): LinuxSandboxToolsVerdict {
  const folders = options.folders ?? SANDBOX_TOOL_FOLDERS;
  const exclusions = options.exclusions ?? NO_EXCLUSIONS;
  const trust = trustOf(options);
  const found: Partial<Record<SystemKey | "seccomp", SandboxTool>> = {};
  let whichFolder: string | null = null;
  for (const tool of SYSTEM_TOOLS) {
    const passedOver: string[] = [];
    for (const folder of folders) {
      const candidate = join(folder, tool.command);
      if (!existsSync(candidate)) continue;
      const checked = checkSystem(candidate, trust, exclusions);
      if (!checked.ok) { passedOver.push(`${candidate}: ${checked.why}`); continue; }
      if (tool.key === "which") {
        // The runtime finds `which` by name: the folder its PATH will name must be root's own too.
        const dir = rootOwnedFolders(folder, trust.acl, trust.root);
        if (!dir.ok) { passedOver.push(`${candidate}: ${dir.why}`); continue; }
        whichFolder = dir.real;
      }
      found[tool.key] = checked.tool;
      break;
    }
    if (found[tool.key] === undefined) {
      return { ok: false, why: `${tool.words} has no copy owned by root in ${folders.join(", ")}${passedOver.length === 0 ? "" : ` (${passedOver.join("; ")})`}: ${installWords(tool.install)}` };
    }
  }
  const helper = "seccomp" in options ? options.seccomp ?? null : seccompHelperPath();
  if (helper === null) return { ok: false, why: `the sandbox runtime's seccomp helper isn't available for this processor (${process.arch})` };
  const checked = checkSeccompHelper(helper, exclusions, options);
  if (!checked.ok) return { ok: false, why: `the sandbox runtime's seccomp helper (${helper}) can't be trusted: ${checked.why}` };
  found.seccomp = checked.tool;
  return { ok: true, tools: { ...(found as Record<SystemKey | "seccomp", SandboxTool>), whichFolder: whichFolder! } };
}

/**
 * The same programs, checked in full again right now: each canonical path the same, each still passing its check, each
 * still the file discovered, `which` still the one in its folder, the seccomp helper still Toolroll's own package's.
 * Why not, or null.
 */
export function verifyLinuxSandboxTools(tools: LinuxSandboxTools, options: ToolTrust & { exclusions?: ToolExclusions } = {}): string | null {
  const trust = trustOf(options);
  const exclusions = options.exclusions ?? NO_EXCLUSIONS;
  for (const key of KEYS) {
    const tool = tools[key];
    const checked = key === "seccomp" ? checkSeccompHelper(tool.real, exclusions, options) : checkSystem(tool.real, trust, exclusions);
    if (!checked.ok) return `${key} (${tool.real}): ${checked.why}`;
    if (checked.tool.real !== tool.real || checked.tool.id !== tool.id) return `${key} (${tool.real}) changed since it was checked`;
  }
  const helper = "seccomp" in options ? options.seccomp ?? null : seccompHelperPath();
  if (helper === null || realOrSelf(helper) !== tools.seccomp.real) return `the seccomp helper (${tools.seccomp.real}) isn't Toolroll's own sandbox-runtime's`;
  const dir = rootOwnedFolders(tools.whichFolder, trust.acl, trust.root);
  if (!dir.ok || dir.real !== tools.whichFolder) return `which's folder (${tools.whichFolder}) ${dir.ok ? "changed" : dir.why}`;
  if (realOrSelf(join(tools.whichFolder, "which")) !== tools.which.real) return `which in ${tools.whichFolder} changed since it was checked`;
  return null;
}

/** Whether `value` has the shape of LinuxSandboxTools (a launch spec's, read back from the environment). */
export function isLinuxSandboxTools(value: unknown): value is LinuxSandboxTools {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const path = (one: unknown) => typeof one === "string" && one.startsWith("/") && !/[\u0000-\u001f\u007f]/.test(one);
  if (!path(record["whichFolder"])) return false;
  return KEYS.every(key => {
    const tool = record[key] as Record<string, unknown> | null | undefined;
    return tool !== null && typeof tool === "object" && path(tool["real"]) && typeof tool["id"] === "string" && /^\d+:\d+$/.test(tool["id"]);
  });
}

/** Discovery, once per process until a check fails (then the next launch discovers afresh). */
let discovered: LinuxSandboxTools | null = null;

/** The programs for a launch whose projects, worktrees and state are `exclusions`: discovered once, re-checked now. */
export function linuxSandboxTools(exclusions: ToolExclusions = NO_EXCLUSIONS): LinuxSandboxToolsVerdict {
  if (discovered === null) {
    const found = resolveLinuxSandboxTools();
    if (!found.ok) return found;
    discovered = found.tools;
  }
  const tools = discovered;
  const why = verifyLinuxSandboxTools(tools, { exclusions });
  if (why !== null) { discovered = null; return { ok: false, why: `a sandbox program failed its check right before the launch: ${why}` }; }
  return { ok: true, tools };
}
