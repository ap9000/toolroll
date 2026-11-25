# macOS `.dmg` Release, Notarization & Homebrew Cask

Toolroll ships a native SwiftUI macOS app (`Toolroll.app`) distributed as a Universal (`arm64` + `x86_64`) signed, notarized `.dmg` on GitHub Releases and via the Homebrew Cask `ap9000/toolroll/toolroll`.

## Install (end users)

```sh
brew install --cask ap9000/toolroll/toolroll
```

Installing the cask also installs the `ap9000/toolroll/toolroll` formula, so launching **Toolroll.app** automatically starts and connects to your local Toolroll engine with zero manual terminal commands.

You can also download `Toolroll-<version>-macos.dmg` directly from [GitHub Releases](https://github.com/ap9000/toolroll/releases/latest) and drag **Toolroll.app** into `/Applications`.

## Local packaging

```sh
# Fast native-arch app bundle for local development
cd mac && ./build-app.sh

# Compressed read-only .dmg (unsigned/local-dev signed unless TOOLROLL_SIGN_IDENTITY is set)
cd mac && ./build-dmg.sh

# Signed + notarized Universal release .dmg (refuses ad-hoc fallback)
TOOLROLL_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
TOOLROLL_NOTARY_PROFILE="toolroll-notary" \
  ./build-dmg.sh --universal --notarize
```

To generate the matching Homebrew Cask file:

```sh
node mac/scripts/render-homebrew-cask.mjs \
  --version 0.9.116 \
  --sha256 <64-hex-sha256> \
  --out Casks/toolroll.rb
```

## Automated GitHub Release workflow

`.github/workflows/mac-release.yml` runs automatically whenever a GitHub Release is published (right after `publish.yml` creates the release for a `v*` tag), and can also be triggered manually via **Actions → macOS Release → Run workflow**.

Configure these repository secrets once in GitHub (`Settings → Secrets and variables → Actions`):

| Secret | Required for | How to create |
|---|---|---|
| `APPLE_DEVELOPER_ID_P12` | Signing | Base64-encoded `.p12` export of your `Developer ID Application` certificate (`base64 -i dev-id.p12 \| pbcopy`) |
| `APPLE_DEVELOPER_ID_PASSWORD` | Signing | Password protecting the `.p12` export |
| `APPLE_SIGN_IDENTITY` | Signing | Full certificate common name, e.g. `Developer ID Application: Alex Pelletier (TEAMID)` |
| `APPLE_NOTARY_KEY_BASE64` | Notarization | Base64-encoded App Store Connect API `.p8` key (`AuthKey_<KEYID>.p8`) |
| `APPLE_NOTARY_KEY_ID` | Notarization | 10-character Key ID from App Store Connect |
| `APPLE_NOTARY_ISSUER_ID` | Notarization | Issuer UUID from App Store Connect |
| `HOMEBREW_TAP_TOKEN` | Homebrew Cask PR | Optional fine-grained PAT with `contents: write` + `pull_requests: write` on `ap9000/homebrew-toolroll` |

When triggered by `release: published`, the workflow refuses to publish an unsigned `.dmg` if the signing or notarization secrets are missing. Manual `workflow_dispatch` runs default to dry-run (`publish_release: false`, `allow_unsigned: true`) so you can verify packaging and download the artifact before configuring certificates.
