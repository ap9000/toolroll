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
 *   vendor/seccomp/<arch>/apply-seccomp, never `npm root -g`, a user npm folder or PATH. It ships inside the package
 *   whose code Toolroll is running, so it is owned by root or by the owner of that code (whoever can replace it can
 *   already replace Toolroll's own JavaScript), and it and every folder above it are not group- or world-writable.
 *
 * No system program may lie inside the launch's projects, worktrees or Toolroll's state, and the seccomp helper inside
 * no folder the launch may write (sandboxToolExclusions; a launch allowed to write anywhere still can't reach root's
 * programs, but could reach a helper its user owns: the stated residual of not requiring root there). Discovery is
 * cached; before each launch every path is canonicalized again and the whole check re-run, and its file must still be
 * the one discovered (device and inode): any change refuses that launch, and the next one discovers afresh.
 */
import { accessSync, constants as fsConstants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SrtTerms } from "./sandbox-runtime.js";
import { platformAcl, rootOwnedBinary, rootOwnedFolders, trustedBinary, type AclReader } from "./trusted-path.js";

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

/** Where no sandbox program may be: `all` for the system programs, `writable` for the seccomp helper. */
export type ToolExclusions = { all: readonly string[]; writable: readonly string[] };
const NO_EXCLUSIONS: ToolExclusions = { all: [], writable: [] };

/**
 * From a launch's terms: `writable`, its write roots (all but `/`); `all`, those and its working folder and everything
 * its fence denies (the launch's projects, worktrees and Toolroll's state).
 */
export function sandboxToolExclusions(terms: SrtTerms, cwd: string): ToolExclusions {
  const roots = (paths: readonly string[]) => [...new Set(paths.map(path => path.replace(/\/?\*.*$/, ""))
    .filter(path => path !== "" && path !== "/" && path.startsWith("/"))
    .flatMap(path => [path, realOrSelf(path)]))];
  return {
    all: roots([cwd, ...terms.writeConfig.allowOnly, ...terms.writeConfig.denyWithinAllow, ...terms.readConfig.denyOnly]),
    writable: roots(terms.writeConfig.allowOnly),
  };
}

const installWords = (pkg: string): string =>
  `install ${pkg} from your system package manager (sudo apt install ${pkg}; Fedora: sudo dnf install ${pkg})`;

/** The full check of one program at `path`: its canonical path and file, or why not. */
function checkOne(path: string, rule: "root" | "code", trust: Required<Pick<ToolTrust, "root">> & { codeOwner: number | undefined; acl: AclReader | null }, exclusions: readonly string[]): { ok: true; tool: SandboxTool } | { ok: false; why: string } {
  const checked = rule === "root" ? rootOwnedBinary(path, trust.acl, trust.root) : trustedBinary(path, trust.codeOwner, trust.acl);
  if (!checked.ok) return checked;
  if (exclusions.some(root => insideOrAt(checked.real, root))) return { ok: false, why: `${checked.real} is inside a project, worktree or Toolroll's own folder` };
  try {
    accessSync(checked.real, fsConstants.X_OK);
    const file = statSync(checked.real);
    return { ok: true, tool: { real: checked.real, id: `${file.dev}:${file.ino}` } };
  } catch { return { ok: false, why: `${checked.real} can't be run` }; }
}

const trustOf = (trust: ToolTrust) => ({ root: trust.root ?? [0], codeOwner: "codeOwner" in trust ? trust.codeOwner : codeOwnerNow(), acl: "acl" in trust ? trust.acl ?? null : platformAcl() });

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
      const checked = checkOne(candidate, "root", trust, exclusions.all);
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
  const checked = checkOne(helper, "code", trust, exclusions.writable);
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
    const checked = checkOne(tool.real, key === "seccomp" ? "code" : "root", trust, key === "seccomp" ? exclusions.writable : exclusions.all);
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
