#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync, existsSync, lstatSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { desktopBuildOptions, resolveReleaseIdentity, signingFacts, assertCompatibleUpgrade } from "./desktop-signing.mjs";
import { reserveDesktopArtifact } from "./desktop-artifact.mjs";
import { stageServerRuntime, verifyServerRuntime } from "./desktop-runtime.mjs";
import { randomUUID } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") throw new Error("The first desktop shell targets macOS. The web console remains cross-platform.");
const options = desktopBuildOptions(process.argv.slice(2), process.env, homedir(), join(root, "output", "desktop"));
const { destination } = options;
const signingIdentity = options.development ? "-" : resolveReleaseIdentity(options.identity,
  execFileSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }));
const signature = app => {
  // codesign displays metadata on stderr, including for a successful command.
  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" });
  if (result.status !== 0) throw Error("Could not inspect the existing app signature.");
  return signingFacts(result.stderr);
};
// The installed app is only a signing-continuity reference, never an output.
const previousApp = options.upgradeFrom;
const comparePrevious = previousApp && (options.explicitUpgradeFrom || existsSync(previousApp));
if (comparePrevious) {
  if (!existsSync(previousApp) || lstatSync(previousApp).isSymbolicLink() || !lstatSync(previousApp).isDirectory() || !existsSync(join(previousApp, "Contents", "Resources", "standing-orders-bundle"))) throw Error("The upgrade reference must be an existing Toolroll app, not a link.");
  if (signature(previousApp).bundleId !== options.bundleId) throw Error("The upgrade reference has a different app identity.");
}
// A login service must not depend on a removable nvm version or Homebrew
// symlink. Bundle the actual runtime and its redistribution notices. Refuse
// a dynamically linked package-manager build we cannot make self-contained.
const sourceNode = realpathSync(process.execPath);
const libraries = execFileSync("/usr/bin/otool", ["-L", sourceNode], { encoding: "utf8" }).split("\n").slice(1)
  .map(line => line.trim().split(" (", 1)[0]).filter(Boolean);
