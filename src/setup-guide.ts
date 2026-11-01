/** Read-only suggestions for the shared desktop and browser setup flow. */
import { withAcp, type KeyedProviderId } from "./acp-agents.js";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validModelId, type ProviderId } from "./provider.js";
import { planInstall, applyInstall, skillContent, SKILL_DIR, SKILL_FILE } from "./skills.js";

export const ASSISTANTS: Record<ProviderId, { name: string; description: string }> = withAcp<KeyedProviderId, { name: string; description: string }>({
  claude: { name: "Claude", description: "Use Claude Code for your tasks." },
  codex: { name: "Codex", description: "Use your OpenAI coding assistant." },
  gemini: { name: "Gemini", description: "Use Google's coding assistant." },
  openrouter: { name: "OpenRouter", description: "Use a model from your OpenRouter account." },
}, agent => ({ name: agent.name, description: `Use ${agent.name} for builds, once it's checked on this computer.` }));
export type ModelChoice = { value: string; label: string };
export function modelChoices(provider: ProviderId, configured: string | null, home = homedir()): ModelChoice[] {
  // Aliases documented at https://code.claude.com/docs/en/model-config.
  let choices: ModelChoice[] = provider === "claude"
    // Exact ids first: Sonnet 5.5 builds routine tasks under "Sized by job" (Settings → Models); the short names float.
    ? [{ value: "claude-sonnet-5-5", label: "Sonnet 5.5 — routine tasks" }, { value: "claude-opus-5-5", label: "Opus 5.5 — large or risky tasks" },
      { value: "claude-haiku-5-5", label: "Haiku 5.5 — small tasks" }, { value: "sonnet", label: "Sonnet (floating) — moves to the newest version" },
      { value: "opus", label: "Opus (floating) — moves to the newest version" }, { value: "haiku", label: "Haiku (floating) — moves to the newest version" }]
    : [];
  if (provider === "codex") {
    // Use the local CLI's own catalog, including account-specific availability.
    try {
      const path = join(home, ".codex", "models_cache.json");
      if (lstatSync(path).size < 2_000_000) {
        const data = JSON.parse(readFileSync(path, "utf8")) as { models?: { slug?: unknown; display_name?: unknown; visibility?: unknown }[] };
        choices = (Array.isArray(data.models) ? data.models : []).filter(one => one != null && one.visibility === "list" && typeof one.slug === "string" && validModelId(one.slug))
          .slice(0, 30).map(one => ({ value: one.slug as string, label: typeof one.display_name === "string" ? one.display_name.slice(0, 80) : one.slug as string }));
      }
    } catch { /* A missing catalog leaves the explicit model option available. */ }

  }
  if (configured && !choices.some(one => one.value === configured)) choices.unshift({ value: configured, label: `${configured} — current choice` });
  return choices;
}

export function detectPreparation(repo: string): { command: string; label: string; evidence: string } | null {
  const has = (file: string) => existsSync(join(repo, file));
  if (has("package.json")) {
    if (has("pnpm-lock.yaml")) return { command: "pnpm install --frozen-lockfile", label: "Install project dependencies with pnpm", evidence: "pnpm-lock.yaml" };
    if (has("yarn.lock")) return { command: has(".yarnrc.yml") ? "yarn install --immutable" : "yarn install --frozen-lockfile", label: "Install project dependencies with Yarn", evidence: "yarn.lock" };
    if (has("package-lock.json") || has("npm-shrinkwrap.json")) return { command: "npm ci", label: "Install project dependencies with npm", evidence: has("package-lock.json") ? "package-lock.json" : "npm-shrinkwrap.json" };
    if (has("bun.lock") || has("bun.lockb")) return { command: "bun install --frozen-lockfile", label: "Install project dependencies with Bun", evidence: "Bun lockfile" };
    return { command: "npm install", label: "Install project dependencies with npm", evidence: "package.json" };
  }
  if (has("uv.lock") && has("pyproject.toml")) return { command: "uv sync --frozen", label: "Prepare the Python environment with uv", evidence: "uv.lock" };
  if (has("Cargo.lock")) return { command: "cargo fetch --locked", label: "Download Rust dependencies", evidence: "Cargo.lock" };
  if (has("go.mod")) return { command: "go mod download", label: "Download Go dependencies", evidence: "go.mod" };
  return null;
}

/** Browser installation may write only this known file inside its project. */
export function previewProjectInstructions(repo: string) {
  try {
    if (!lstatSync(repo).isDirectory()) return { ok: false as const, message: "This project folder is unavailable. Reconnect it before adding instructions." };
  } catch { return { ok: false as const, message: "This project folder is unavailable. Reconnect it before adding instructions." }; }
  for (const relative of [".claude", ".claude/skills", SKILL_DIR, join(SKILL_DIR, SKILL_FILE)]) {
    const path = join(repo, relative);
    try { const entry = lstatSync(path); if (entry.isSymbolicLink() || (relative === join(SKILL_DIR, SKILL_FILE) ? !entry.isFile() || entry.size > 2_000_000 : !entry.isDirectory())) return { ok: false as const, message: "Project instructions use a linked folder or file. Choose a regular project folder before adding them." }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const plan = planInstall(repo, false);
  if (plan.skillAction === "refuse-foreign") return { ok: false as const, message: "This project already has custom Toolroll instructions. They will be kept. You can continue setup without replacing them." };
  const content = skillContent();
  const current = existsSync(plan.skillPath) ? readFileSync(plan.skillPath, "utf8") : null;
  const fingerprint = createHash("sha256").update(JSON.stringify({ repo, current, content })).digest("hex");
  // Installed means the CURRENT instructions are in place: a stale copy, or one only in the folder from before the
  // rename, still offers Review so applyInstall can bring it up to date (the first-run checklist counts either).
  return { ok: true as const, plan, content, fingerprint, installed: current === content };
}
export function addProjectInstructions(repo: string, fingerprint: string) {
  const preview = previewProjectInstructions(repo);
  if (!preview.ok) return preview;
  if (preview.fingerprint !== fingerprint) return { ok: false as const, message: "The project instructions changed. Review them again before saving." };
  return applyInstall(repo, false);
}
