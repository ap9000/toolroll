import { test, expect } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyServerRuntime } from "../scripts/desktop-runtime.mjs";

const VERSION_READER = fileURLToPath(new URL("../dist/version.js", import.meta.url));

function writePackage(dir: string, manifest: object, files: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

/** A Resources folder shaped like the app's: dist/ with the real version reader, beside optional metadata and modules. */
function resourcesLayout({ parent = mkdtempSync(join(tmpdir(), "runtime-")), metadata = true, modules = true, declared = ["fixture-dep"] } = {}): string {
  const resources = join(parent, "Resources"), dist = join(resources, "dist");
  mkdirSync(dist, { recursive: true });
  copyFileSync(VERSION_READER, join(dist, "version.js"));
  writeFileSync(join(dist, "desktop-host.js"), `import "fixture-dep";\nconsole.log(JSON.stringify({ active: false }));\n`);
  if (metadata) writePackage(resources, { name: "toolroll", version: "1.2.3", type: "module", dependencies: Object.fromEntries(declared.map(name => [name, "1.0.0"])) });
  if (modules) writePackage(join(resources, "node_modules", "fixture-dep"), { name: "fixture-dep", version: "1.0.0", type: "module", exports: "./index.js" }, { "index.js": "export {};\n" });
  return resources;
}

test("a self-contained server runtime launches in isolation and reports its package version", () => {
  expect(() => verifyServerRuntime(resourcesLayout(), process.execPath, "1.2.3")).not.toThrow();
});

test("a dependency found only in a surrounding checkout's node_modules fails the packaging check", () => {
  const checkout = mkdtempSync(join(tmpdir(), "checkout-"));
  writePackage(join(checkout, "node_modules", "fixture-dep"), { name: "fixture-dep", version: "1.0.0", type: "module", exports: "./index.js" }, { "index.js": "export {};\n" });
  const resources = resourcesLayout({ parent: checkout, modules: false });
  // In place, the checkout masks the missing module; that is how the app passed while built inside a checkout.
  expect(spawnSync(process.execPath, [join(resources, "dist", "desktop-host.js"), "update-status"]).status).toBe(0);
  expect(() => verifyServerRuntime(resources, process.execPath, "1.2.3")).toThrow(/could not start[\s\S]*fixture-dep/);
});

test("a runtime without its package metadata reports 0.0.0 and fails the packaging check", () => {
  expect(() => verifyServerRuntime(resourcesLayout({ metadata: false }), process.execPath, "1.2.3")).toThrow(/reports version 0\.0\.0, not 1\.2\.3/);
});

test("a declared dependency missing from the bundle fails even when the entry point does not load it", () => {
  expect(() => verifyServerRuntime(resourcesLayout({ declared: ["fixture-dep", "lazy-dep"] }), process.execPath, "1.2.3")).toThrow(/missing dependencies: lazy-dep\./);
});