if (libraries.some(path => !path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/"))) {
  throw new Error("The desktop needs a standalone Node distribution. Build with an official Node binary; this runtime depends on external package-manager libraries.");
}
const nodeLicense = join(dirname(sourceNode), "..", "LICENSE");
if (!existsSync(nodeLicense)) throw new Error("The Node distribution's LICENSE is missing. Build with an official Node distribution so its redistribution notices can be included.");
execFileSync("/usr/bin/codesign", ["--verify", "--strict", sourceNode]);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const output = reserveDesktopArtifact(destination);
let staging;
try {
staging = mkdtempSync(join(dirname(destination), ".standing-orders-build-"));
const app = join(staging, "Standing Orders.app");
const contents = join(app, "Contents"), resources = join(contents, "Resources"), macos = join(contents, "MacOS");
mkdirSync(macos, { recursive: true }); mkdirSync(resources, { recursive: true });
writeFileSync(join(resources, "standing-orders-bundle"), "local desktop build\n");
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
const { SCHEMA_VERSION } = await import(join(root, "dist", "store.js"));
const { bundleHash } = await import(join(root, "dist", "desktop-bundle.js"));
stageServerRuntime(root, resources);
mkdirSync(join(resources, "runtime"));
const bundledNode = join(resources, "runtime", "node");
cpSync(sourceNode, bundledNode);
cpSync(nodeLicense, join(resources, "runtime", "LICENSE"));
if (execFileSync(bundledNode, ["--version"], { encoding: "utf8" }).trim() !== process.version) throw new Error("The copied Node runtime failed its version check.");
// Relative to Resources, so moving the finished app does not strand its runtime.
// The original bin remains only a provider search path, never the service runtime.
writeFileSync(join(resources, "runtime.json"), JSON.stringify({ node: "runtime/node", providerBin: dirname(sourceNode), bundleId: options.bundleId, development: options.development, buildId: randomUUID(), builtAt: new Date().toISOString(), version, schemaVersion: SCHEMA_VERSION, updateProtocol: 1, recoveryProtocol: 1 }));
writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleName</key><string>${options.name}</string><key>CFBundleDisplayName</key><string>${options.name}</string>
<key>CFBundleIdentifier</key><string>${options.bundleId}</string><key>CFBundleExecutable</key><string>StandingOrders</string>
<key>CFBundleVersion</key><string>${version}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSDocumentsFolderUsageDescription</key><string>Work on the Git projects you select, including while the app window is closed.</string>
<key>NSDesktopFolderUsageDescription</key><string>Work on Git projects you select on your Desktop.</string>
<key>NSDownloadsFolderUsageDescription</key><string>Work on Git projects you select in Downloads.</string>
</dict></plist>`);
execFileSync("/usr/bin/swiftc", ["-O", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`, "-parse-as-library", "-swift-version", "5", "-framework", "AppKit", "-framework", "WebKit", "-framework", "Security", join(root, "desktop", "StandingOrders.swift"), "-o", join(macos, "StandingOrders")], { stdio: "inherit" });
const swapHelper = join(resources, "runtime", "bundle-swap");
execFileSync("/usr/bin/swiftc", ["-O", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`, join(root, "desktop", "SwapBundles.swift"), "-o", swapHelper], { stdio: "inherit" });
execFileSync("/usr/bin/xattr", ["-cr", app]);
// Preserve Node's original Developer ID, entitlements and hardened runtime.
// Re-signing it ad hoc changes its OS identity and can strand unattended
// access behind a new privacy approval. The outer app seals the signed copy.
execFileSync("/usr/bin/codesign", ["--verify", "--strict", bundledNode], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--force", "--sign", signingIdentity, ...(options.development ? [] : ["--options", "runtime", "--timestamp"]), swapHelper], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--force", "--sign", signingIdentity, ...(options.development ? [] : ["--options", "runtime", "--timestamp"]), app], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
const nextSignature = signature(app);
if (!options.development && (!nextSignature.team || nextSignature.adhoc)) throw Error("Release signature verification failed.");
// Before notarization: the sealed server must launch without this checkout.
verifyServerRuntime(resources, bundledNode, version);
// File → Install app update refuses links; refuse them here instead.
bundleHash(app);
if (comparePrevious) {
  const oldSignature = signature(previousApp);
  assertCompatibleUpgrade(oldSignature, nextSignature, options.development);
  if (oldSignature.team) {
    const result = spawnSync("/usr/bin/codesign", ["-dr", "-", previousApp], { encoding: "utf8" });
    const requirement = /(?:# )?designated => (.+)/.exec(result.stdout + result.stderr)?.[1];
    if (result.status !== 0 || !requirement) throw Error("Could not verify continuity with the installed signing requirement.");
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", "-R", requirement, app], { stdio: "inherit" });
  } else if (!options.development) console.log("First signed release: macOS may ask once to replace the old development build's access grant.");
}
if (options.notaryProfile) {
  const archive = join(staging, "StandingOrders.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, archive]);
  console.log("Submitting the signed app for notarization…");
  const result = JSON.parse(execFileSync("/usr/bin/xcrun", ["notarytool", "submit", archive, "--keychain-profile", options.notaryProfile, "--wait", "--timeout", "10m", "--output-format", "json"], { encoding: "utf8", timeout: 660_000 }));
  if (result.status !== "Accepted") throw Error(`Notarization was not accepted (submission ${result.id ?? "unknown"}). The installed app is unchanged.`);
  execFileSync("/usr/bin/xcrun", ["stapler", "staple", app], { stdio: "inherit" });
  execFileSync("/usr/bin/xcrun", ["stapler", "validate", app], { stdio: "inherit" });
}
output.publish(app);
console.log(`Built ${destination}\nIncludes Node ${process.version}; the background controller does not depend on the build machine's Node installation or checkout.`);
console.log("The installed app, background service and task database were not changed. Use File → Install app update for a compatible controlled update; legacy installations or schema changes need the documented migration procedure.");
console.log(options.development ? "Development preview only: separate app, database and permissions; not an unattended-release certificate." : options.notaryProfile ? "Developer ID signed and notarized. Project permission persistence still requires the update/restart acceptance check." : "Developer ID signed, not notarized. Add --notary-profile before distributing this app.");
} finally {
  try { if (staging) rmSync(staging, { recursive: true, force: true }); }
  finally { output.release(); }
}
