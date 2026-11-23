#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Building ToolrollApp (release)..."
swift build -c release

BIN_PATH="$(swift build -c release --show-bin-path)/ToolrollApp"
if [[ ! -x "$BIN_PATH" ]]; then
  echo "error: built binary not found at $BIN_PATH" >&2
  exit 1
fi

APP_DIR="$SCRIPT_DIR/build/Toolroll.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cp "$BIN_PATH" "$MACOS_DIR/ToolrollApp"
chmod +x "$MACOS_DIR/ToolrollApp"

# The app icon (drawn by scripts/make-app-icon.swift; regenerate with scripts/make-app-icon.sh).
ICON_SRC="$(cd "$(dirname "$0")" && pwd)/Assets/AppIcon.icns"
if [[ -f "$ICON_SRC" ]]; then
  cp "$ICON_SRC" "$RESOURCES_DIR/AppIcon.icns"
fi

cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleDisplayName</key>
  <string>Toolroll</string>
  <key>CFBundleExecutable</key>
  <string>ToolrollApp</string>
  <key>CFBundleIdentifier</key>
  <string>com.toolroll.mac</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Toolroll</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>Toolroll accesses your local project repositories to discover routes, open Markdown artifacts, and run local Canvas previews.</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

# Extended attributes (Finder info, provenance) make codesign refuse with "detritus not allowed": strip them first.
xattr -cr "$APP_DIR" 2>/dev/null || true # guard: allow — a missing xattr tool only skips the cleanup
if command -v codesign >/dev/null 2>&1; then
  SIGN_ID="${TOOLROLL_SIGN_IDENTITY:-}"
  if [[ -z "$SIGN_ID" ]] && command -v security >/dev/null 2>&1; then
    IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null)" || IDENTITIES=""
    if echo "$IDENTITIES" | grep -q '"Toolroll Local Dev"'; then
      SIGN_ID="Toolroll Local Dev"
    elif echo "$IDENTITIES" | grep -q '"Apple Development:'; then
      SIGN_ID="$(echo "$IDENTITIES" | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -n 1)"
    elif echo "$IDENTITIES" | grep -q '"Developer ID Application:'; then
      SIGN_ID="$(echo "$IDENTITIES" | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -n 1)"
    fi
  fi

  if [[ -n "$SIGN_ID" ]]; then
    echo "==> Signing with stable identity: $SIGN_ID"
    codesign --force --deep --sign "$SIGN_ID" "$APP_DIR"
  else
    codesign --force --deep --sign - "$APP_DIR" >/dev/null || { echo "codesign failed once; retrying after clearing attributes" >&2; xattr -cr "$APP_DIR" 2>/dev/null || true; codesign --force --deep --sign - "$APP_DIR" >/dev/null; } # guard: allow — xattr cleanup is best effort before the retry
  fi
fi

echo "==> Packaged native macOS bundle: $APP_DIR"
echo "    Launch with: open \"$APP_DIR\""
