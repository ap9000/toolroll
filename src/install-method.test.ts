/** installMethod: the kind and update command for each way Toolroll is installed, from the bin's real path. */
import { describe, expect, test } from "vitest";
import { installMethod } from "./install-method.js";

/** A bin that is a symlink to `real`, on a disk where only `present` exists. */
const probe = (real: string, present: readonly string[] = []) => ({ realpath: () => real, exists: (path: string) => present.includes(path.replace(/\\/g, "/")) });

describe("c2: installMethod", () => {
  test.each([
    ["npm", "/usr/local/bin/toolroll", "/usr/local/lib/node_modules/toolroll/dist/bin.js", "npm install -g toolroll@latest"],
    ["npm (nvm)", "/Users/a/.nvm/versions/node/v22.13.0/bin/toolroll", "/Users/a/.nvm/versions/node/v22.13.0/lib/node_modules/toolroll/dist/bin.js", "npm install -g toolroll@latest"],
    ["npm (Windows)", "C:\\Users\\a\\AppData\\Roaming\\npm\\toolroll", "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\toolroll\\dist\\bin.js", "npm install -g toolroll@latest"],
    ["pnpm", "/Users/a/Library/pnpm/toolroll", "/Users/a/Library/pnpm/global/5/.pnpm/toolroll@0.6.0/node_modules/toolroll/dist/bin.js", "pnpm add -g toolroll@latest"],
    ["pnpm (Linux)", "/home/a/.local/share/pnpm/toolroll", "/home/a/.local/share/pnpm/global/5/node_modules/toolroll/dist/bin.js", "pnpm add -g toolroll@latest"],
    ["bun", "/Users/a/.bun/bin/toolroll", "/Users/a/.bun/install/global/node_modules/toolroll/dist/bin.js", "bun add -g toolroll@latest"],
    ["yarn", "/usr/local/bin/toolroll", "/Users/a/.config/yarn/global/node_modules/toolroll/dist/bin.js", "yarn global add toolroll@latest"],
    ["yarn (Windows)", "C:\\Users\\a\\AppData\\Local\\Yarn\\bin\\toolroll", "C:\\Users\\a\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\toolroll\\dist\\bin.js", "yarn global add toolroll@latest"],
    ["homebrew", "/opt/homebrew/bin/toolroll", "/opt/homebrew/Cellar/toolroll/0.6.0/libexec/lib/node_modules/toolroll/dist/bin.js", "brew upgrade ap9000/toolroll/toolroll"],
    ["homebrew (Linux)", "/home/linuxbrew/.linuxbrew/bin/toolroll", "/home/linuxbrew/.linuxbrew/Cellar/toolroll/0.6.0/libexec/lib/node_modules/toolroll/dist/bin.js", "brew upgrade ap9000/toolroll/toolroll"],
    ["npx", "/Users/a/.npm/_npx/4f9a2c/node_modules/.bin/toolroll", "/Users/a/.npm/_npx/4f9a2c/node_modules/toolroll/dist/bin.js", "npx toolroll@latest"],
  ])("%s", (label, bin, real, command) => {
    const kind = label.split(" ")[0];
    expect(installMethod(bin, probe(real))).toEqual({ kind, updateCommand: command });
  });

  test("a plane a release deployed from a checkout (staged-upgrades/browser-*) updates itself from npm, never as source", () => {
    const real = "/Users/a/.config/toolroll/staged-upgrades/browser-6cfc944-8cb322/runtime/node_modules/toolroll/dist/bin.js";
    expect(installMethod("/Users/a/.nvm/versions/node/v22.22.0/bin/toolroll", probe(real)))
      .toEqual({ kind: "managed", updateCommand: "toolroll update" });
  });

  test("a runtime toolroll update installed (staged-upgrades/release-* or rollback-*) updates itself", () => {
    for (const dir of ["release-0.8.0-1a2b3c", "rollback-0.7.0-4d5e6f"]) {
      const real = `/Users/a/.config/toolroll/staged-upgrades/${dir}/runtime/node_modules/toolroll/dist/bin.js`;
      expect(installMethod("/Users/a/.local/bin/toolroll", probe(real))).toEqual({ kind: "managed", updateCommand: "toolroll update" });
    }
  });

  test("the Toolroll app is its own install kind, never offered npm", () => {
    const real = "/Applications/Toolroll.app/Contents/Resources/dist/bin.js";
    expect(installMethod(real, probe(real))).toEqual({ kind: "desktop", updateCommand: "Update from the Toolroll app" });
    // Even where the app carries a node_modules of its own.
    expect(installMethod("/usr/local/bin/toolroll", probe("/Applications/Toolroll.app/Contents/Resources/runtime/node_modules/toolroll/dist/bin.js")).kind).toBe("desktop");
  });

  test("a git checkout is a source install", () => {
    const real = "/Users/a/code/toolroll/dist/bin.js";
    expect(installMethod("/Users/a/code/toolroll/dist/bin.js", probe(real, ["/Users/a/code/toolroll/package.json", "/Users/a/code/toolroll/.git"])))
      .toEqual({ kind: "source", updateCommand: "git pull && npm install && npm run build" });
    // Running the TypeScript directly (npm run dev) is a checkout too.
    expect(installMethod("/Users/a/code/toolroll/src/bin.ts", probe("/Users/a/code/toolroll/src/bin.ts", ["/Users/a/code/toolroll/package.json", "/Users/a/code/toolroll/.git"])).kind).toBe("source");
  });

  test("an unknown shape or an unresolvable bin reads as npm, the common case", () => {
    expect(installMethod("/opt/tools/toolroll/dist/bin.js", probe("/opt/tools/toolroll/dist/bin.js")).kind).toBe("npm");
    expect(installMethod("/Users/a/.npm/_npx/1/node_modules/.bin/toolroll", { realpath: () => { throw new Error("gone"); }, exists: () => false }).kind).toBe("npx");
    expect(installMethod(undefined).kind).toBe("npm");
  });
});
