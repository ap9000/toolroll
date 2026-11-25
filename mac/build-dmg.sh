#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

UNIVERSAL=0
TARGET_ARCH=""
REQUIRE_SIGNING=0
NOTARIZE=0
SKIP_APP_BUILD=0
APP_VERSION="${TOOLROLL_APP_VERSION:-}"
APP_PATH="$SCRIPT_DIR/build/Toolroll.app"
DMG_OUT=""

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
    --notarize)
      NOTARIZE=1
      REQUIRE_SIGNING=1
      shift
      ;;
    --skip-app-build)
      SKIP_APP_BUILD=1
      shift
      ;;
    --app)
      APP_PATH="${2:-}"
      SKIP_APP_BUILD=1
      shift 2
      ;;
    --version)
      APP_VERSION="${2:-}"
      shift 2
      ;;
    --output)
      DMG_OUT="${2:-}"
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

if [[ -z "$DMG_OUT" ]]; then
  DMG_OUT="$SCRIPT_DIR/build/Toolroll-${APP_VERSION}-macos.dmg"
fi

if [[ "$SKIP_APP_BUILD" -eq 0 ]]; then
  BUILD_ARGS=(--version "$APP_VERSION" --output "$APP_PATH")
  if [[ "$UNIVERSAL" -eq 1 ]]; then
    BUILD_ARGS+=(--universal)
  elif [[ -n "$TARGET_ARCH" ]]; then
    BUILD_ARGS+=(--arch "$TARGET_ARCH")
  fi
  if [[ "$REQUIRE_SIGNING" -eq 1 ]]; then
    BUILD_ARGS+=(--require-signing)
  fi
  bash "$SCRIPT_DIR/build-app.sh" "${BUILD_ARGS[@]}"
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "error: app bundle not found at $APP_PATH" >&2
  exit 1
fi

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/toolroll-dmg.XXXXXX")"
trap 'rm -rf "$STAGE_DIR"' EXIT

echo "==> Staging Toolroll.app for DMG..."
cp -R "$APP_PATH" "$STAGE_DIR/Toolroll.app"
ln -s /Applications "$STAGE_DIR/Applications"

mkdir -p "$(dirname "$DMG_OUT")"
rm -f "$DMG_OUT" "${DMG_OUT}.sha256"

echo "==> Creating compressed DMG at $DMG_OUT..."
hdiutil create \
  -volname "Toolroll ${APP_VERSION}" \
  -srcfolder "$STAGE_DIR" \
  -ov \
  -format UDZO \
  -imagekey zlib-level=9 \
  "$DMG_OUT"

SIGN_ID="${TOOLROLL_SIGN_IDENTITY:-}"
if [[ -z "$SIGN_ID" && "$REQUIRE_SIGNING" -eq 1 ]] && command -v security >/dev/null 2>&1; then
  IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null)" || IDENTITIES=""
  SIGN_ID="$(echo "$IDENTITIES" | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -n 1)"
fi

if [[ -n "$SIGN_ID" && "$SIGN_ID" != "-" ]]; then
  echo "==> Signing DMG with $SIGN_ID..."
  codesign --force --timestamp --sign "$SIGN_ID" "$DMG_OUT"
  codesign --verify --verbose=2 "$DMG_OUT"
elif [[ "$REQUIRE_SIGNING" -eq 1 ]]; then
  echo "error: --require-signing needs a Developer ID Application identity for DMG signing." >&2
  exit 1
fi

if [[ "$NOTARIZE" -eq 1 ]]; then
  echo "==> Submitting DMG for Apple notarization..."
  if [[ -n "${TOOLROLL_NOTARY_PROFILE:-}" ]]; then
    xcrun notarytool submit "$DMG_OUT" --keychain-profile "$TOOLROLL_NOTARY_PROFILE" --wait
  elif [[ -n "${APPLE_NOTARY_KEY_PATH:-}" && -n "${APPLE_NOTARY_KEY_ID:-}" && -n "${APPLE_NOTARY_ISSUER_ID:-}" ]]; then
    xcrun notarytool submit "$DMG_OUT" \
      --key "$APPLE_NOTARY_KEY_PATH" \
      --key-id "$APPLE_NOTARY_KEY_ID" \
      --issuer "$APPLE_NOTARY_ISSUER_ID" \
      --wait
  else
    echo "error: --notarize requires TOOLROLL_NOTARY_PROFILE or APPLE_NOTARY_KEY_PATH + APPLE_NOTARY_KEY_ID + APPLE_NOTARY_ISSUER_ID." >&2
    exit 1
  fi

  echo "==> Stapling notarization ticket..."
  xcrun stapler staple "$DMG_OUT"
  xcrun stapler validate "$DMG_OUT"
  spctl --assess -vv --type open --context context:primary-signature "$DMG_OUT"
fi

SHA256="$(shasum -a 256 "$DMG_OUT" | awk '{print $1}')"
BASENAME="$(basename "$DMG_OUT")"
printf "%s  %s\n" "$SHA256" "$BASENAME" > "${DMG_OUT}.sha256"

echo "==> Packaged DMG: $DMG_OUT"
echo "    SHA-256: $SHA256"
echo "    Checksum file: ${DMG_OUT}.sha256"
