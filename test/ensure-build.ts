import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** CLI integration tests are required even on a fresh checkout. Build once,
 * before workers import tests, only when published runtime inputs changed. */
export function buildIsStale(root: string): boolean {
  const runtimeOutput = join(root, "dist", "cli.js");
  if (!existsSync(runtimeOutput)) return true;
  const runtimeBuiltAt = statSync(runtimeOutput).mtimeMs;
  const buildInputs = [
    "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json",
    "tsconfig.browser.json", "scripts/browser-build.mjs", "scripts/postbuild.mjs",
    "THIRD_PARTY_NOTICES.md",
  ];
  if (buildInputs.some(input => !existsSync(join(root, input)) || statSync(join(root, input)).mtimeMs > runtimeBuiltAt)) return true;

  if (readdirSync(join(root, "src")).some(name => {
    if ((!name.endsWith(".ts") || name.endsWith(".test.ts")) && name !== "job-object-helper.ps1") return false;
    if (name.endsWith(".d.ts")) return statSync(join(root, "src", name)).mtimeMs > runtimeBuiltAt;
    const output = join(root, "dist", name.replace(/\.ts$/, ".js"));
    return !existsSync(output) || statSync(join(root, "src", name)).mtimeMs > statSync(output).mtimeMs;
  })) return true;

  const browserOutputs = ["workspace.js", "workspace.css", "THIRD_PARTY_NOTICES.txt"].map(name => join(root, "dist", "browser", name));
  if (browserOutputs.some(output => !existsSync(output))) return true;
  const browserBuiltAt = Math.min(...browserOutputs.map(output => statSync(output).mtimeMs));
  const newerBrowserInput = (directory: string): boolean => {
    if (!existsSync(directory) || statSync(directory).mtimeMs > browserBuiltAt) return true;
    return readdirSync(directory, { withFileTypes: true }).some(entry => {
      if (/\.test\.tsx?$/.test(entry.name)) return false;
      const path = join(directory, entry.name);
      // Directory mtimes also catch deleted imports; file-only scans miss them.
      return entry.isDirectory() ? newerBrowserInput(path) : statSync(path).mtimeMs > browserBuiltAt;
    });
  };
  return newerBrowserInput(join(root, "src", "browser"));
}

/** The release check starts the unit tests beside its own build and names a file it writes when that build ends
 * ("ok" or "failed"). Wait for it rather than build a second time into the same dist/. */
async function releaseBuild(marker: string): Promise<void> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    if (existsSync(marker)) {
      const outcome = readFileSync(marker, "utf8").trim();
      if (outcome === "ok") return;
      throw new Error(`The release check's build ${outcome === "" ? "ended without saying how" : outcome}.`);
    }
    if (Date.now() > deadline) throw new Error("The release check's build didn't finish in 15 minutes.");
    await new Promise(done => setTimeout(done, 200));
  }
}

export default async function ensureBuild(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const marker = process.env.TOOLROLL_RELEASE_BUILD;
  if (marker !== undefined && marker !== "") return releaseBuild(marker);
  if (buildIsStale(root)) execSync("npm run build", { cwd: root, stdio: "inherit" });
}
