#!/usr/bin/env bash
# Regenerates mac/Assets/AppIcon.icns from scripts/make-app-icon.swift (every size macOS asks for).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/AppIcon.iconset" "$here/Assets"
swift "$here/scripts/make-app-icon.swift" "$work/AppIcon-1024.png" >/dev/null
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$work/AppIcon-1024.png" --out "$work/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z "$((s * 2))" "$((s * 2))" "$work/AppIcon-1024.png" --out "$work/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$work/AppIcon.iconset" -o "$here/Assets/AppIcon.icns"
echo "==> Wrote $here/Assets/AppIcon.icns"
