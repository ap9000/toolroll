import { describe, expect, it } from "vitest";
import { renderHomebrewCask } from "../mac/scripts/render-homebrew-cask.mjs";

describe("renderHomebrewCask", () => {
  it("renders a valid Homebrew Cask stanza pointing to the signed GitHub Release DMG", () => {
    const sha = "a".repeat(64);
    const cask = renderHomebrewCask({ version: "v0.9.116", sha256: sha });

    expect(cask).toContain('cask "toolroll" do');
    expect(cask).toContain('version "0.9.116"');
    expect(cask).toContain(`sha256 "${sha}"`);
    expect(cask).toContain('url "https://github.com/ap9000/toolroll/releases/download/v#{version}/Toolroll-#{version}-macos.dmg"');
    expect(cask).toContain('depends_on macos: ">= :sonoma"');
    expect(cask).toContain('depends_on formula: "ap9000/toolroll/toolroll"');
    expect(cask).toContain('app "Toolroll.app"');
    expect(cask).not.toContain(".config/nightorders");
  });

  it("refuses malformed versions or non-hex sha256 digests", () => {
    expect(() => renderHomebrewCask({ version: "not-a-version", sha256: "a".repeat(64) })).toThrow(/Invalid Toolroll version/);
    expect(() => renderHomebrewCask({ version: "0.9.116", sha256: "short" })).toThrow(/Invalid SHA-256/);
    expect(() => renderHomebrewCask({ version: "0.9.116", sha256: "a".repeat(64), asset: "../evil.dmg" })).toThrow(/Invalid DMG asset/);
  });
});
