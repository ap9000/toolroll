#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function renderHomebrewCask(input) {
  const version = String(input.version ?? "").trim().replace(/^v/, "");
  const sha256 = String(input.sha256 ?? "").trim().toLowerCase();
  const repo = String(input.repo ?? "ap9000/toolroll").trim();
  const asset = String(input.asset ?? `Toolroll-${version}-macos.dmg`).trim();

  if (!SEMVER_RE.test(version)) {
    throw new Error(`Invalid Toolroll version for Homebrew Cask: ${version || "(empty)"}`);
  }
  if (!SHA256_RE.test(sha256)) {
    throw new Error(`Invalid SHA-256 digest for Homebrew Cask: ${sha256 || "(empty)"}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repository slug: ${repo}`);
  }
  if (!/^[A-Za-z0-9._-]+\.dmg$/.test(asset)) {
    throw new Error(`Invalid DMG asset filename: ${asset}`);
  }

  const assetTemplate = asset.replaceAll(version, "#{version}");

  return [
    `cask "toolroll" do`,
    `  version "${version}"`,
    `  sha256 "${sha256}"`,
    ``,
    `  url "https://github.com/${repo}/releases/download/v#{version}/${assetTemplate}"`,
    `  name "Toolroll"`,
    `  desc "Native macOS control plane for coding agents"`,
    `  homepage "https://toolroll.dev"`,
    ``,
    `  depends_on macos: ">= :sonoma"`,
    `  depends_on formula: "ap9000/toolroll/toolroll"`,
    ``,
    `  app "Toolroll.app"`,
    ``,
    `  zap trash: [`,
    `    "~/Library/Logs/Toolroll",`,
    `    "~/Library/Preferences/com.toolroll.mac.plist",`,
    `    "~/Library/Saved Application State/com.toolroll.mac.savedState",`,
    `  ]`,
    `end`,
    ``,
  ].join("\n");
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version" || arg === "--sha256" || arg === "--repo" || arg === "--asset" || arg === "--out") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      opts[arg.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const content = renderHomebrewCask(opts);
  if (opts.out) {
    const outPath = resolve(opts.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content, "utf8");
  } else {
    process.stdout.write(content);
  }
}
