#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

UNIVERSAL=0
TARGET_ARCH=""
REQUIRE_SIGNING=0
APP_VERSION="${TOOLROLL_APP_VERSION:-}"
BUILD_NUMBER="${TOOLROLL_BUILD_NUMBER:-}"
APP_OUT="$SCRIPT_DIR/build/Toolroll.app"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --universal)
      UNIVERSAL=1
      shift
      ;;
    --arch)
      TARGET_ARCH="${2:-}"
      shift 2
      ;;
    --require-signing|--release)
      REQUIRE_SIGNING=1
      shift
      ;;
    --version)
      APP_VERSION="${2:-}"
      shift 2
      ;;
    --build-number)
      BUILD_NUMBER="${2:-}"
      shift 2
      ;;
    --output)
      APP_OUT="${2:-}"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$APP_VERSION" && -f "$REPO_ROOT/package.json" ]] && command -v node >/dev/null 2>&1; then
  APP_VERSION="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo "")"
fi
if [[ -z "$APP_VERSION" ]]; then
  APP_VERSION="1.0.0"
fi
if [[ -z "$BUILD_NUMBER" ]]; then
  BUILD_NUMBER="$APP_VERSION"
fi

if command -v node >/dev/null 2>&1 && [[ -f "$REPO_ROOT/scripts/lint-comments.mjs" ]]; then
  echo "==> Checking comment lint rule..."
  (cd "$REPO_ROOT" && node scripts/lint-comments.mjs mac/Sources mac/Tests)
fi

echo "==> Checking the Canvas capture script built into the app..."
"$SCRIPT_DIR/scripts/embed-canvas-capture.sh" --check

SWIFT_BUILD_ARGS=(-c release)
if [[ "$UNIVERSAL" -eq 1 ]]; then
  echo "==> Building ToolrollApp (release, universal arm64 + x86_64)..."
  SWIFT_BUILD_ARGS+=(--arch arm64 --arch x86_64)
elif [[ -n "$TARGET_ARCH" ]]; then
  echo "==> Building ToolrollApp (release, $TARGET_ARCH)..."
  SWIFT_BUILD_ARGS+=(--arch "$TARGET_ARCH")
else
  echo "==> Building ToolrollApp (release)..."
fi

swift build "${SWIFT_BUILD_ARGS[@]}"

BIN_DIR="$(swift build "${SWIFT_BUILD_ARGS[@]}" --show-bin-path)"
BIN_PATH="$BIN_DIR/ToolrollApp"
if [[ ! -x "$BIN_PATH" ]]; then
  echo "error: built binary not found at $BIN_PATH" >&2
  exit 1
fi

APP_DIR="$APP_OUT"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cp "$BIN_PATH" "$MACOS_DIR/ToolrollApp"
chmod +x "$MACOS_DIR/ToolrollApp"

ICON_SRC="$SCRIPT_DIR/Assets/AppIcon.icns"
if [[ -f "$ICON_SRC" ]]; then
  cp "$ICON_SRC" "$RESOURCES_DIR/AppIcon.icns"
fi

cat > "$CONTENTS_DIR/Info.plist" <<PLIST
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
  <string>${APP_VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${BUILD_NUMBER}</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.developer-tools</string>
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
find "$APP_DIR" -exec xattr -d com.apple.FinderInfo {} \; 2>/dev/null || true # guard: allow — FileProvider FinderInfo cleanup before codesign
xattr -cr "$APP_DIR" 2>/dev/null || true # guard: allow — a missing xattr tool only skips the cleanup

if command -v codesign >/dev/null 2>&1; then
  SIGN_ID="${TOOLROLL_SIGN_IDENTITY:-}"
  if [[ -z "$SIGN_ID" ]] && command -v security >/dev/null 2>&1; then
    IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null)" || IDENTITIES=""
    if [[ "$REQUIRE_SIGNING" -eq 1 ]]; then
      if echo "$IDENTITIES" | grep -q '"Developer ID Application:'; then
        SIGN_ID="$(echo "$IDENTITIES" | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -n 1)"
      fi
    else
      if echo "$IDENTITIES" | grep -q '"Toolroll Local Dev"'; then
        SIGN_ID="Toolroll Local Dev"
      elif echo "$IDENTITIES" | grep -q '"Apple Development:'; then
        SIGN_ID="$(echo "$IDENTITIES" | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -n 1)"
      elif echo "$IDENTITIES" | grep -q '"Developer ID Application:'; then
        SIGN_ID="$(echo "$IDENTITIES" | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -n 1)"
      fi
    fi
  fi

  if [[ "$REQUIRE_SIGNING" -eq 1 ]]; then
    if [[ -z "$SIGN_ID" || "$SIGN_ID" == "-" ]]; then
      echo "error: --require-signing needs a Developer ID Application identity (set TOOLROLL_SIGN_IDENTITY); refusing ad-hoc fallback." >&2
      exit 1
    fi
    ENTITLEMENTS="$SCRIPT_DIR/entitlements.plist"
    echo "==> Signing release bundle with hardened runtime: $SIGN_ID"
    codesign --force --deep --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$SIGN_ID" "$APP_DIR"
    codesign --verify --deep --strict --verbose=2 "$APP_DIR"
  elif [[ -n "$SIGN_ID" && "$SIGN_ID" != "-" ]]; then
    if [[ "$SIGN_ID" == Developer\ ID\ Application:* ]]; then
      echo "==> Signing with Developer ID (hardened runtime): $SIGN_ID"
      codesign --force --deep --options runtime --timestamp --entitlements "$SCRIPT_DIR/entitlements.plist" --sign "$SIGN_ID" "$APP_DIR"
    else
      echo "==> Signing with stable identity: $SIGN_ID"
      codesign --force --deep --sign "$SIGN_ID" "$APP_DIR"
    fi
    codesign --verify --deep --strict "$APP_DIR"
  else
    codesign --force --deep --sign - "$APP_DIR" >/dev/null || { echo "codesign failed once; retrying after clearing attributes" >&2; xattr -cr "$APP_DIR" 2>/dev/null || true; codesign --force --deep --sign - "$APP_DIR" >/dev/null; } # guard: allow — xattr cleanup is best effort before the retry
  fi
elif [[ "$REQUIRE_SIGNING" -eq 1 ]]; then
  echo "error: codesign is required when --require-signing is set." >&2
  exit 1
fi

echo "==> Packaged native macOS bundle: $APP_DIR (v${APP_VERSION})"
echo "    Launch with: open \"$APP_DIR\""
